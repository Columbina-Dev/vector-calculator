import * as crypto from "crypto";

const HEADER_TEMPLATE_HEX =
  "80F500000A0000000000000000000000440000000010E633BABA5400000000000000024C86BE7600000000000000245C5C699500000000000000A03A9696B000000000000000000000000000000000004400000022000000010012002E666561747572655F66305F7669626D6F6400000000220000001F00000001000F002E666561747572655F66305F6F726E000000001F0000001B00000001000B0066306D6F64656C2D646473000000001B00000028100000010004007E7F7F7F14100000";

const HEADER_SIZE = 192;
const SVDB_MAGIC = Buffer.from("SVDB", "ascii");
const KEY = Buffer.from(
  "9ace85bf9f6e4cde2f5ad2fff38bebcf8e85368749f294e9ef99c1d7542812fe",
  "hex"
);
const HEX8_RE = /^[0-9a-fA-F]{8}$/;

export function encryptJsonToNofs(jsonTextUtf8: string): Buffer {
  const transformed = transformJsonForEncrypt(jsonTextUtf8);
  const plaintext = Buffer.from(transformed, "utf8");
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const svdbLength = 20 + ciphertext.length;
  const header = buildHeader(svdbLength);
  const trailer = Buffer.alloc(4);
  trailer.writeUInt32LE(svdbLength + 20, 0);
  return Buffer.concat([header, SVDB_MAGIC, iv, ciphertext, trailer]);
}

export function decryptNofsToJson(nofsBytes: Buffer): string {
  if (nofsBytes.length < HEADER_SIZE + 4 + 16 + 4) {
    throw new Error("Invalid NOFS file size.");
  }
  const magic = nofsBytes.subarray(HEADER_SIZE, HEADER_SIZE + 4);
  if (!magic.equals(SVDB_MAGIC)) {
    throw new Error("Missing SVDB header.");
  }
  const ivStart = HEADER_SIZE + 4;
  const iv = nofsBytes.subarray(ivStart, ivStart + 16);
  const ciphertext = nofsBytes.subarray(ivStart + 16, nofsBytes.length - 4);
  const svdbLength = 20 + ciphertext.length;
  const headerSvdb = nofsBytes.readUInt32LE(0xbc);
  const headerTotal = nofsBytes.readUInt32LE(0xb0);
  const trailer = nofsBytes.readUInt32LE(nofsBytes.length - 4);
  if (headerSvdb !== svdbLength || headerTotal !== svdbLength + 20 || trailer !== svdbLength + 20) {
    throw new Error("NOFS length fields mismatch.");
  }
  const decipher = crypto.createDecipheriv("aes-256-cbc", KEY, iv);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  return transformJsonForDecrypt(plaintext);
}

export function floatToHexLE(value: number): string {
  const buffer = Buffer.alloc(4);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  view.setFloat32(0, value, true);
  return buffer.toString("hex").toUpperCase();
}

export function hexToFloatLE(hex8: string): number {
  if (!HEX8_RE.test(hex8)) {
    throw new Error("Invalid float hex.");
  }
  const buffer = Buffer.from(hex8, "hex");
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return view.getFloat32(0, true);
}

function buildHeader(svdbLength: number): Buffer {
  const template = Buffer.from(HEADER_TEMPLATE_HEX, "hex");
  if (template.length !== HEADER_SIZE) {
    throw new Error("Invalid NOFS header template.");
  }
  const header = Buffer.from(template);
  header.writeUInt32LE(svdbLength + 20, 0xb0);
  header.writeUInt32LE(svdbLength, 0xbc);
  return header;
}

function transformJsonForEncrypt(jsonText: string): string {
  const parsed = JSON.parse(jsonText) as unknown;
  const transformed = transformValueForEncrypt(parsed);
  return JSON.stringify(transformed);
}

function transformJsonForDecrypt(jsonText: string): string {
  const parsed = JSON.parse(jsonText) as unknown;
  const transformed = transformValueForDecrypt(parsed);
  return JSON.stringify(transformed);
}

function transformValueForEncrypt(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => transformValueForEncrypt(entry));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const out: Record<string, unknown> = {};
  const hasPitch = Object.prototype.hasOwnProperty.call(record, "pitch_model");
  for (const key of keys) {
    if (key === "sing_model") {
      if (hasPitch) {
        continue;
      }
      out.pitch_model = transformValueForEncrypt(record[key]);
      continue;
    }
    if (key === "styles" && Array.isArray(record[key])) {
      out.styles = (record[key] as unknown[]).map((entry) =>
        transformStyleForEncrypt(entry)
      );
      continue;
    }
    out[key] = transformValueForEncrypt(record[key]);
  }
  return out;
}

function transformStyleForEncrypt(value: unknown): unknown {
  if (!isPlainObject(value)) {
    return transformValueForEncrypt(value);
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key === "extra") {
      const extra = record[key];
      if (typeof extra === "number" && Number.isFinite(extra)) {
        out.extra = floatToHexLE(extra);
        continue;
      }
      if (typeof extra === "string" && HEX8_RE.test(extra)) {
        out.extra = extra.toUpperCase();
        continue;
      }
      out.extra = extra;
      continue;
    }
    out[key] = transformValueForEncrypt(record[key]);
  }
  return out;
}

function transformValueForDecrypt(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => transformValueForDecrypt(entry));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const out: Record<string, unknown> = {};
  const hasSing = Object.prototype.hasOwnProperty.call(record, "sing_model");
  for (const key of keys) {
    if (key === "pitch_model") {
      if (hasSing) {
        continue;
      }
      out.sing_model = transformValueForDecrypt(record[key]);
      continue;
    }
    if (key === "styles" && Array.isArray(record[key])) {
      out.styles = (record[key] as unknown[]).map((entry) =>
        transformStyleForDecrypt(entry)
      );
      continue;
    }
    out[key] = transformValueForDecrypt(record[key]);
  }
  return out;
}

function transformStyleForDecrypt(value: unknown): unknown {
  if (!isPlainObject(value)) {
    return transformValueForDecrypt(value);
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key === "extra") {
      const extra = record[key];
      if (typeof extra === "string" && HEX8_RE.test(extra)) {
        out.extra = hexToFloatLE(extra);
        continue;
      }
      out.extra = transformValueForDecrypt(extra);
      continue;
    }
    out[key] = transformValueForDecrypt(record[key]);
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
