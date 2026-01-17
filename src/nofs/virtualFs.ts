import * as path from "path";
import * as vscode from "vscode";
import { decryptNofsToJson, encryptJsonToNofs } from "./binary";

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
      const data = await vscode.workspace.fs.readFile(original);
      const jsonText = decryptNofsToJson(Buffer.from(data));
      return Buffer.from(jsonText, "utf8");
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
      const jsonText = Buffer.from(content).toString("utf8");
      const encrypted = encryptJsonToNofs(jsonText);
      await vscode.workspace.fs.writeFile(original, encrypted);
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

export function toVirtualUri(originalNofsUri: vscode.Uri): vscode.Uri {
  const baseName = path.basename(originalNofsUri.fsPath);
  const encoded = encodeBase64Url(originalNofsUri.fsPath);
  return vscode.Uri.from({
    scheme: "nofsjson",
    path: `/${baseName}.json`,
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
