import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { parse, ParseError } from "jsonc-parser";
import { VBConfig, VBConfigEntry } from "../shared/protocol";

export interface LoadResult {
  entries: VBConfigEntry[];
  errors: string[];
}

export class VBConfigLoader {
  private entries: VBConfigEntry[] = [];
  private errors: string[] = [];

  getEntries(): VBConfigEntry[] {
    return this.entries;
  }

  getErrors(): string[] {
    return this.errors;
  }

  getEntryById(id: string): VBConfigEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  async reload(modelDataPath: string): Promise<LoadResult> {
    const resolvedPaths = [path.resolve(modelDataPath)];
    const jsonFiles: string[] = [];
    const errors: string[] = [];

    for (const configPath of resolvedPaths) {
      try {
        const stat = await fs.promises.stat(configPath);
        if (stat.isDirectory()) {
          await scanDir(configPath, jsonFiles);
        } else if (stat.isFile() && configPath.toLowerCase().endsWith(".nofs.json")) {
          jsonFiles.push(configPath);
        }
      } catch (error) {
        errors.push(`Failed to read ${configPath}: ${(error as Error).message}`);
      }
    }

    const entries: VBConfigEntry[] = [];
    for (const filePath of jsonFiles) {
      try {
        const raw = await fs.promises.readFile(filePath, "utf8");
        const parseErrors: ParseError[] = [];
        const data = parse(raw, parseErrors, { allowTrailingComma: true }) as VBConfig;
        if (parseErrors.length > 0 || !data) {
          throw new Error("Invalid JSON format.");
        }
        entries.push({
          id: hashId(filePath),
          path: filePath,
          config: data
        });
      } catch (error) {
        errors.push(`Failed to parse ${filePath}: ${(error as Error).message}`);
      }
    }

    this.entries = entries.sort((a, b) =>
      (a.config.name || "").localeCompare(b.config.name || "")
    );
    this.errors = errors;

    return { entries: this.entries, errors: this.errors };
  }
}

async function scanDir(root: string, results: string[]): Promise<void> {
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await scanDir(fullPath, results);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".nofs.json")) {
      results.push(fullPath);
    }
  }
}

function hashId(value: string): string {
  return crypto.createHash("sha1").update(value).digest("hex");
}
