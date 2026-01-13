import * as vscode from "vscode";
import { MixerState, MixerTab } from "../shared/protocol";

const MIXER_STATE_KEY = "vectorCalculator.mixerSession";

const DEFAULT_TAB_ID = "tab-1";

export const DEFAULT_MIXER_STATE: MixerState = {
  activeTabId: DEFAULT_TAB_ID,
  tabs: [
    {
      id: DEFAULT_TAB_ID,
      name: "",
      outputName: "",
      busPercent: 100,
      channels: []
    }
  ]
};

export class MixerSessionStore {
  constructor(private readonly memento: vscode.Memento) {}

  get(): MixerState {
    const stored = this.memento.get<MixerState>(MIXER_STATE_KEY);
    if (!stored || typeof stored !== "object") {
      return { ...DEFAULT_MIXER_STATE };
    }
    return sanitizeState(stored);
  }

  async set(state: MixerState): Promise<void> {
    await this.memento.update(MIXER_STATE_KEY, sanitizeState(state));
  }
}

function sanitizeState(state: MixerState): MixerState {
  const tabs = Array.isArray(state.tabs) ? state.tabs.map(sanitizeTab) : [];
  const nextTabs = tabs.length > 0 ? tabs : DEFAULT_MIXER_STATE.tabs.map((tab) => ({ ...tab }));
  const active =
    typeof state.activeTabId === "string"
      ? state.activeTabId
      : DEFAULT_MIXER_STATE.activeTabId;
  const activeTabId = nextTabs.some((tab) => tab.id === active)
    ? active
    : nextTabs[0].id;
  return {
    activeTabId,
    tabs: nextTabs
  };
}

function sanitizeTab(tab: MixerTab): MixerTab {
  const bus = Number.isFinite(tab.busPercent) ? tab.busPercent : 100;
  const channels = Array.isArray(tab.channels) ? tab.channels : [];
  return {
    id: typeof tab.id === "string" ? tab.id : createFallbackId(),
    name: typeof tab.name === "string" ? tab.name : "",
    outputName: typeof tab.outputName === "string" ? tab.outputName : "",
    busPercent: clamp(bus, 0, 500),
    channels: channels.map((channel) => ({
      id: typeof channel.id === "string" ? channel.id : createFallbackId(),
      name: typeof channel.name === "string" ? channel.name : "",
      hex: typeof channel.hex === "string" ? channel.hex : "",
      weight: clamp(channel.weight, -100, 100),
      source: channel.source
    }))
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function createFallbackId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
