import * as fs from "fs";
import * as path from "path";
import { NofsMeta } from "./text";

export interface BackupOptions {
  enabled: boolean;
  maxCount: number;
  dir: string;
}

export async function maybeBackupNofsFile(
  targetPath: string,
  meta: NofsMeta,
  options: BackupOptions
): Promise<void> {
  if (!options.enabled) {
    return;
  }
  if (!meta.name || !meta.version) {
    return;
  }
  if (!fs.existsSync(targetPath)) {
    return;
  }

  const safeName = sanitizeBackupName(meta.name);
  const version = sanitizeBackupName(meta.version);
  const timestamp = formatTimestamp(new Date());
  const dir = options.dir;
  const maxCount = clamp(options.maxCount, 1, 10);

  await fs.promises.mkdir(dir, { recursive: true });
  const backupName = `${safeName}-${version}-${timestamp}.nofs`;
  const backupPath = path.join(dir, backupName);
  await fs.promises.copyFile(targetPath, backupPath);

  await pruneBackups(dir, safeName, version, maxCount);
}

async function pruneBackups(
  dir: string,
  name: string,
  version: string,
  maxCount: number
): Promise<void> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const prefix = `${name}-${version}-`;
  const backups = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".nofs"))
    .map((entry) => entry.name);

  if (backups.length <= maxCount) {
    return;
  }

  const stats = await Promise.all(
    backups.map(async (file) => {
      const fullPath = path.join(dir, file);
      const stat = await fs.promises.stat(fullPath);
      return { file, time: stat.mtimeMs };
    })
  );

  stats.sort((a, b) => a.time - b.time);
  const toDelete = stats.slice(0, Math.max(0, stats.length - maxCount));
  await Promise.all(
    toDelete.map((entry) => fs.promises.unlink(path.join(dir, entry.file)))
  );
}

function sanitizeBackupName(value: string): string {
  return value.replace(/\s+/g, "_").replace(/[<>:"/\\|?*]/g, "_").trim() || "item";
}

function formatTimestamp(date: Date): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}
