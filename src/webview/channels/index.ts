import { hexToVec32, vec32ToHex } from "../../mixer/math.js";
import type {
  ChannelDraft,
  ChannelsToExtensionMessage,
  ExtensionToChannelsMessage
} from "../../shared/protocol.js";
import { byId } from "../common/base.js";
import { createMessenger } from "../common/messaging.js";

type TabKey = "json" | "hex" | "numbers";

interface ChannelEntry {
  name: string;
  hex: string;
  numbers: number[];
}

const HEX_256_RE = /^[0-9a-fA-F]{256}$/;

const messenger = createMessenger<ExtensionToChannelsMessage, ChannelsToExtensionMessage>();

const titleEl = byId<HTMLHeadingElement>("title");
const jsonEditor = byId<HTMLTextAreaElement>("jsonEditor");
const jsonError = byId<HTMLDivElement>("jsonError");
const hexTable = byId<HTMLDivElement>("hexTable");
const hexAdd = byId<HTMLButtonElement>("hexAdd");
const hexError = byId<HTMLDivElement>("hexError");
const numbersTable = byId<HTMLDivElement>("numbersTable");
const numbersAdd = byId<HTMLButtonElement>("numbersAdd");
const numbersError = byId<HTMLDivElement>("numbersError");
const cancelBtn = byId<HTMLButtonElement>("cancelBtn");
const saveBtn = byId<HTMLButtonElement>("saveBtn");

const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".tab-btn"));
const panels = {
  json: byId<HTMLDivElement>("panel-json"),
  hex: byId<HTMLDivElement>("panel-hex"),
  numbers: byId<HTMLDivElement>("panel-numbers")
};

let activeTab: TabKey = "json";
let tabId = "";
let channels: ChannelEntry[] = [];

messenger.on((message) => {
  switch (message.type) {
    case "channels/init":
      tabId = message.tabId;
      titleEl.textContent = message.title;
      channels = message.channels.map((entry) => ({
        name: entry.name ?? "",
        hex: normalizeHex(entry.data) ?? zeroHex(),
        numbers: toNumbers(entry.data)
      }));
      renderAll(true);
      break;
    case "channels/state":
      channels = message.channels.map((entry) => ({
        name: entry.name ?? "",
        hex: normalizeHex(entry.data) ?? zeroHex(),
        numbers: toNumbers(entry.data)
      }));
      renderAll(true);
      break;
  }
});

messenger.post({ type: "channels/ready" });

tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const target = button.dataset.tab as TabKey | undefined;
    if (!target || target === activeTab) {
      return;
    }
    if (!commitActiveTab()) {
      return;
    }
    setActiveTab(target);
  });
});

hexAdd.addEventListener("click", () => {
  addChannel();
});

numbersAdd.addEventListener("click", () => {
  addChannel();
});

cancelBtn.addEventListener("click", () => {
  messenger.post({ type: "channels/cancel", tabId });
});

saveBtn.addEventListener("click", () => {
  if (!commitActiveTab()) {
    return;
  }
  messenger.post({
    type: "channels/save",
    tabId,
    channels: channels.map((entry) => ({
      name: entry.name,
      data: entry.hex.toUpperCase()
    }))
  });
});

function setActiveTab(tab: TabKey): void {
  activeTab = tab;
  tabButtons.forEach((button) => {
    const isActive = button.dataset.tab === tab;
    button.classList.toggle("active", isActive);
  });
  (Object.keys(panels) as TabKey[]).forEach((key) => {
    panels[key].classList.toggle("active", key === tab);
  });
  renderActive();
}

function renderAll(force: boolean): void {
  if (force || activeTab === "json") {
    renderJson();
  }
  if (force || activeTab === "hex") {
    renderHex();
  }
  if (force || activeTab === "numbers") {
    renderNumbers();
  }
}

function renderActive(): void {
  if (activeTab === "json") {
    renderJson();
  } else if (activeTab === "hex") {
    renderHex();
  } else {
    renderNumbers();
  }
}

function renderJson(): void {
  clearErrors();
  const payload = channels.map((entry) => ({
    name: entry.name,
    data: entry.hex.toUpperCase()
  }));
  jsonEditor.value = JSON.stringify(payload, null, 2);
}

function renderHex(): void {
  clearErrors();
  hexTable.innerHTML = "";
  channels.forEach((entry, index) => {
    const row = document.createElement("div");
    row.className = "row";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = entry.name;
    nameInput.placeholder = `Channel${index + 1}`;

    const hexInput = document.createElement("textarea");
    hexInput.className = "hex-input";
    hexInput.value = formatHex(entry.hex);
    hexInput.spellcheck = false;
    hexInput.addEventListener("blur", () => {
      const cleaned = normalizeHex(hexInput.value);
      if (cleaned) {
        hexInput.value = formatHex(cleaned);
      }
    });

    row.append(nameInput, hexInput);
    hexTable.appendChild(row);
  });
}

function renderNumbers(): void {
  clearErrors();
  numbersTable.innerHTML = "";
  channels.forEach((entry, index) => {
    const row = document.createElement("div");
    row.className = "row";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = entry.name;
    nameInput.placeholder = `Channel${index + 1}`;

    const grid = document.createElement("div");
    grid.className = "numbers-grid";

    const values = entry.numbers.length === 32 ? entry.numbers : toNumbers(entry.hex);
    for (let i = 0; i < 32; i += 1) {
      const input = document.createElement("input");
      input.type = "text";
      input.inputMode = "decimal";
      input.value = formatNumber(values[i] ?? 0);
      grid.appendChild(input);
    }

    row.append(nameInput, grid);
    numbersTable.appendChild(row);
  });
}

function commitActiveTab(): boolean {
  clearErrors();
  if (activeTab === "json") {
    const parsed = parseJson();
    if (!parsed) {
      return false;
    }
    channels = parsed;
  } else if (activeTab === "hex") {
    const parsed = parseHexTable();
    if (!parsed) {
      return false;
    }
    channels = parsed;
  } else {
    const parsed = parseNumbersTable();
    if (!parsed) {
      return false;
    }
    channels = parsed;
  }
  return true;
}

function parseJson(): ChannelEntry[] | null {
  try {
    const raw = JSON.parse(jsonEditor.value) as unknown;
    if (!Array.isArray(raw)) {
      jsonError.textContent = "JSON must be an array of { name, data } objects.";
      return null;
    }
    const parsed: ChannelEntry[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") {
        jsonError.textContent = "Each entry must be an object with name and data.";
        return null;
      }
      const record = item as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name : "";
      const data = typeof record.data === "string" ? record.data : "";
      const cleaned = normalizeHex(data);
      if (!cleaned) {
        jsonError.textContent = "Each data value must be 256 hex characters.";
        return null;
      }
      parsed.push({ name, hex: cleaned, numbers: toNumbers(cleaned) });
    }
    return parsed;
  } catch {
    jsonError.textContent = "Invalid JSON.";
    return null;
  }
}

function parseHexTable(): ChannelEntry[] | null {
  const rows = Array.from(hexTable.querySelectorAll<HTMLDivElement>(".row"));
  const parsed: ChannelEntry[] = [];
  for (const row of rows) {
    const nameInput = row.querySelector<HTMLInputElement>("input");
    const hexInput = row.querySelector<HTMLTextAreaElement>("textarea");
    const name = nameInput?.value ?? "";
    const data = hexInput?.value ?? "";
    const cleaned = normalizeHex(data);
    if (!cleaned) {
      hexError.textContent = "Each row needs a 256-character hex string.";
      return null;
    }
    parsed.push({ name, hex: cleaned, numbers: toNumbers(cleaned) });
  }
  return parsed;
}

function parseNumbersTable(): ChannelEntry[] | null {
  const rows = Array.from(numbersTable.querySelectorAll<HTMLDivElement>(".row"));
  const parsed: ChannelEntry[] = [];
  for (const row of rows) {
    const nameInput = row.querySelector<HTMLInputElement>("input");
    const name = nameInput?.value ?? "";
    const cells = Array.from(row.querySelectorAll<HTMLInputElement>(".numbers-grid input"));
    if (cells.length !== 32) {
      numbersError.textContent = "Each channel needs 32 numbers.";
      return null;
    }
    const values: number[] = [];
    for (const cell of cells) {
      const value = parseNumber(cell.value);
      if (value === null) {
        numbersError.textContent = "All number cells must be valid numbers.";
        return null;
      }
      values.push(value);
    }
    const hex = vec32ToHex(new Float32Array(values));
    parsed.push({ name, hex, numbers: values });
  }
  return parsed;
}

function addChannel(): void {
  if (!commitActiveTab()) {
    return;
  }
  const index = channels.length + 1;
  const empty: ChannelEntry = {
    name: `Channel${index}`,
    hex: zeroHex(),
    numbers: new Array(32).fill(0)
  };
  channels = [...channels, empty];
  renderActive();
}

function normalizeHex(value: string): string | null {
  const cleaned = value.replace(/\s+/g, "");
  if (!HEX_256_RE.test(cleaned)) {
    return null;
  }
  return cleaned.toUpperCase();
}

function formatHex(hex: string): string {
  const bytes = hex.match(/.{1,2}/g) ?? [];
  return bytes.join(" ");
}

function toNumbers(hex: string): number[] {
  const cleaned = normalizeHex(hex);
  if (!cleaned) {
    return new Array(32).fill(0);
  }
  try {
    return Array.from(hexToVec32(cleaned));
  } catch {
    return new Array(32).fill(0);
  }
}

function zeroHex(): string {
  return vec32ToHex(new Float32Array(32));
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return String(value);
}

function parseNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function clearErrors(): void {
  jsonError.textContent = "";
  hexError.textContent = "";
  numbersError.textContent = "";
}
