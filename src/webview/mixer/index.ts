
import { applyBus, hexToVec32, l2Magnitude, mixVectors, vec32ToHex } from "../../mixer/math.js";
import type {
  ExtensionToMixerMessage,
  MixerChannel,
  MixerState,
  MixerTab,
  MixerToExtensionMessage
} from "../../shared/protocol.js";
import { byId, setText } from "../common/base.js";
import { createMessenger } from "../common/messaging.js";

const messenger = createMessenger<ExtensionToMixerMessage, MixerToExtensionMessage>();

const tabsBar = byId<HTMLDivElement>("tabsBar");
const addTabBtn = byId<HTMLButtonElement>("addTab");
const tabNameInput = byId<HTMLInputElement>("tabNameInput");
const mixNameInput = byId<HTMLInputElement>("mixNameInput");
const newChannelBtn = byId<HTMLButtonElement>("newChannel");
const randomChannelBtn = byId<HTMLButtonElement>("randomChannel");
const exportBtn = byId<HTMLButtonElement>("exportJson");
const copyBtn = byId<HTMLButtonElement>("copyJson");
const outputHexEl = byId<HTMLPreElement>("outputHex");
const outputMagEl = byId<HTMLSpanElement>("outputMag");
const outputErrorEl = byId<HTMLDivElement>("outputError");
const busSliderEl = byId<HTMLInputElement>("busSlider");
const busInputEl = byId<HTMLInputElement>("busInput");
const channelListEl = byId<HTMLDivElement>("channelList");
const channelEmptyEl = byId<HTMLDivElement>("channelEmpty");

let state: MixerState = { activeTabId: "", tabs: [] };
let canExport = false;
let lastHex = "";

messenger.on((message) => {
  switch (message.type) {
    case "mixer/init":
    case "mixer/state":
      state = message.state;
      render();
      break;
    case "mixer/editor-state":
      canExport = message.canExport;
      updateExportState();
      break;
    case "mixer/notify":
      showError(message.message);
      break;
  }
});

messenger.post({ type: "mixer/ready" });

addTabBtn.addEventListener("click", () => {
  const nextTab: MixerTab = {
    id: createId(),
    name: "",
    outputName: "",
    busPercent: 100,
    channels: []
  };
  const nextTabs = [...state.tabs, nextTab];
  updateState({ ...state, tabs: nextTabs, activeTabId: nextTab.id });
});

newChannelBtn.addEventListener("click", () => {
  messenger.post({ type: "mixer/add-request" });
});

randomChannelBtn.addEventListener("click", () => {
  const tab = getActiveTab();
  if (!tab) {
    return;
  }
  const index = tab.channels.length + 1;
  const channel: MixerChannel = {
    id: createId(),
    name: `Random${index}`,
    hex: randomHex(),
    weight: 0
  };
  const nextTab = { ...tab, channels: [...tab.channels, channel] };
  updateActiveTab(nextTab);
});

exportBtn.addEventListener("click", () => {
  if (!canExport) {
    return;
  }
  messenger.post({
    type: "mixer/export-style",
    name: getMixName(),
    hex: lastHex
  });
});

copyBtn.addEventListener("click", () => {
  messenger.post({
    type: "mixer/copy-style",
    name: getMixName(),
    hex: lastHex
  });
});

busSliderEl.addEventListener("input", () => {
  const value = clampNumber(Number(busSliderEl.value), 0, 500, 100);
  busInputEl.value = value.toString();
  updateBusPercent(value);
});

busInputEl.addEventListener("input", () => {
  const parsed = parseInteger(busInputEl.value);
  if (parsed === null) {
    return;
  }
  const value = clampNumber(parsed, 0, 500, 100);
  busSliderEl.value = value.toString();
  busInputEl.value = value.toString();
  updateBusPercent(value);
});

tabNameInput.addEventListener("input", () => {
  const tab = getActiveTab();
  if (!tab) {
    return;
  }
  updateActiveTab({ ...tab, name: tabNameInput.value });
});

mixNameInput.addEventListener("input", () => {
  const tab = getActiveTab();
  if (!tab) {
    return;
  }
  updateActiveTab({ ...tab, outputName: mixNameInput.value });
});

window.addEventListener("resize", () => {
  renderChannels();
});
function render(): void {
  renderTabs();
  renderInputs();
  renderChannels();
  renderOutput();
  updateExportState();
}

function renderTabs(): void {
  tabsBar.innerHTML = "";
  state.tabs.forEach((tab, index) => {
    const tabEl = document.createElement("button");
    tabEl.className = "tab-btn";
    if (tab.id === state.activeTabId) {
      tabEl.classList.add("active");
    }
    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = tab.name && tab.name.trim() ? tab.name.trim() : `Mixer${index + 1}`;

    const close = document.createElement("span");
    close.className = "tab-close";
    close.title = "Close tab";
    close.innerHTML = `<img class="icon tab-close-icon" src="${getIcon(
      "remove"
    )}" alt="Close" />`;
    if (state.tabs.length <= 1) {
      close.classList.add("disabled");
    }

    tabEl.append(label, close);
    tabEl.addEventListener("click", (event) => {
      if (event.target instanceof Node && close.contains(event.target)) {
        if (state.tabs.length <= 1) {
          return;
        }
        removeTab(tab.id);
        return;
      }
      if (tab.id === state.activeTabId) {
        return;
      }
      updateState({ ...state, activeTabId: tab.id });
    });

    tabsBar.appendChild(tabEl);
  });
}

function renderInputs(): void {
  const tab = getActiveTab();
  if (!tab) {
    tabNameInput.value = "";
    mixNameInput.value = "";
    return;
  }
  tabNameInput.value = tab.name || "";
  mixNameInput.value = tab.outputName || "";
  const tabIndex = state.tabs.findIndex((item) => item.id === tab.id);
  tabNameInput.placeholder = `Mixer${tabIndex + 1}`;
  busSliderEl.value = tab.busPercent.toString();
  busInputEl.value = tab.busPercent.toString();
}

function renderChannels(): void {
  channelListEl.innerHTML = "";
  const tab = getActiveTab();
  if (!tab || tab.channels.length === 0) {
    channelEmptyEl.style.display = "block";
    return;
  }
  channelEmptyEl.style.display = "none";

  tab.channels.forEach((channel) => {
    const row = document.createElement("div");
    row.className = "channel-row";

    const nameBox = document.createElement("div");
    nameBox.className = "channel-name";
    const nameText = document.createElement("span");
    nameText.textContent = channel.name || "(unnamed)";
    nameBox.appendChild(nameText);
    nameBox.addEventListener("click", () => {
      messenger.post({ type: "mixer/open-channel-editor", tabId: tab.id });
    });

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "-100";
    slider.max = "100";
    slider.step = "1";
    slider.value = channel.weight.toString();

    const number = document.createElement("input");
    number.type = "text";
    number.inputMode = "decimal";
    number.value = channel.weight.toString();

    const remove = document.createElement("button");
    remove.className = "icon-btn remove";
    remove.innerHTML = `<img class="icon" src="${getIcon("remove")}" alt="Remove" />`;
    remove.title = "Remove";

    const inputWrap = document.createElement("div");
    inputWrap.className = "input-wrap";
    const percent = document.createElement("span");
    percent.textContent = "%";
    inputWrap.append(number, percent, remove);

    slider.addEventListener("input", () => {
      const weight = clampNumber(Number(slider.value), -100, 100, 0);
      number.value = weight.toString();
      updateChannelWeightLocal(channel.id, weight);
    });

    slider.addEventListener("change", () => {
      commitState();
    });

    number.addEventListener("input", () => {
      const parsed = parseDecimal(number.value);
      if (parsed === null) {
        return;
      }
      const weight = clampNumber(parsed, -100, 100, 0);
      slider.value = Math.round(weight).toString();
      number.value = weight.toString();
      updateChannelWeightLocal(channel.id, weight);
    });

    number.addEventListener("change", () => {
      commitState();
    });

    remove.addEventListener("click", () => {
      removeChannel(channel.id);
    });

    row.append(nameBox, slider, inputWrap);
    channelListEl.appendChild(row);

    requestAnimationFrame(() => {
      applyScrolling(nameBox, nameText);
    });
  });
}

function renderOutput(): void {
  const tab = getActiveTab();
  const output = tab ? computeOutputVector(tab) : new Float32Array(32);
  lastHex = vec32ToHex(output);
  setText(outputHexEl, formatHex(lastHex));
  setText(outputMagEl, l2Magnitude(output).toFixed(3));
}

function updateState(next: MixerState): void {
  state = next;
  render();
  commitState();
}

function updateActiveTab(nextTab: MixerTab): void {
  const nextTabs = state.tabs.map((tab) => (tab.id === nextTab.id ? nextTab : tab));
  updateState({ ...state, tabs: nextTabs });
}

function updateBusPercent(value: number): void {
  const tab = getActiveTab();
  if (!tab) {
    return;
  }
  updateActiveTab({ ...tab, busPercent: value });
}

function updateChannelWeightLocal(id: string, weight: number): void {
  const tab = getActiveTab();
  if (!tab) {
    return;
  }
  const channels = tab.channels.map((channel) =>
    channel.id === id ? { ...channel, weight } : channel
  );
  const nextTab = { ...tab, channels };
  state = { ...state, tabs: state.tabs.map((item) => (item.id === tab.id ? nextTab : item)) };
  renderOutput();
}

function removeChannel(id: string): void {
  const tab = getActiveTab();
  if (!tab) {
    return;
  }
  updateActiveTab({
    ...tab,
    channels: tab.channels.filter((channel) => channel.id !== id)
  });
}

function removeTab(tabId: string): void {
  if (state.tabs.length <= 1) {
    return;
  }
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) {
    return;
  }
  const nextTabs = state.tabs.filter((tab) => tab.id !== tabId);
  const nextActive =
    state.activeTabId === tabId
      ? nextTabs[Math.min(index, nextTabs.length - 1)]?.id ?? nextTabs[0].id
      : state.activeTabId;
  updateState({ ...state, tabs: nextTabs, activeTabId: nextActive });
}

function getActiveTab(): MixerTab | undefined {
  return state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0];
}

function getMixName(): string {
  const tab = getActiveTab();
  if (!tab || !tab.outputName || !tab.outputName.trim()) {
    return "Mixed";
  }
  return tab.outputName.trim();
}
const mediaBase = document.body.dataset.mediaBase ?? "";

function computeOutputVector(tab: MixerTab): Float32Array<ArrayBufferLike> {
  const vectors: Float32Array[] = [];
  const weights: number[] = [];
  const errors: string[] = [];

  tab.channels.forEach((channel) => {
    try {
      vectors.push(hexToVec32(channel.hex));
      weights.push(channel.weight / 100);
    } catch {
      errors.push(`Invalid hex for ${channel.name || "channel"}.`);
    }
  });

  const mix = mixVectors(vectors, weights);
  let vector = applyBus(mix.vector, tab.busPercent);

  if (mix.sumAbs === 0) {
    vector = new Float32Array(32);
    errors.push("Sum of |w| is zero.");
  }

  if (errors.length > 0) {
    showError(errors.join(" "));
  } else {
    clearError();
  }

  return vector;
}

function updateExportState(): void {
  exportBtn.disabled = !canExport;
  exportBtn.classList.toggle("disabled", !canExport);
}

function showError(message: string): void {
  outputErrorEl.textContent = message;
  outputErrorEl.classList.remove("hidden");
}

function clearError(): void {
  outputErrorEl.textContent = "";
  outputErrorEl.classList.add("hidden");
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function formatHex(hex: string): string {
  const bytes = hex.match(/.{1,2}/g) ?? [];
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    lines.push(bytes.slice(i, i + 16).join(" "));
  }
  return lines.join("\n");
}

function randomHex(): string {
  const vec = new Float32Array(32);
  for (let i = 0; i < vec.length; i += 1) {
    vec[i] = (Math.random() * 2 - 1) * 1;
  }
  return vec32ToHex(vec);
}

function applyScrolling(container: HTMLElement, text: HTMLElement): void {
  text.getAnimations().forEach((anim) => anim.cancel());
  const distance = Math.ceil((text.scrollWidth - container.clientWidth) * 1.15);
  if (distance <= 0) {
    return;
  }
  const wait = 500;
  const speed = 60;
  const scrollMs = Math.max(1000, (distance / speed) * 1000);
  const total = wait + scrollMs + wait + scrollMs;
  text.animate(
    [
      { transform: "translateX(0)" },
      { transform: "translateX(0)", offset: wait / total },
      { transform: `translateX(-${distance}px)`, offset: (wait + scrollMs) / total },
      {
        transform: `translateX(-${distance}px)`,
        offset: (wait + scrollMs + wait) / total
      },
      { transform: "translateX(0)" }
    ],
    { duration: total, iterations: Infinity }
  );
}

function createId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getIcon(name: string): string {
  return `${mediaBase}/icons/${name}.svg`;
}

function commitState(): void {
  messenger.post({ type: "mixer/state", state });
}

function parseInteger(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (!/^-?\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function parseDecimal(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}
