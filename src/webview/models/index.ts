
import type {
  ExtensionToModelsMessage,
  GroupingMode,
  ModelsToExtensionMessage,
  VBConfigEntry
} from "../../shared/protocol.js";
import { byId } from "../common/base.js";
import { createMessenger } from "../common/messaging.js";

const messenger = createMessenger<ExtensionToModelsMessage, ModelsToExtensionMessage>();

const groupListEl = byId<HTMLDivElement>("groupList");
const emptyStateEl = byId<HTMLDivElement>("emptyState");
const searchInput = byId<HTMLInputElement>("searchInput");
const reloadBtn = byId<HTMLButtonElement>("reloadBtn");
const openPathBtn = byId<HTMLButtonElement>("openPathBtn");
const saveActiveBtn = byId<HTMLButtonElement>("saveActiveBtn");
const randomBtn = byId<HTMLButtonElement>("randomBtn");

const groupButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".group-btn")
);

let entries: VBConfigEntry[] = [];
let groupingMode: GroupingMode = "name";
let canSaveActive = false;
const openGroups = new Set<string>();

messenger.on((message) => {
  switch (message.type) {
    case "models/init":
      entries = message.configs;
      groupingMode = message.groupingMode;
      canSaveActive = message.canSaveActive;
      updateGroupButtons();
      updateSaveButton();
      render();
      break;
    case "models/configs":
      entries = message.configs;
      render();
      break;
    case "models/grouping":
      groupingMode = message.groupingMode;
      updateGroupButtons();
      render();
      break;
    case "models/status":
      canSaveActive = message.canSaveActive;
      updateSaveButton();
      break;
    case "models/notify":
      break;
  }
});

messenger.post({ type: "models/ready" });

groupButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const mode = button.dataset.mode as GroupingMode | undefined;
    if (!mode || mode === groupingMode) {
      return;
    }
    groupingMode = mode;
    updateGroupButtons();
    messenger.post({ type: "models/grouping", groupingMode });
    render();
  });
});

searchInput.addEventListener("input", () => {
  render();
});

reloadBtn.addEventListener("click", () => {
  messenger.post({ type: "models/request-reload" });
});

openPathBtn.addEventListener("click", () => {
  messenger.post({ type: "models/open-model-path" });
});

saveActiveBtn.addEventListener("click", () => {
  if (!canSaveActive) {
    return;
  }
  messenger.post({ type: "models/save-active-to-additional" });
});

randomBtn.addEventListener("click", () => {
  messenger.post({ type: "models/generate-random" });
});
function updateGroupButtons(): void {
  groupButtons.forEach((button) => {
    if (button.dataset.mode === groupingMode) {
      button.classList.add("active");
    } else {
      button.classList.remove("active");
    }
  });
}

function updateSaveButton(): void {
  saveActiveBtn.disabled = !canSaveActive;
  saveActiveBtn.classList.toggle("disabled", !canSaveActive);
}

function render(): void {
  const query = searchInput.value.trim().toLowerCase();
  const filtered = entries.filter((entry) => matchesSearch(entry, query));
  groupListEl.innerHTML = "";
  if (filtered.length === 0) {
    emptyStateEl.style.display = "block";
    return;
  }
  emptyStateEl.style.display = "none";
  if (groupingMode === "name") {
    renderByName(filtered);
  } else if (groupingMode === "vendor") {
    renderByVendor(filtered);
  } else {
    renderByBaseModel(filtered);
  }
}

function renderByName(list: VBConfigEntry[]): void {
  const groups = groupBy(list, (entry) => entry.config.name || "Unknown");
  const keys = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
  keys.forEach((key) => {
    const items = groups.get(key) ?? [];
    const groupKey = `name:${key}`;
    const details = createGroupDetails(key, groupKey);
    const ul = document.createElement("ul");
    ul.className = "group-items";
    items.sort((a, b) => (a.config.version || "").localeCompare(b.config.version || ""));
    items.forEach((entry) => {
      const version = entry.config.version || "?";
      const base = entry.config.base_model || "?";
      const label = `${version} [${base}]`;
      ul.appendChild(createEntryRow(entry, label));
    });
    details.appendChild(ul);
    groupListEl.appendChild(details);
  });
}

function renderByVendor(list: VBConfigEntry[]): void {
  const vendors = groupBy(list, (entry) => entry.config.vendor || "Unknown");
  const vendorKeys = Array.from(vendors.keys()).sort((a, b) => a.localeCompare(b));
  vendorKeys.forEach((vendor) => {
    const vendorKey = `vendor:${vendor}`;
    const details = createGroupDetails(vendor, vendorKey);
    const vendorList = vendors.get(vendor) ?? [];
    const names = groupBy(vendorList, (entry) => entry.config.name || "Unknown");
    const nameKeys = Array.from(names.keys()).sort((a, b) => a.localeCompare(b));
    nameKeys.forEach((name) => {
      const nameKey = `${vendorKey}|name:${name}`;
      const subDetails = createGroupDetails(name, nameKey);
      const ul = document.createElement("ul");
      ul.className = "group-items";
      const items = names.get(name) ?? [];
      items.sort((a, b) => (a.config.version || "").localeCompare(b.config.version || ""));
      items.forEach((entry) => {
        const version = entry.config.version || "?";
        const base = entry.config.base_model || "?";
        const label = `${version} [${base}]`;
        ul.appendChild(createEntryRow(entry, label));
      });
      subDetails.appendChild(ul);
      details.appendChild(subDetails);
    });
    groupListEl.appendChild(details);
  });
}

function renderByBaseModel(list: VBConfigEntry[]): void {
  const bases = groupBy(list, (entry) => entry.config.base_model || "Unknown");
  const baseKeys = Array.from(bases.keys()).sort((a, b) => a.localeCompare(b));
  baseKeys.forEach((base) => {
    const baseKey = `base:${base}`;
    const details = createGroupDetails(base, baseKey);
    const baseList = bases.get(base) ?? [];
    const names = groupBy(baseList, (entry) => entry.config.name || "Unknown");
    const nameKeys = Array.from(names.keys()).sort((a, b) => a.localeCompare(b));
    nameKeys.forEach((name) => {
      const nameKey = `${baseKey}|name:${name}`;
      const subDetails = createGroupDetails(name, nameKey);
      const ul = document.createElement("ul");
      ul.className = "group-items";
      const items = names.get(name) ?? [];
      items.sort((a, b) => (a.config.version || "").localeCompare(b.config.version || ""));
      items.forEach((entry) => {
        const version = entry.config.version || "?";
        const label = version;
        ul.appendChild(createEntryRow(entry, label));
      });
      subDetails.appendChild(ul);
      details.appendChild(subDetails);
    });
    groupListEl.appendChild(details);
  });
}

function groupBy(
  list: VBConfigEntry[],
  keyFn: (entry: VBConfigEntry) => string
): Map<string, VBConfigEntry[]> {
  const map = new Map<string, VBConfigEntry[]>();
  list.forEach((entry) => {
    const key = keyFn(entry);
    const existing = map.get(key) ?? [];
    existing.push(entry);
    map.set(key, existing);
  });
  return map;
}

function createGroupDetails(title: string, key: string): HTMLDetailsElement {
  const details = document.createElement("details");
  details.className = "group";
  details.open = openGroups.has(key);
  details.addEventListener("toggle", () => {
    if (details.open) {
      openGroups.add(key);
    } else {
      openGroups.delete(key);
    }
  });
  const summary = document.createElement("summary");
  summary.textContent = title;
  details.appendChild(summary);
  return details;
}

function createEntryRow(entry: VBConfigEntry, label: string): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "entry-row";

  const text = document.createElement("span");
  text.textContent = label;

  const actions = document.createElement("div");
  actions.className = "entry-actions";

  const editBtn = document.createElement("button");
  editBtn.className = "icon-btn";
  editBtn.title = "Edit";
  editBtn.innerHTML = `<img class="icon" src="${getIcon("edit")}" alt="Edit" />`;
  editBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    messenger.post({ type: "models/item-edit", id: entry.id });
  });

  const viewBtn = document.createElement("button");
  viewBtn.className = "icon-btn";
  viewBtn.title = "View";
  viewBtn.innerHTML = `<img class="icon" src="${getIcon("view")}" alt="View" />`;
  viewBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    messenger.post({ type: "models/item-view", id: entry.id });
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "icon-btn danger";
  deleteBtn.title = "Delete";
  deleteBtn.innerHTML = `<img class="icon" src="${getIcon("delete")}" alt="Delete" />`;
  deleteBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    messenger.post({ type: "models/item-delete", id: entry.id });
  });

  actions.append(editBtn, viewBtn, deleteBtn);
  li.append(text, actions);
  return li;
}

function matchesSearch(entry: VBConfigEntry, query: string): boolean {
  if (!query) {
    return true;
  }
  const haystack = [
    entry.config.name,
    entry.config.vendor,
    entry.config.language,
    entry.config.base_model,
    ...(Array.isArray(entry.config.styles) ? entry.config.styles.map((style) => style.name) : [])
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function getIcon(name: string): string {
  const base = document.body.dataset.mediaBase ?? "";
  return `${base}/icons/${name}.svg`;
}
