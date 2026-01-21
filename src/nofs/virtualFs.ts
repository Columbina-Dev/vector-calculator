import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { decryptNofsToJson, encryptJsonToNofs } from "./binary";
import { maybeBackupNofsFile } from "./backup";
import {
  canonicalizeJsonText,
  formatJsoncText,
  parseNofsMeta,
  prepareNofsJsonText
} from "./text";

export class NofsJsonFileSystemProvider implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  watch(_uri: vscode.Uri, _options: { recursive: boolean; excludes: string[] }): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const original = this.decodeOriginalUri(uri);
    const stat = await vscode.workspace.fs.stat(original);
    const content = await this.readFile(uri);
    return {
      type: vscode.FileType.File,
      ctime: stat.ctime,
      mtime: stat.mtime,
      size: content.length
    };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const original = this.decodeOriginalUri(uri);
    try {
      const settings = getNofsSettings();
      const data = await vscode.workspace.fs.readFile(original);
      const jsonText = decryptNofsToJson(Buffer.from(data));
      const formatted = settings.useJsoncEditing ? formatJsoncText(jsonText) : jsonText;
      if (settings.useJsoncEditing) {
        const jsoncPath = `${original.fsPath}.jsonc`;
        if (fsExists(jsoncPath)) {
          const jsoncData = await vscode.workspace.fs.readFile(vscode.Uri.file(jsoncPath));
          const jsoncText = Buffer.from(jsoncData).toString("utf8");
          const jsoncClean = prepareNofsJsonText(jsoncText);
          const jsoncCanonical = canonicalizeJsonText(jsoncClean);
          const nofsCanonical = canonicalizeJsonText(jsonText);
          if (jsoncCanonical && nofsCanonical && jsoncCanonical === nofsCanonical) {
            const formattedJsonc = formatJsoncText(jsoncText);
            return Buffer.from(formattedJsonc, "utf8");
          }
          vscode.window.showWarningMessage(
            "Companion .nofs.jsonc is out of sync with the .nofs file; showing decrypted data."
          );
        }
      }
      return Buffer.from(formatted, "utf8");
    } catch (error) {
      const message = (error as Error).message || "Unknown error.";
      vscode.window.showErrorMessage(`Failed to decrypt NOFS file: ${message}`);
      throw error;
    }
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    _options: { create: boolean; overwrite: boolean }
  ): Promise<void> {
    const original = this.decodeOriginalUri(uri);
    try {
      const rawText = Buffer.from(content).toString("utf8");
      const cleaned = prepareNofsJsonText(rawText);
      const encrypted = encryptJsonToNofs(cleaned);
      const settings = getNofsSettings();
      const meta = parseNofsMeta(rawText);
      const target = await resolveSaveTarget(original, meta, settings);
      await maybeBackupNofsFile(target.fsPath, meta, {
        enabled: settings.backupEnabled,
        maxCount: settings.backupMax,
        dir: settings.backupDir
      });
      await vscode.workspace.fs.writeFile(target, encrypted);
      if (settings.useJsoncEditing) {
        const jsoncPath = vscode.Uri.file(`${target.fsPath}.jsonc`);
        const formatted = formatJsoncText(rawText);
        await vscode.workspace.fs.writeFile(jsoncPath, Buffer.from(formatted, "utf8"));
      }
    } catch (error) {
      const message = (error as Error).message || "Unknown error.";
      vscode.window.showErrorMessage(`Failed to encrypt NOFS file: ${message}`);
      throw error;
    }
  }

  readDirectory(_uri: vscode.Uri): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(_uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions("Read-only virtual filesystem.");
  }

  delete(_uri: vscode.Uri, _options: { recursive: boolean }): void {
    throw vscode.FileSystemError.NoPermissions("Read-only virtual filesystem.");
  }

  rename(
    _oldUri: vscode.Uri,
    _newUri: vscode.Uri,
    _options: { overwrite: boolean }
  ): void {
    throw vscode.FileSystemError.NoPermissions("Read-only virtual filesystem.");
  }

  private decodeOriginalUri(uri: vscode.Uri): vscode.Uri {
    const params = new URLSearchParams(uri.query);
    const encoded = params.get("orig");
    if (!encoded) {
      throw new Error("Missing original NOFS path.");
    }
    const decoded = decodeBase64Url(encoded);
    return vscode.Uri.file(decoded);
  }
}

export function toVirtualUri(
  originalNofsUri: vscode.Uri,
  displayExt: "json" | "jsonc" = "json"
): vscode.Uri {
  const baseName = path.basename(originalNofsUri.fsPath);
  const encoded = encodeBase64Url(originalNofsUri.fsPath);
  return vscode.Uri.from({
    scheme: "nofsjson",
    path: `/${baseName}.${displayExt}`,
    query: `orig=${encoded}`
  });
}

export function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function decodeBase64Url(value: string): string {
  let base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = base64.length % 4;
  if (padding) {
    base64 += "=".repeat(4 - padding);
  }
  return Buffer.from(base64, "base64").toString("utf8");
}

function getNofsSettings(): {
  useJsoncEditing: boolean;
  saveToProjectRoot: boolean;
  backupEnabled: boolean;
  backupMax: number;
  backupDir: string;
} {
  const config = vscode.workspace.getConfiguration("vectorCalculator");
  return {
    useJsoncEditing: config.get<boolean>("useJsoncNofsEditing", false),
    saveToProjectRoot: config.get<boolean>("saveNofsToProjectRoot", false),
    backupEnabled: config.get<boolean>("backupNofsEnabled", false),
    backupMax: config.get<number>("backupNofsMax", 5),
    backupDir: config.get<string>("backupNofsDir", "") || ""
  };
}

function fsExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

async function resolveSaveTarget(
  original: vscode.Uri,
  meta: { name?: string; version?: string },
  settings: { saveToProjectRoot: boolean }
): Promise<vscode.Uri> {
  if (!settings.saveToProjectRoot) {
    return original;
  }
  if (!meta.name || !meta.version) {
    throw new Error("Missing name or version for project-root saving.");
  }
  const root = resolveWorkspaceRootFromUri(original);
  if (!root) {
    throw new Error("Open a workspace folder to use project root saving.");
  }
  const targetDir = path.join(root, meta.name);
  await fs.promises.mkdir(targetDir, { recursive: true });
  return vscode.Uri.file(path.join(targetDir, `voice.${meta.version}.nofs`));
}

function resolveWorkspaceRootFromUri(uri: vscode.Uri): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(uri) ?? vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath;
}
