export function buildCsp(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    `style-src ${cspSource}`,
    `font-src ${cspSource} data:`,
    `script-src ${cspSource} 'nonce-${nonce}'`,
    `connect-src ${cspSource}`
  ].join("; ");
}
