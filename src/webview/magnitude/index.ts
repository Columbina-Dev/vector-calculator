import { hexToVec32, setMagnitude, vec32ToHex } from "../../mixer/math.js";
import type { Messenger } from "../common/messaging.js";
import { byId } from "../common/base.js";
import { createMessenger } from "../common/messaging.js";

type InitPayload = {
  initial: number;
  range: number;
  hex: string;
  meta: {
    vbName?: string;
    version?: string;
    vendor?: string;
    styleName?: string;
  };
};

type IncomingMessage = { type: "init"; payload: InitPayload };
type OutgoingMessage =
  | { type: "ready" }
  | { type: "apply"; value: string }
  | { type: "cancel" };

const messenger: Messenger<IncomingMessage, OutgoingMessage> = createMessenger();

const slider = byId<HTMLInputElement>("magSlider");
const input = byId<HTMLInputElement>("magInput");
const applyBtn = byId<HTMLButtonElement>("applyBtn");
const cancelBtn = byId<HTMLButtonElement>("cancelBtn");
const errorEl = byId<HTMLDivElement>("magError");
const origHexEl = byId<HTMLDivElement>("origHex");
const nextHexEl = byId<HTMLDivElement>("nextHex");
const vbNameEl = byId<HTMLSpanElement>("vbName");
const vbVersionEl = byId<HTMLSpanElement>("vbVersion");
const vbVendorEl = byId<HTMLSpanElement>("vbVendor");
const styleNameEl = byId<HTMLSpanElement>("styleName");

let baseVec: Float32Array | null = null;

messenger.on((message) => {
  if (message.type !== "init") {
    return;
  }
  applyPayload(message.payload);
});

messenger.post({ type: "ready" });

slider.addEventListener("input", () => {
  input.value = slider.value;
  updatePreview();
});

input.addEventListener("input", () => {
  slider.value = input.value;
  updatePreview();
});

applyBtn.addEventListener("click", () => {
  const target = parseSignedNumber(input.value.trim());
  if (target === null) {
    errorEl.textContent = "Enter a valid magnitude.";
    return;
  }
  messenger.post({ type: "apply", value: input.value });
});

cancelBtn.addEventListener("click", () => {
  messenger.post({ type: "cancel" });
});

window.addEventListener("error", (event) => {
  errorEl.textContent = event.message || "Script error.";
});

function applyPayload(payload: InitPayload): void {
  const meta = payload.meta ?? {};
  vbNameEl.textContent = meta.vbName || "Unknown";
  vbVersionEl.textContent = meta.version || "Unknown";
  vbVendorEl.textContent = meta.vendor || "Unknown";
  styleNameEl.textContent = meta.styleName || "Unknown";

  const initial = Number.isFinite(payload.initial) ? payload.initial : 0;
  const range = Math.max(10, Math.ceil(Math.abs(payload.range || 10)));
  slider.min = (-range).toString();
  slider.max = range.toString();
  slider.step = "0.01";
  slider.value = initial.toFixed(3);
  input.value = initial.toFixed(3);

  try {
    baseVec = hexToVec32(payload.hex);
    errorEl.textContent = "";
  } catch {
    baseVec = null;
    errorEl.textContent = "Invalid hex data.";
  }

  origHexEl.textContent = formatHex(payload.hex || "");
  updatePreview();
}

function updatePreview(): void {
  if (!baseVec) {
    return;
  }
  const target = parseSignedNumber(input.value.trim());
  if (target === null) {
    errorEl.textContent = "Enter a valid magnitude.";
    return;
  }
  errorEl.textContent = "";
  const next = setMagnitude(baseVec, target);
  const nextHex = vec32ToHex(next);
  nextHexEl.textContent = formatHex(nextHex);
}

function parseSignedNumber(value: string): number | null {
  if (!value) {
    return null;
  }
  const num = Number(value);
  if (Number.isNaN(num)) {
    return null;
  }
  if (num === 0 && value.trim().startsWith("-")) {
    return -0;
  }
  return num;
}

function formatHex(hex: string): string {
  const bytes = hex.match(/.{1,2}/g) || [];
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    lines.push(bytes.slice(i, i + 16).join(" "));
  }
  return lines.join("\n");
}
