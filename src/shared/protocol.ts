export interface StyleData {
  name: string;
  data: string;
  extra?: number;
}

export interface VBConfig {
  name: string;
  version: string;
  vendor: string;
  language: string;
  phoneset: string;
  support_languages: string[];
  base_model: string;
  sing_model: string;
  timing_model: string;
  f0_model: string;
  styles: StyleData[];
  pitch?: string;
  timing?: string;
}

export interface VBConfigEntry {
  id: string;
  path: string;
  config: VBConfig;
}

export interface MixerChannel {
  id: string;
  name: string;
  hex: string;
  weight: number;
  source?: {
    vbName?: string;
    styleName?: string;
    filePath?: string;
    version?: string;
    vendor?: string;
  };
}

export interface MixerTab {
  id: string;
  name?: string;
  outputName?: string;
  busPercent: number;
  channels: MixerChannel[];
}

export interface MixerState {
  activeTabId: string;
  tabs: MixerTab[];
}

export type GroupingMode = "name" | "vendor" | "base_model";

export type ExtensionToMixerMessage =
  | { type: "mixer/init"; state: MixerState }
  | { type: "mixer/state"; state: MixerState }
  | { type: "mixer/editor-state"; canExport: boolean }
  | { type: "mixer/notify"; kind: "info" | "error"; message: string };

export type MixerToExtensionMessage =
  | { type: "mixer/ready" }
  | { type: "mixer/state"; state: MixerState }
  | { type: "mixer/add-request" }
  | { type: "mixer/open-channel-editor"; tabId: string }
  | { type: "mixer/export-style"; name: string; hex: string }
  | { type: "mixer/copy-style"; name: string; hex: string };

export type ExtensionToModelsMessage =
  | {
      type: "models/init";
      configs: VBConfigEntry[];
      groupingMode: GroupingMode;
      canSaveActive: boolean;
    }
  | { type: "models/configs"; configs: VBConfigEntry[] }
  | { type: "models/grouping"; groupingMode: GroupingMode }
  | { type: "models/status"; canSaveActive: boolean }
  | { type: "models/notify"; kind: "info" | "error"; message: string };

export type ModelsToExtensionMessage =
  | { type: "models/ready" }
  | { type: "models/grouping"; groupingMode: GroupingMode }
  | { type: "models/request-reload" }
  | { type: "models/open-model-path" }
  | { type: "models/save-active-to-additional" }
  | { type: "models/generate-random" }
  | { type: "models/item-edit"; id: string }
  | { type: "models/item-view"; id: string }
  | { type: "models/item-delete"; id: string };
