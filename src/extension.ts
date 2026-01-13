
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
  findNodeAtLocation,
  modify,
  parse,
  parseTree,
  ParseError
} from "jsonc-parser";
import { VBConfigLoader } from "./config/loader";
import { hexToVec32, l2Magnitude, setMagnitude, vec32ToHex } from "./mixer/math";
import { MixerSessionStore } from "./mixer/session";
import {
  ALLOWED_BASE_MODEL,
  ALLOWED_F0_MODEL,
  ALLOWED_LANGUAGES,
  ALLOWED_SING_MODEL,
  ALLOWED_TIMING_MODEL,
  PHONESET_BY_LANGUAGE,
  getNofsDiagnostics,
  normalizeNofsConfig,
  validateNofsData
} from "./nofs/validate";
import {
  ExtensionToMixerMessage,
  ExtensionToModelsMessage,
  GroupingMode,
  MixerChannel,
  MixerState,
  MixerTab,
  MixerToExtensionMessage,
  ModelsToExtensionMessage,
  VBConfig
} from "./shared/protocol";
import { renderWebviewHtml } from "./webviewHtml";

const GROUPING_MODE_KEY = "vectorCalculator.models.groupingMode";
const MODEL_DATA_SETTING = "modelDataPath";
const CHANNELS_SCHEME = "vector-calculator-channels";
const READONLY_SCHEME = "vector-calculator-view";

const HEX_256_RE = /^[0-9a-fA-F]{256}$/;

interface StyleMeta {
  vbName?: string;
  version?: string;
  vendor?: string;
  styleName?: string;
}

interface ChannelDraft {
  name: string;
  data: string;
}

interface ModelDataDirs {
  root: string;
  additional: string;
  random: string;
}

export function activate(context: vscode.ExtensionContext): void {
  const loader = new VBConfigLoader();
  const sessionStore = new MixerSessionStore(context.globalState);
  const nofsDiagnostics = vscode.languages.createDiagnosticCollection("vectorCalculatorNofs");

  const mixerProvider = new MixerViewProvider(context);
  const modelsProvider = new ModelsViewProvider(context);
  const mixerController = new MixerController(sessionStore, mixerProvider);

  const channelProvider = new ChannelDocumentProvider(sessionStore);
  const readonlyProvider = new ReadonlyDocumentProvider();

  const openChannelDocs = new Map<string, vscode.TextDocument>();
  const channelEditTimers = new Map<string, NodeJS.Timeout>();
  const nofsLanguageByUri = new Map<string, string>();
  const nofsAutofixTimers = new Map<string, NodeJS.Timeout>();
  const nofsAutofixInProgress = new Set<string>();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("vectorCalculator.mixerView", mixerProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.window.registerWebviewViewProvider("vectorCalculator.modelsView", modelsProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.workspace.registerTextDocumentContentProvider(CHANNELS_SCHEME, channelProvider),
    vscode.workspace.registerTextDocumentContentProvider(READONLY_SCHEME, readonlyProvider)
  );

  let modelDataPath = resolveModelDataPath(context);
  let watcher: vscode.FileSystemWatcher | undefined;
  let reloadTimer: NodeJS.Timeout | undefined;

  const scheduleReload = () => {
    if (reloadTimer) {
      clearTimeout(reloadTimer);
    }
    reloadTimer = setTimeout(() => {
      reloadConfigs(loader, modelsProvider, modelDataPath).catch((error) => {
        vscode.window.showErrorMessage(
          `Failed to load model configs: ${(error as Error).message}`
        );
      });
    }, 200);
  };

  const updateModelDataPath = async () => {
    modelDataPath = resolveModelDataPath(context);
    await ensureModelDataDirs(modelDataPath);
    watcher?.dispose();
    watcher = createModelDataWatcher(modelDataPath, scheduleReload);
    context.subscriptions.push(watcher);
    await reloadConfigs(loader, modelsProvider, modelDataPath);
  };

  void updateModelDataPath().catch((error) => {
    vscode.window.showErrorMessage(`Failed to load model data: ${(error as Error).message}`);
  });

  const updateEditorStatus = () => {
    const status = getActiveNofsStatus(nofsDiagnostics);
    modelsProvider.post({ type: "models/status", canSaveActive: status.canSaveActive });
    mixerProvider.post({ type: "mixer/editor-state", canExport: status.canSaveActive });
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`vectorCalculator.${MODEL_DATA_SETTING}`)) {
        void updateModelDataPath();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("vectorCalculator.openMixer", async () => {
      await revealView("vectorCalculator.mixerView", mixerProvider);
    }),
    vscode.commands.registerCommand("vectorCalculator.openModels", async () => {
      await revealView("vectorCalculator.modelsView", modelsProvider);
    }),
    vscode.commands.registerCommand("vectorCalculator.reloadConfigs", async () => {
      await reloadConfigs(loader, modelsProvider, modelDataPath);
    }),
    vscode.commands.registerCommand("vectorCalculator.addStyleHexFromCursor", async () => {
      await addStyleHexFromCursor(mixerController, mixerProvider);
    }),
    vscode.commands.registerCommand(
      "vectorCalculator.setStyleHexMagnitudeFromCursor",
      async () => {
        await setMagnitudeAtCursor(context);
      }
    ),
    vscode.commands.registerCommand("vectorCalculator.validateNofs", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !isNofsDocument(editor.document)) {
        vscode.window.showInformationMessage("Open a .nofs.json file to validate.");
        return;
      }
      const diagnostics = validateDocument(editor.document, nofsDiagnostics) ?? [];
      if (diagnostics.length === 0) {
        vscode.window.showInformationMessage("No issues found.");
      } else {
        const errors = diagnostics.filter(
          (diag) => diag.severity === vscode.DiagnosticSeverity.Error
        );
        vscode.window.showWarningMessage(
          `Found ${diagnostics.length} issue(s) (${errors.length} error(s)).`
        );
      }
    }),
    vscode.commands.registerCommand("vectorCalculator.openModelDataFolder", async () => {
      await openModelDataPath(modelDataPath);
    }),
    vscode.commands.registerCommand("vectorCalculator.openKeyboardShortcuts", async () => {
      await vscode.commands.executeCommand("workbench.action.openGlobalKeybindings");
    })
  );
  mixerProvider.onMessage(async (message) => {
    switch (message.type) {
      case "mixer/ready": {
        mixerProvider.post({ type: "mixer/init", state: sessionStore.get() });
        const status = getActiveNofsStatus(nofsDiagnostics);
        mixerProvider.post({ type: "mixer/editor-state", canExport: status.canSaveActive });
        break;
      }
      case "mixer/state":
        await sessionStore.set(message.state);
        break;
      case "mixer/add-request": {
        const result = await pickStyle(loader);
        if (!result) {
          return;
        }
        await mixerController.addChannel(result.label, result.hex, result.source);
        refreshOpenChannelDocs(openChannelDocs, channelProvider);
        await revealView("vectorCalculator.mixerView", mixerProvider);
        break;
      }
      case "mixer/open-channel-editor": {
        await openChannelEditor(sessionStore.get(), message.tabId, channelProvider, openChannelDocs);
        break;
      }
      case "mixer/export-style": {
        await exportStyleToActiveDocument(message.name, message.hex, nofsDiagnostics);
        break;
      }
      case "mixer/copy-style": {
        const styleName = message.name.trim() || "Mixed";
        const payload = JSON.stringify(
          { name: styleName, data: message.hex.toUpperCase() },
          null,
          2
        );
        await vscode.env.clipboard.writeText(payload);
        vscode.window.showInformationMessage("Copied style JSON.");
        break;
      }
    }
  });

  modelsProvider.onMessage(async (message) => {
    switch (message.type) {
      case "models/ready": {
        const groupingMode = getGroupingMode(context.globalState);
        const status = getActiveNofsStatus(nofsDiagnostics);
        modelsProvider.post({
          type: "models/init",
          configs: loader.getEntries(),
          groupingMode,
          canSaveActive: status.canSaveActive
        });
        break;
      }
      case "models/grouping":
        await context.globalState.update(GROUPING_MODE_KEY, message.groupingMode);
        break;
      case "models/request-reload":
        await reloadConfigs(loader, modelsProvider, modelDataPath);
        break;
      case "models/open-model-path":
        await openModelDataPath(modelDataPath);
        break;
      case "models/save-active-to-additional":
        await saveActiveNofsToAdditional(modelDataPath, nofsDiagnostics);
        await reloadConfigs(loader, modelsProvider, modelDataPath);
        break;
      case "models/generate-random":
        await generateRandomNofs(modelDataPath);
        await reloadConfigs(loader, modelsProvider, modelDataPath);
        break;
      case "models/item-edit":
        await editModelEntry(loader, message.id);
        break;
      case "models/item-view":
        await viewModelEntry(loader, message.id, readonlyProvider);
        break;
      case "models/item-delete":
        await deleteModelEntry(loader, message.id, modelDataPath);
        await reloadConfigs(loader, modelsProvider, modelDataPath);
        break;
    }
  });

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      validateDocument(doc, nofsDiagnostics);
      if (doc.uri.scheme === CHANNELS_SCHEME) {
        const tabId = getTabIdFromUri(doc.uri);
        if (tabId) {
          openChannelDocs.set(tabId, doc);
        }
      }
      trackNofsLanguage(doc, nofsLanguageByUri);
      updateEditorStatus();
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      validateDocument(event.document, nofsDiagnostics);
      if (event.document.uri.scheme === CHANNELS_SCHEME) {
        const tabId = getTabIdFromUri(event.document.uri);
        if (tabId) {
          const existing = channelEditTimers.get(tabId);
          if (existing) {
            clearTimeout(existing);
          }
          channelEditTimers.set(
            tabId,
            setTimeout(() => {
              const draft = parseChannelDocument(event.document.getText());
              if (!draft) {
                return;
              }
              void mixerController.updateChannels(tabId, draft);
            }, 250)
          );
        }
      }
      schedulePhonesetAutofix(
        event.document,
        nofsLanguageByUri,
        nofsAutofixTimers,
        nofsAutofixInProgress
      );
      updateEditorStatus();
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      validateDocument(doc, nofsDiagnostics);
      trackNofsLanguage(doc, nofsLanguageByUri);
      updateEditorStatus();
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      nofsDiagnostics.delete(doc.uri);
      if (doc.uri.scheme === CHANNELS_SCHEME) {
        const tabId = getTabIdFromUri(doc.uri);
        if (tabId) {
          openChannelDocs.delete(tabId);
          const timer = channelEditTimers.get(tabId);
          if (timer) {
            clearTimeout(timer);
            channelEditTimers.delete(tabId);
          }
        }
      }
      clearNofsTracking(doc, nofsLanguageByUri, nofsAutofixTimers, nofsAutofixInProgress);
      updateEditorStatus();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      updateEditorStatus();
    })
  );

  for (const doc of vscode.workspace.textDocuments) {
    validateDocument(doc, nofsDiagnostics);
    if (doc.uri.scheme === CHANNELS_SCHEME) {
      const tabId = getTabIdFromUri(doc.uri);
      if (tabId) {
        openChannelDocs.set(tabId, doc);
      }
    }
    trackNofsLanguage(doc, nofsLanguageByUri);
  }

  updateEditorStatus();
}

export function deactivate(): void {
  return;
}

class MixerViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private messageHandler?: (message: MixerToExtensionMessage) => void;
  private pendingReveal = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "out-webview"),
        vscode.Uri.joinPath(this.context.extensionUri, "src", "webview"),
        vscode.Uri.joinPath(this.context.extensionUri, "media")
      ]
    };

    view.webview.html = renderWebviewHtml(view.webview, this.context.extensionUri, {
      htmlPath: ["src", "webview", "mixer", "index.html"],
      scriptPath: ["out-webview", "webview", "mixer", "index.js"],
      stylePath: ["src", "webview", "mixer", "styles.css"]
    });

    view.webview.onDidReceiveMessage((message) => {
      this.messageHandler?.(message as MixerToExtensionMessage);
    });

    view.onDidDispose(() => {
      this.view = undefined;
    });

    if (this.pendingReveal) {
      this.pendingReveal = false;
      view.show?.(true);
    }
  }

  post(message: ExtensionToMixerMessage): void {
    this.view?.webview.postMessage(message);
  }

  onMessage(handler: (message: MixerToExtensionMessage) => void): void {
    this.messageHandler = handler;
  }

  async reveal(): Promise<void> {
    if (this.view) {
      this.view.show?.(true);
      return;
    }
    this.pendingReveal = true;
  }
}

class ModelsViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private messageHandler?: (message: ModelsToExtensionMessage) => void;
  private pendingReveal = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "out-webview"),
        vscode.Uri.joinPath(this.context.extensionUri, "src", "webview"),
        vscode.Uri.joinPath(this.context.extensionUri, "media")
      ]
    };

    view.webview.html = renderWebviewHtml(view.webview, this.context.extensionUri, {
      htmlPath: ["src", "webview", "models", "index.html"],
      scriptPath: ["out-webview", "webview", "models", "index.js"],
      stylePath: ["src", "webview", "models", "styles.css"]
    });

    view.webview.onDidReceiveMessage((message) => {
      this.messageHandler?.(message as ModelsToExtensionMessage);
    });

    view.onDidDispose(() => {
      this.view = undefined;
    });

    if (this.pendingReveal) {
      this.pendingReveal = false;
      view.show?.(true);
    }
  }

  post(message: ExtensionToModelsMessage): void {
    this.view?.webview.postMessage(message);
  }

  onMessage(handler: (message: ModelsToExtensionMessage) => void): void {
    this.messageHandler = handler;
  }

  async reveal(): Promise<void> {
    if (this.view) {
      this.view.show?.(true);
      return;
    }
    this.pendingReveal = true;
  }
}

class MixerController {
  constructor(
    private readonly sessionStore: MixerSessionStore,
    private readonly mixerProvider: MixerViewProvider
  ) {}

  async addChannel(name: string, hex: string, source?: MixerChannel["source"]): Promise<void> {
    const state = this.sessionStore.get();
    const { tab, index } = getActiveTab(state);
    const channel: MixerChannel = {
      id: createId(),
      name,
      hex,
      weight: 0,
      source
    };
    const nextTab: MixerTab = {
      ...tab,
      channels: [...tab.channels, channel]
    };
    const nextState: MixerState = {
      ...state,
      tabs: state.tabs.map((item, idx) => (idx === index ? nextTab : item))
    };
    await this.sessionStore.set(nextState);
    this.mixerProvider.post({ type: "mixer/state", state: nextState });
  }

  async updateChannels(tabId: string, draft: ChannelDraft[]): Promise<void> {
    const state = this.sessionStore.get();
    const tabIndex = state.tabs.findIndex((tab) => tab.id === tabId);
    if (tabIndex === -1) {
      return;
    }
    const tab = state.tabs[tabIndex];
    const nextChannels = draft.map((entry, index) => {
      const prev = tab.channels[index];
      return {
        id: prev?.id ?? createId(),
        name: entry.name,
        hex: entry.data.toUpperCase(),
        weight: prev?.weight ?? 0,
        source: prev?.source
      };
    });
    const nextTab: MixerTab = {
      ...tab,
      channels: nextChannels
    };
    const nextState: MixerState = {
      ...state,
      tabs: state.tabs.map((item, idx) => (idx === tabIndex ? nextTab : item))
    };
    await this.sessionStore.set(nextState);
    this.mixerProvider.post({ type: "mixer/state", state: nextState });
  }
}

class ChannelDocumentProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly sessionStore: MixerSessionStore) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    const tabId = getTabIdFromUri(uri);
    if (!tabId) {
      return "[]";
    }
    const state = this.sessionStore.get();
    const tab = state.tabs.find((item) => item.id === tabId);
    if (!tab) {
      return "[]";
    }
    return buildChannelDocument(tab.channels);
  }

  refresh(uri: vscode.Uri): void {
    this.emitter.fire(uri);
  }
}

class ReadonlyDocumentProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    const filePath = decodeURIComponent(uri.path.slice(1));
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch {
      return "";
    }
  }
}
async function reloadConfigs(
  loader: VBConfigLoader,
  modelsProvider: ModelsViewProvider,
  modelDataPath: string
): Promise<void> {
  await ensureModelDataDirs(modelDataPath);
  const result = await loader.reload(modelDataPath);
  modelsProvider.post({ type: "models/configs", configs: result.entries });
  if (result.errors.length > 0) {
    vscode.window.showWarningMessage(
      `Loaded ${result.entries.length} configs with ${result.errors.length} error(s).`
    );
  }
}

async function pickStyle(
  loader: VBConfigLoader
): Promise<{ label: string; hex: string; source: MixerChannel["source"] } | undefined> {
  const entries = loader.getEntries();
  if (entries.length === 0) {
    vscode.window.showInformationMessage("No model configs loaded.");
    return;
  }
  const vbPick = await vscode.window.showQuickPick(
    entries.map((entry) => ({
      label: entry.config.name || "(unnamed)",
      description: entry.config.vendor,
      detail: entry.path,
      entry
    })),
    { placeHolder: "Select a model" }
  );
  if (!vbPick) {
    return;
  }
  const styles = Array.isArray(vbPick.entry.config.styles) ? vbPick.entry.config.styles : [];
  if (styles.length === 0) {
    vscode.window.showInformationMessage("Selected model has no styles.");
    return;
  }
  const stylePick = await vscode.window.showQuickPick(
    styles.map((style) => ({
      label: style.name,
      description: vbPick.entry.config.name,
      style
    })),
    { placeHolder: "Select a style" }
  );
  if (!stylePick) {
    return;
  }
  const version = vbPick.entry.config.version;
  const label = version
    ? `${vbPick.entry.config.name}-${version}-${stylePick.style.name}`
    : `${vbPick.entry.config.name}-${stylePick.style.name}`;
  return {
    label,
    hex: stylePick.style.data,
    source: {
      vbName: vbPick.entry.config.name,
      styleName: stylePick.style.name,
      filePath: vbPick.entry.path,
      version: vbPick.entry.config.version,
      vendor: vbPick.entry.config.vendor
    }
  };
}

async function addStyleHexFromCursor(
  mixerController: MixerController,
  mixerProvider: MixerViewProvider
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage("Open a JSON file first.");
    return;
  }
  const line = editor.document.lineAt(editor.selection.active.line);
  const match = /"data"\s*:\s*"([0-9a-fA-F]{256})"/.exec(line.text);
  if (!match) {
    vscode.window.showErrorMessage("No 256-hex \"data\" value found on this line.");
    return;
  }
  const meta = inferStyleMetadata(editor.document, line.lineNumber);
  const label = formatChannelLabel(meta);
  await mixerController.addChannel(label, match[1], {
    vbName: meta.vbName,
    styleName: meta.styleName,
    filePath: editor.document.fileName,
    version: meta.version,
    vendor: meta.vendor
  });
  await revealView("vectorCalculator.mixerView", mixerProvider);
  vscode.window.showInformationMessage("Successfully added to mixer.");
}

async function setMagnitudeAtCursor(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage("Open a JSON file first.");
    return;
  }
  const line = editor.document.lineAt(editor.selection.active.line);
  const regex = /"data"\s*:\s*"([0-9a-fA-F]{256})"/;
  const match = regex.exec(line.text);
  if (!match) {
    vscode.window.showErrorMessage("No 256-hex \"data\" value found on this line.");
    return;
  }
  const hex = match[1];
  let vec: Float32Array;
  try {
    vec = hexToVec32(hex);
  } catch {
    vscode.window.showErrorMessage("Invalid hex data on this line.");
    return;
  }
  const mag = l2Magnitude(vec);
  const meta = inferStyleMetadata(editor.document, line.lineNumber);
  const target = await showMagnitudeDialog(context, {
    initial: mag,
    hex,
    meta
  });
  if (target === undefined) {
    return;
  }
  const next = setMagnitude(vec, target);
  const nextHex = vec32ToHex(next);
  const hexOffset = match.index + match[0].indexOf(hex);
  const start = new vscode.Position(line.lineNumber, hexOffset);
  const end = new vscode.Position(line.lineNumber, hexOffset + hex.length);

  const edit = new vscode.WorkspaceEdit();
  edit.replace(editor.document.uri, new vscode.Range(start, end), nextHex);
  await vscode.workspace.applyEdit(edit);
}
async function showMagnitudeDialog(
  context: vscode.ExtensionContext,
  payload: { initial: number; hex: string; meta: StyleMeta }
): Promise<number | undefined> {
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel(
      "vectorCalculator.magnitude",
      "Set Magnitude",
      vscode.ViewColumn.Active,
      { enableScripts: true }
    );
    const range = Math.max(10, Math.ceil(Math.abs(payload.initial) * 2));
    const initPayload = { ...payload, range };
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, "out-webview"),
        vscode.Uri.joinPath(context.extensionUri, "src", "webview")
      ]
    };
    panel.webview.html = renderWebviewHtml(panel.webview, context.extensionUri, {
      htmlPath: ["src", "webview", "magnitude", "index.html"],
      scriptPath: ["out-webview", "webview", "magnitude", "index.js"],
      stylePath: ["src", "webview", "magnitude", "styles.css"]
    });

    const subscription = panel.webview.onDidReceiveMessage((message) => {
      if (message.type === "ready") {
        panel.webview.postMessage({ type: "init", payload: initPayload });
        return;
      }
      if (message.type === "apply") {
        const value = parseSignedNumber(String(message.value));
        if (value === null) {
          vscode.window.showErrorMessage("Enter a valid magnitude.");
          return;
        }
        resolve(value);
        panel.dispose();
      } else if (message.type === "cancel") {
        resolve(undefined);
        panel.dispose();
      }
    });

    panel.onDidDispose(() => {
      subscription.dispose();
      resolve(undefined);
    }, null, context.subscriptions);
  });
}
async function exportStyleToActiveDocument(
  name: string,
  hex: string,
  collection: vscode.DiagnosticCollection
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isNofsDocument(editor.document)) {
    vscode.window.showErrorMessage("Open a valid .nofs.json file to export.");
    return;
  }

  if (!HEX_256_RE.test(hex)) {
    vscode.window.showErrorMessage("Mixer output is not a valid 256-hex string.");
    return;
  }
  validateDocument(editor.document, collection);
  const diagnostics = collection.get(editor.document.uri) ?? [];
  if (diagnostics.some((diag) => diag.severity === vscode.DiagnosticSeverity.Error)) {
    vscode.window.showErrorMessage("Fix errors in the .nofs.json file before exporting.");
    return;
  }

  const text = editor.document.getText();
  const parseErrors: ParseError[] = [];
  const root = parseTree(text, parseErrors, { allowTrailingComma: true });
  if (!root || parseErrors.length > 0) {
    vscode.window.showErrorMessage("Invalid JSON format in the active file.");
    return;
  }
  const stylesNode = findNodeAtLocation(root, ["styles"]);
  if (!stylesNode || stylesNode.type !== "array") {
    vscode.window.showErrorMessage("Active file does not contain a styles array.");
    return;
  }

  const styleName = name.trim() || "Mixed";
  const newStyle = { name: styleName, data: hex.toUpperCase() };
  const insertIndex = stylesNode.children ? stylesNode.children.length : 0;
  const edits = modify(text, ["styles", insertIndex], newStyle, {
    formattingOptions: getJsonFormattingOptions(editor.document)
  });
  await applyJsonEdits(editor.document, edits);
  vscode.window.showInformationMessage("Style appended to styles.");
}

async function openModelDataPath(modelDataPath: string): Promise<void> {
  await ensureModelDataDirs(modelDataPath);
  await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(modelDataPath));
}

async function saveActiveNofsToAdditional(
  modelDataPath: string,
  collection: vscode.DiagnosticCollection
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isNofsDocument(editor.document)) {
    vscode.window.showErrorMessage("Open a .nofs.json file to save.");
    return;
  }
  validateDocument(editor.document, collection);
  const diagnostics = collection.get(editor.document.uri) ?? [];
  if (diagnostics.some((diag) => diag.severity === vscode.DiagnosticSeverity.Error)) {
    vscode.window.showErrorMessage("Fix errors in the .nofs.json file before saving.");
    return;
  }

  const parseErrors: ParseError[] = [];
  const data = parse(editor.document.getText(), parseErrors, {
    allowTrailingComma: true
  }) as Partial<VBConfig> | undefined;
  if (parseErrors.length > 0 || !data) {
    vscode.window.showErrorMessage("Failed to parse the active .nofs.json file.");
    return;
  }

  if (typeof data.name !== "string" || typeof data.version !== "string") {
    vscode.window.showErrorMessage("Active file missing name or version.");
    return;
  }

  const dirs = await ensureModelDataDirs(modelDataPath);
  const fileName = `${sanitizeFileName(data.name)}-${sanitizeFileName(
    data.version
  )}.nofs.json`;
  const targetPath = path.join(dirs.additional, fileName);
  if (fs.existsSync(targetPath)) {
    const choice = await vscode.window.showWarningMessage(
      `${fileName} already exists in additional. Overwrite?`,
      { modal: true },
      "Overwrite"
    );
    if (choice !== "Overwrite") {
      return;
    }
  }
  await fs.promises.writeFile(targetPath, editor.document.getText(), "utf8");
  vscode.window.showInformationMessage(`Saved to ${targetPath}`);
}

async function generateRandomNofs(modelDataPath: string): Promise<void> {
  const dirs = await ensureModelDataDirs(modelDataPath);
  const config = createRandomConfig();
  const normalized = normalizeNofsConfig(config);
  const validation = validateNofsData(normalized);
  if (validation.errors.length > 0) {
    const messages = validation.errors.map((issue) => issue.message).join("\n");
    vscode.window.showErrorMessage(`Failed to generate valid config:\n${messages}`);
    return;
  }
  const fileName = `${sanitizeFileName(normalized.name)}-${sanitizeFileName(
    normalized.version
  )}.nofs.json`;
  const targetPath = path.join(dirs.random, fileName);
  await fs.promises.writeFile(targetPath, JSON.stringify(normalized, null, 2), "utf8");
  vscode.window.showInformationMessage(`Generated ${targetPath}`);
}

async function editModelEntry(loader: VBConfigLoader, id: string): Promise<void> {
  const entry = loader.getEntryById(id);
  if (!entry) {
    vscode.window.showErrorMessage("Model not found.");
    return;
  }
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage("Open a workspace folder to copy the model file.");
    return;
  }

  const name = entry.config.name || path.parse(entry.path).name;
  const version = entry.config.version || "0";
  const fileName = `${sanitizeFileName(name)}-${sanitizeFileName(version)}.nofs.json`;
  const targetPath = path.join(workspaceRoot, fileName);

  if (fs.existsSync(targetPath)) {
    const choice = await vscode.window.showWarningMessage(
      `${fileName} already exists. Overwrite?`,
      { modal: true },
      "Overwrite"
    );
    if (choice !== "Overwrite") {
      return;
    }
  }

  await fs.promises.copyFile(entry.path, targetPath);
  const doc = await vscode.workspace.openTextDocument(targetPath);
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function viewModelEntry(
  loader: VBConfigLoader,
  id: string,
  provider: ReadonlyDocumentProvider
): Promise<void> {
  const entry = loader.getEntryById(id);
  if (!entry) {
    vscode.window.showErrorMessage("Model not found.");
    return;
  }
  const uri = toReadonlyUri(entry.path);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.languages.setTextDocumentLanguage(doc, "json");
  await vscode.window.showTextDocument(doc, { preview: true });
}

async function deleteModelEntry(
  loader: VBConfigLoader,
  id: string,
  modelDataPath: string
): Promise<void> {
  const entry = loader.getEntryById(id);
  if (!entry) {
    vscode.window.showErrorMessage("Model not found.");
    return;
  }
  if (!isUnderRoot(entry.path, modelDataPath)) {
    vscode.window.showErrorMessage("Refusing to delete files outside model-data.");
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `Delete ${path.basename(entry.path)}?`,
    { modal: true },
    "Delete"
  );
  if (choice !== "Delete") {
    return;
  }
  await fs.promises.unlink(entry.path);
}
function validateDocument(
  document: vscode.TextDocument,
  collection: vscode.DiagnosticCollection
): vscode.Diagnostic[] | undefined {
  if (!isNofsDocument(document)) {
    return;
  }
  const diagnostics = getNofsDiagnostics(document);
  collection.set(document.uri, diagnostics);
  return diagnostics;
}

function isNofsDocument(document: vscode.TextDocument): boolean {
  return document.fileName.toLowerCase().endsWith(".nofs.json");
}

function trackNofsLanguage(
  document: vscode.TextDocument,
  cache: Map<string, string>
): void {
  if (!isNofsDocument(document)) {
    return;
  }
  const info = readLanguageAndPhoneset(document.getText());
  if (!info?.language) {
    return;
  }
  cache.set(document.uri.toString(), info.language);
}

function schedulePhonesetAutofix(
  document: vscode.TextDocument,
  cache: Map<string, string>,
  timers: Map<string, NodeJS.Timeout>,
  inProgress: Set<string>
): void {
  if (!isNofsDocument(document) || document.uri.scheme !== "file") {
    return;
  }
  const key = document.uri.toString();
  const existing = timers.get(key);
  if (existing) {
    clearTimeout(existing);
  }
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      void applyPhonesetAutofix(document, cache, inProgress);
    }, 250)
  );
}

function clearNofsTracking(
  document: vscode.TextDocument,
  cache: Map<string, string>,
  timers: Map<string, NodeJS.Timeout>,
  inProgress: Set<string>
): void {
  if (!isNofsDocument(document)) {
    return;
  }
  const key = document.uri.toString();
  cache.delete(key);
  const timer = timers.get(key);
  if (timer) {
    clearTimeout(timer);
    timers.delete(key);
  }
  inProgress.delete(key);
}

async function applyPhonesetAutofix(
  document: vscode.TextDocument,
  cache: Map<string, string>,
  inProgress: Set<string>
): Promise<void> {
  if (!isNofsDocument(document) || document.uri.scheme !== "file") {
    return;
  }
  const key = document.uri.toString();
  if (inProgress.has(key)) {
    return;
  }
  const info = readLanguageAndPhoneset(document.getText());
  if (!info?.language) {
    return;
  }
  const previous = cache.get(key);
  if (previous === info.language) {
    return;
  }
  cache.set(key, info.language);
  if (!ALLOWED_LANGUAGES.has(info.language)) {
    return;
  }
  const expected = PHONESET_BY_LANGUAGE.get(info.language);
  if (!expected || info.phoneset === expected) {
    return;
  }
  inProgress.add(key);
  try {
    const edits = modify(document.getText(), ["phoneset"], expected, {
      formattingOptions: getJsonFormattingOptions(document)
    });
    await applyJsonEdits(document, edits);
  } finally {
    inProgress.delete(key);
  }
}

function readLanguageAndPhoneset(
  text: string
): { language?: string; phoneset?: string } | undefined {
  const errors: ParseError[] = [];
  const data = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !data || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }
  const obj = data as Record<string, unknown>;
  const language =
    typeof obj.language === "string" ? obj.language.toLowerCase() : undefined;
  const phoneset =
    typeof obj.phoneset === "string" ? obj.phoneset.toLowerCase() : undefined;
  return { language, phoneset };
}

function getGroupingMode(store: vscode.Memento): GroupingMode {
  const value = store.get<GroupingMode>(GROUPING_MODE_KEY);
  if (value === "name" || value === "vendor" || value === "base_model") {
    return value;
  }
  return "name";
}

async function revealView(
  viewId: string,
  provider: { reveal: () => Promise<void> }
): Promise<void> {
  await vscode.commands.executeCommand("workbench.view.extension.vectorCalculator");
  await tryExecuteCommand("workbench.action.openView", viewId);
  await tryExecuteCommand("workbench.action.focusView", viewId);
  await provider.reveal();
}

function parseSignedNumber(input: string): number | null {
  if (!input) {
    return null;
  }
  const value = Number(input);
  if (Number.isNaN(value)) {
    return null;
  }
  if (value === 0 && input.trim().startsWith("-")) {
    return -0;
  }
  return value;
}

function resolveModelDataPath(context: vscode.ExtensionContext): string {
  const config = vscode.workspace.getConfiguration("vectorCalculator");
  const raw = config.get<string>(MODEL_DATA_SETTING, "");
  const fallback = path.join(context.globalStorageUri.fsPath, "model-data");
  return path.resolve(expandPath(raw, fallback));
}

function expandPath(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  if (trimmed.toLowerCase().startsWith("file:")) {
    try {
      return vscode.Uri.parse(trimmed).fsPath;
    } catch {
      return fallback;
    }
  }
  let expanded = trimmed.replace(/\$\{userHome\}/gi, os.homedir());
  if (expanded.startsWith("~")) {
    expanded = path.join(os.homedir(), expanded.slice(1));
  }
  return expanded;
}

async function ensureModelDataDirs(modelDataPath: string): Promise<ModelDataDirs> {
  const root = modelDataPath;
  const additional = path.join(root, "additional");
  const random = path.join(root, "random");
  await fs.promises.mkdir(additional, { recursive: true });
  await fs.promises.mkdir(random, { recursive: true });
  return { root, additional, random };
}

function createModelDataWatcher(
  modelDataPath: string,
  onChange: () => void
): vscode.FileSystemWatcher {
  const pattern = new vscode.RelativePattern(modelDataPath, "**/*.nofs.json");
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);
  watcher.onDidChange(onChange);
  watcher.onDidCreate(onChange);
  watcher.onDidDelete(onChange);
  return watcher;
}

function getActiveNofsStatus(
  collection: vscode.DiagnosticCollection
): { canSaveActive: boolean } {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isNofsDocument(editor.document)) {
    return { canSaveActive: false };
  }
  const diagnostics = collection.get(editor.document.uri) ?? getNofsDiagnostics(editor.document);
  const hasError = diagnostics.some(
    (diag) => diag.severity === vscode.DiagnosticSeverity.Error
  );
  return { canSaveActive: !hasError };
}

function getActiveTab(state: MixerState): { tab: MixerTab; index: number } {
  if (!state.tabs || state.tabs.length === 0) {
    const fallback: MixerTab = {
      id: createId(),
      name: "",
      outputName: "",
      busPercent: 100,
      channels: []
    };
    return { tab: fallback, index: 0 };
  }
  const index = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
  if (index >= 0) {
    return { tab: state.tabs[index], index };
  }
  return { tab: state.tabs[0], index: 0 };
}
function inferStyleMetadata(document: vscode.TextDocument, lineNumber: number): StyleMeta {
  const lines = document.getText().split(/\r?\n/);
  const meta: StyleMeta = {};
  meta.styleName = findNearestValue(lines, lineNumber, "name", 50);
  meta.vbName = findTopLevelValue(lines, "name");
  meta.version = findTopLevelValue(lines, "version");
  meta.vendor = findTopLevelValue(lines, "vendor");
  return meta;
}

function findNearestValue(
  lines: string[],
  lineNumber: number,
  key: string,
  range: number
): string | undefined {
  const start = Math.max(0, lineNumber - range);
  for (let i = lineNumber; i >= start; i -= 1) {
    const match = new RegExp(`^(\\s*)"${key}"\\s*:\\s*"([^"]+)"`).exec(lines[i]);
    if (match) {
      return match[2];
    }
  }
  return undefined;
}

function findTopLevelValue(lines: string[], key: string): string | undefined {
  let bestIndent = Number.POSITIVE_INFINITY;
  let bestValue: string | undefined;
  const regex = new RegExp(`^(\\s*)"${key}"\\s*:\\s*"([^"]+)"`);
  for (const line of lines) {
    const match = regex.exec(line);
    if (!match) {
      continue;
    }
    const indent = match[1].length;
    if (indent < bestIndent) {
      bestIndent = indent;
      bestValue = match[2];
    }
  }
  return bestValue;
}

function formatChannelLabel(meta: StyleMeta): string {
  if (meta.vbName && meta.version && meta.styleName) {
    return `${meta.vbName}-${meta.version}-${meta.styleName}`;
  }
  if (meta.vbName && meta.styleName) {
    return `${meta.vbName}-${meta.styleName}`;
  }
  return "Imported";
}

function buildChannelDocument(channels: MixerChannel[]): string {
  const list = channels.map((channel) => ({
    name: channel.name,
    data: channel.hex.toUpperCase()
  }));
  return JSON.stringify(list, null, 2);
}

function parseChannelDocument(text: string): ChannelDraft[] | null {
  const errors: ParseError[] = [];
  const data = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !Array.isArray(data)) {
    return null;
  }
  const draft: ChannelDraft[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") {
      return null;
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    const value = record.data;
    if (typeof value !== "string" || !HEX_256_RE.test(value)) {
      return null;
    }
    draft.push({ name, data: value.toUpperCase() });
  }
  return draft;
}

async function openChannelEditor(
  state: MixerState,
  tabId: string,
  provider: ChannelDocumentProvider,
  openDocs: Map<string, vscode.TextDocument>
): Promise<void> {
  const tabIndex = state.tabs.findIndex((tab) => tab.id === tabId);
  if (tabIndex === -1) {
    vscode.window.showErrorMessage("Mixer tab not found.");
    return;
  }
  const existing = openDocs.get(tabId);
  if (existing) {
    await vscode.window.showTextDocument(existing, { preview: false });
    return;
  }
  const displayName = getTabDisplayName(state, tabId, tabIndex);
  const uri = toChannelUri(tabId, displayName);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.languages.setTextDocumentLanguage(doc, "json");
  openDocs.set(tabId, doc);
  await vscode.window.showTextDocument(doc, { preview: false });
  provider.refresh(uri);
}

function getTabDisplayName(state: MixerState, tabId: string, index: number): string {
  const tab = state.tabs.find((item) => item.id === tabId);
  const fallback = `Mixer${index + 1}`;
  if (!tab || !tab.name || !tab.name.trim()) {
    return fallback;
  }
  return tab.name.trim();
}

function toChannelUri(tabId: string, displayName: string): vscode.Uri {
  const fileName = `${sanitizeFileName(displayName)}-Channels.json`;
  return vscode.Uri.parse(
    `${CHANNELS_SCHEME}:/${fileName}?tabId=${encodeURIComponent(tabId)}`
  );
}

function toReadonlyUri(filePath: string): vscode.Uri {
  return vscode.Uri.parse(`${READONLY_SCHEME}:/${encodeURIComponent(filePath)}`);
}

function getTabIdFromUri(uri: vscode.Uri): string | undefined {
  if (!uri.query) {
    return undefined;
  }
  const params = new URLSearchParams(uri.query);
  return params.get("tabId") ?? undefined;
}

function refreshOpenChannelDocs(
  openDocs: Map<string, vscode.TextDocument>,
  provider: ChannelDocumentProvider
): void {
  for (const doc of openDocs.values()) {
    if (doc.isDirty) {
      continue;
    }
    provider.refresh(doc.uri);
  }
}

function isUnderRoot(filePath: string, root: string): boolean {
  const relative = path.relative(root, filePath);
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sanitizeFileName(value: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*]/g, "_").trim();
  return cleaned || "item";
}
function createRandomConfig(): VBConfig {
  const languages = Array.from(ALLOWED_LANGUAGES);
  const language = pickRandom(languages);
  const phoneset = PHONESET_BY_LANGUAGE.get(language) ?? "xsampa";
  const name = randomName();
  const version = "200";
  const vendor = "Random Inc.";
  const supportLanguages = [...languages].sort();
  const styles: { name: string; data: string }[] = [
    { name: "(base)", data: randomStyleHex() },
    { name: "(default)", data: randomStyleHex() }
  ];
  const extraCount = randomInt(5, 10);
  for (let i = 1; i <= extraCount; i += 1) {
    styles.push({ name: `Random${i}`, data: randomStyleHex() });
  }
  return {
    name,
    version,
    vendor,
    language,
    phoneset,
    support_languages: supportLanguages,
    base_model: pickRandom(Array.from(ALLOWED_BASE_MODEL)),
    sing_model: pickRandom(Array.from(ALLOWED_SING_MODEL)),
    timing_model: pickRandom(Array.from(ALLOWED_TIMING_MODEL)),
    f0_model: pickRandom(Array.from(ALLOWED_F0_MODEL)),
    styles,
    pitch: randomStyleHex(),
    timing: randomHexString(1024)
  };
}

function randomStyleHex(): string {
  const vec = new Float32Array(32);
  for (let i = 0; i < vec.length; i += 1) {
    vec[i] = (Math.random() * 2 - 1) * 1;
  }
  return vec32ToHex(vec);
}

function randomHexString(length: number): string {
  const byteLength = Math.floor(length / 2);
  let out = "";
  for (let i = 0; i < byteLength; i += 1) {
    out += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0");
  }
  return out.toUpperCase();
}

function randomName(): string {
  const wordCount = Math.random() < 0.5 ? 1 : 2;
  const words: string[] = [];
  for (let i = 0; i < wordCount; i += 1) {
    words.push(randomWord());
  }
  return words.join(" ");
}

function randomWord(): string {
  const length = randomInt(3, 8);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    const code = 97 + Math.floor(Math.random() * 26);
    out += String.fromCharCode(code);
  }
  return out.charAt(0).toUpperCase() + out.slice(1);
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandom<T>(values: T[]): T {
  return values[Math.floor(Math.random() * values.length)];
}

function getJsonFormattingOptions(document: vscode.TextDocument): {
  insertSpaces: boolean;
  tabSize: number;
  eol: string;
} {
  return {
    insertSpaces: true,
    tabSize: 2,
    eol: document.eol === vscode.EndOfLine.LF ? "\n" : "\r\n"
  };
}

async function applyJsonEdits(
  document: vscode.TextDocument,
  edits: { offset: number; length: number; content: string }[]
): Promise<void> {
  if (edits.length === 0) {
    return;
  }
  const workspaceEdit = new vscode.WorkspaceEdit();
  const textEdits = edits.map(
    (edit) =>
      new vscode.TextEdit(
        rangeFromOffset(document, edit.offset, edit.length),
        edit.content
      )
  );
  workspaceEdit.set(document.uri, textEdits);
  await vscode.workspace.applyEdit(workspaceEdit);
}

function rangeFromOffset(
  document: vscode.TextDocument,
  offset: number,
  length: number
): vscode.Range {
  const start = document.positionAt(offset);
  const end = document.positionAt(offset + Math.max(length, 1));
  return new vscode.Range(start, end);
}

function escapeScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function createId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createNonce(): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i += 1) {
    nonce += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return nonce;
}

async function tryExecuteCommand(command: string, ...args: unknown[]): Promise<void> {
  try {
    await vscode.commands.executeCommand(command, ...args);
  } catch {
    return;
  }
}
