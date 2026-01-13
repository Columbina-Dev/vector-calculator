import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { buildCsp } from "./shared/csp";

export interface WebviewTemplate {
  htmlPath: string[];
  scriptPath: string[];
  stylePath: string[];
}

export function renderWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  template: WebviewTemplate
): string {
  const nonce = createNonce();
  const htmlPath = path.join(extensionUri.fsPath, ...template.htmlPath);
  const html = fs.readFileSync(htmlPath, "utf8");
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...template.scriptPath));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...template.stylePath));
  const mediaBase = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media"));
  const csp = buildCsp(webview.cspSource, nonce);

  return html
    .replace(/{{csp}}/g, csp)
    .replace(/{{nonce}}/g, nonce)
    .replace(/{{scriptUri}}/g, scriptUri.toString())
    .replace(/{{styleUri}}/g, styleUri.toString())
    .replace(/{{mediaBase}}/g, mediaBase.toString());
}

function createNonce(): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i += 1) {
    nonce += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return nonce;
}
