export function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element: ${id}`);
  }
  return element as T;
}

export function qs<T extends Element>(selector: string, root: ParentNode = document): T {
  const element = root.querySelector(selector);
  if (!element) {
    throw new Error(`Missing selector: ${selector}`);
  }
  return element as T;
}

export function setText(element: Element, text: string): void {
  element.textContent = text;
}
