import * as vscode from "vscode";
import { findNodeAtLocation, parse, parseTree, ParseError } from "jsonc-parser";
import { VBConfig } from "../shared/protocol";

export type IssueSeverity = "error" | "warning";

export interface ValidationIssue {
  message: string;
  severity: IssueSeverity;
  path?: Array<string | number>;
}

export interface ValidationResult {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export const ALLOWED_LANGUAGES = new Set([
  "japanese",
  "english",
  "mandarin",
  "cantonese",
  "spanish"
]);

export const PHONESET_BY_LANGUAGE = new Map<string, string>([
  ["japanese", "romaji"],
  ["english", "arpabet"],
  ["mandarin", "xsampa"],
  ["cantonese", "xsampa"],
  ["spanish", "xsampa"]
]);

export const ALLOWED_SING_MODEL = new Set([
  "1a83aa71cb09e94bb8171a4f34d22cac",
  "2a73920b4208f2d5ba53bced8a528a14",
  "35222088c37134c7629d6873c0386d8d",
  "3f649ae6cb04ee4f7e9a7ed72ee29928",
  "4f4bf0c0ae33571c79e21b1c25993e15",
  "76d1e71c936b82714d0ead9628903355",
  "92e5ef5b10e68bef3c1fb03c880e6be2",
  "b0dbc93ad9636601a8a24425788a884e"
]);

export const ALLOWED_BASE_MODEL = new Set([
  "0cc8e47f4cbc55274c8af9ddd3b99952",
  "2c233d8e9b19f1f4dc0276ba3a5542c1",
  "6e5da191faa421a20b529b40c3aa4968",
  "a0a5cc5b70b4e3a3fe5eb071ab70c614",
  "a174a445b871f7030c06cbe274c13389",
  "bcef8d939a3650f86de9c302b9f4056d",
  "ca6345d21bfd023c1b15203883a431a8",
  "dad774b887823741dac345c0d9915628",
  "e6e3e69c5e1adc6d11cf8fae282c2f6b",
  "e9d97f23d28c3fd45d7cb8a9671b234d",
  "ef3c4c606a7c4b0668fdd31f493081ee",
  "f98eefe8922c4a7adad07e4d152d039b"
]);

export const ALLOWED_TIMING_MODEL = new Set([
  "1537c807a892bb00136c22a8edce6b64",
  "23c6a5b548be9b9213b265d7f9f5c03b",
  "301264b6f8f7486759f0148d2b746dd2",
  "33d9aff20e1dc7f1e381cf4594a10429",
  "77aa9ba5b60e41fa11b9ad45f2862cb8",
  "7b0ea690ada94b4484b50d9d64a21cae",
  "7c291fdb51d0272da213c0fcb22f41f7",
  "9c539330eb7536195947ddf988515128",
  "a04629a795e8398ff0ab6baa9ffc04e0",
  "b6f4d2a1af8be8fb2b6c1d2ebdb0ce10"
]);

export const ALLOWED_F0_MODEL = new Set([
  "074caf0d79b926635bb8c1c36d2c0a36",
  "2c80cc20997ce222724d41faf44d0917",
  "4f6aff3f6430407dd436a88a29121777",
  "6316b70ba33c5e2446ec34100a678f98",
  "a4d108b4c61c9ca18f4f8cd297968a90",
  "a59fb01761a71d193e4afbd559bc4e6e",
  "a9db2025114e13e294bf89461d8515a7",
  "dcee89442f69984189a5b2aedbf9f090",
  "ef62a18bec034f62c75d7428757757bf",
  "f3a5378c141a1af88a311055fad488fb"
]);

const TOP_LEVEL_KEYS = new Set([
  "name",
  "version",
  "vendor",
  "language",
  "phoneset",
  "support_languages",
  "base_model",
  "sing_model",
  "timing_model",
  "f0_model",
  "styles",
  "pitch",
  "timing"
]);

const STYLE_KEYS = new Set(["name", "data", "extra"]);

export function normalizeNofsConfig(config: VBConfig): VBConfig {
  const normalizedLanguage = config.language.toLowerCase();
  const expectedPhoneset = PHONESET_BY_LANGUAGE.get(normalizedLanguage);
  return {
    ...config,
    language: normalizedLanguage,
    support_languages: config.support_languages.map((lang) => lang.toLowerCase()),
    phoneset: expectedPhoneset ?? config.phoneset,
    styles: config.styles.map((style) => ({
      ...style,
      data: style.data.toUpperCase()
    })),
    pitch: config.pitch ? config.pitch.toUpperCase() : undefined,
    timing: config.timing ? config.timing.toUpperCase() : undefined
  };
}

export function validateNofsData(data: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!isObject(data)) {
    errors.push({ message: "Root value must be an object.", severity: "error" });
    return { errors, warnings };
  }

  const obj = data as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      warnings.push({
        message: `Unknown key "${key}".`,
        severity: "warning",
        path: [key]
      });
    }
  }

  requireString(obj, "name", errors);
  requireString(obj, "vendor", errors);
  requireString(obj, "phoneset", errors);
  validateVersion(obj.version, errors);
  validateLanguage(obj.language, errors, ["language"]);
  validateSupportLanguages(obj.support_languages, errors, ["support_languages"]);
  validatePhoneset(obj.language, obj.phoneset, errors);
  validateModelId(obj.sing_model, ALLOWED_SING_MODEL, "sing_model", errors);
  validateModelId(obj.base_model, ALLOWED_BASE_MODEL, "base_model", errors);
  validateModelId(obj.timing_model, ALLOWED_TIMING_MODEL, "timing_model", errors);
  validateModelId(obj.f0_model, ALLOWED_F0_MODEL, "f0_model", errors);
  validateStyles(obj.styles, errors, warnings);

  if (obj.pitch === undefined) {
    errors.push({
      message: "\"pitch\" is required.",
      severity: "error",
      path: ["pitch"]
    });
  } else {
    validateHex(obj.pitch, 256, errors, ["pitch"]);
  }

  if (obj.timing === undefined) {
    errors.push({
      message: "\"timing\" is required.",
      severity: "error",
      path: ["timing"]
    });
  } else {
    validateHex(obj.timing, 1024, errors, ["timing"]);
  }

  return { errors, warnings };
}

export function getNofsDiagnostics(document: vscode.TextDocument): vscode.Diagnostic[] {
  const text = document.getText();
  const parseErrors: ParseError[] = [];
  const treeErrors: ParseError[] = [];
  const data = parse(text, parseErrors, { allowTrailingComma: true });
  const root = parseTree(text, treeErrors, { allowTrailingComma: true });
  const diagnostics: vscode.Diagnostic[] = [];

  for (const error of [...parseErrors, ...treeErrors]) {
    const range = rangeFromOffset(document, error.offset, error.length);
    diagnostics.push(
      new vscode.Diagnostic(
        range,
        "Invalid JSON syntax.",
        vscode.DiagnosticSeverity.Error
      )
    );
  }

  if (!root) {
    return diagnostics;
  }

  const { errors, warnings } = validateNofsData(data);
  for (const issue of [...errors, ...warnings]) {
    const range = issue.path
      ? rangeFromIssuePath(root, issue.path, document)
      : rangeFromOffset(document, 0, 1);
    const severity =
      issue.severity === "error"
        ? vscode.DiagnosticSeverity.Error
        : vscode.DiagnosticSeverity.Warning;
    diagnostics.push(new vscode.Diagnostic(range, issue.message, severity));
  }

  return diagnostics;
}

function rangeFromIssuePath(
  root: ReturnType<typeof parseTree>,
  path: Array<string | number>,
  document: vscode.TextDocument
): vscode.Range {
  if (!root) {
    return rangeFromOffset(document, 0, 1);
  }
  const node = findNodeAtLocation(root, path);
  if (!node) {
    return rangeFromOffset(document, 0, 1);
  }
  return rangeFromOffset(document, node.offset, node.length);
}

function rangeFromOffset(
  document: vscode.TextDocument,
  offset: number,
  length: number
): vscode.Range {
  const start = document.positionAt(offset);
  const end = document.positionAt(offset + Math.max(length, 1));
  return new vscode.Range(start, end);
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  errors: ValidationIssue[]
): void {
  const value = obj[key];
  if (typeof value !== "string") {
    errors.push({
      message: `"${key}" must be a string.`,
      severity: "error",
      path: [key]
    });
  }
}

function validateVersion(value: unknown, errors: ValidationIssue[]): void {
  if (typeof value !== "string") {
    errors.push({
      message: "\"version\" must be a string.",
      severity: "error",
      path: ["version"]
    });
    return;
  }
  const match = /^(\d+)(?:([ab])(\d+))?$/.exec(value);
  if (!match) {
    errors.push({
      message: "\"version\" must match <int>[a|b<int>].",
      severity: "error",
      path: ["version"]
    });
    return;
  }
  const main = Number.parseInt(match[1], 10);
  const branch = match[3] ? Number.parseInt(match[3], 10) : 0;
  if (!Number.isInteger(main) || main < 0 || !Number.isInteger(branch) || branch < 0) {
    errors.push({
      message: "\"version\" must contain non-negative integers.",
      severity: "error",
      path: ["version"]
    });
  }
}

function validateLanguage(
  value: unknown,
  errors: ValidationIssue[],
  path: Array<string | number>
): void {
  if (typeof value !== "string") {
    errors.push({
      message: "\"language\" must be a string.",
      severity: "error",
      path
    });
    return;
  }
  const normalized = value.toLowerCase();
  if (!ALLOWED_LANGUAGES.has(normalized)) {
    errors.push({
      message: `"language" must be one of: ${Array.from(ALLOWED_LANGUAGES).join(
        ", "
      )}.`,
      severity: "error",
      path
    });
  }
}

function validatePhoneset(
  language: unknown,
  phoneset: unknown,
  errors: ValidationIssue[]
): void {
  if (typeof language !== "string") {
    return;
  }
  const normalizedLanguage = language.toLowerCase();
  const expected = PHONESET_BY_LANGUAGE.get(normalizedLanguage);
  if (!expected) {
    return;
  }
  if (typeof phoneset !== "string") {
    errors.push({
      message: "\"phoneset\" must be a string.",
      severity: "error",
      path: ["phoneset"]
    });
    return;
  }
  if (phoneset.toLowerCase() !== expected) {
    errors.push({
      message: `"phoneset" must be "${expected}" when language is "${normalizedLanguage}".`,
      severity: "error",
      path: ["phoneset"]
    });
  }
}

function validateSupportLanguages(
  value: unknown,
  errors: ValidationIssue[],
  path: Array<string | number>
): void {
  if (!Array.isArray(value)) {
    errors.push({
      message: "\"support_languages\" must be an array.",
      severity: "error",
      path
    });
    return;
  }
  value.forEach((entry, index) => {
    if (typeof entry !== "string") {
      errors.push({
        message: "support_languages entries must be strings.",
        severity: "error",
        path: [...path, index]
      });
      return;
    }
    const normalized = entry.toLowerCase();
    if (!ALLOWED_LANGUAGES.has(normalized)) {
      errors.push({
        message: `"support_languages" must be one of: ${Array.from(ALLOWED_LANGUAGES).join(
          ", "
        )}.`,
        severity: "error",
        path: [...path, index]
      });
    }
  });
}

function validateModelId(
  value: unknown,
  allowed: Set<string>,
  key: string,
  errors: ValidationIssue[]
): void {
  if (typeof value !== "string") {
    errors.push({
      message: `"${key}" must be a string.`,
      severity: "error",
      path: [key]
    });
    return;
  }
  if (!allowed.has(value)) {
    errors.push({
      message: `"${key}" must be one of the approved IDs.`,
      severity: "error",
      path: [key]
    });
  }
}

function validateStyles(
  value: unknown,
  errors: ValidationIssue[],
  warnings: ValidationIssue[]
): void {
  if (!Array.isArray(value)) {
    errors.push({
      message: "\"styles\" must be an array.",
      severity: "error",
      path: ["styles"]
    });
    return;
  }
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (!isObject(entry)) {
      errors.push({
        message: "Each style entry must be an object.",
        severity: "error",
        path: ["styles", index]
      });
      return;
    }
    const style = entry as Record<string, unknown>;
    for (const key of Object.keys(style)) {
      if (!STYLE_KEYS.has(key)) {
        warnings.push({
          message: `Unknown style key "${key}".`,
          severity: "warning",
          path: ["styles", index, key]
        });
      }
    }
    const name = style.name;
    if (typeof name !== "string") {
      errors.push({
        message: "style.name must be a string.",
        severity: "error",
        path: ["styles", index, "name"]
      });
    } else {
      if (name.includes(" ")) {
        errors.push({
          message: "style.name cannot contain spaces.",
          severity: "error",
          path: ["styles", index, "name"]
        });
      }
      if (seen.has(name)) {
        errors.push({
          message: `Duplicate style name "${name}".`,
          severity: "error",
          path: ["styles", index, "name"]
        });
      }
      seen.add(name);
    }
    const data = style.data;
    if (!validateHex(data, 256, errors, ["styles", index, "data"])) {
      return;
    }
  });
}

function validateHex(
  value: unknown,
  length: number,
  errors: ValidationIssue[],
  path: Array<string | number>
): boolean {
  if (typeof value !== "string") {
    errors.push({
      message: "Hex value must be a string.",
      severity: "error",
      path
    });
    return false;
  }
  const re = new RegExp(`^[0-9a-fA-F]{${length}}$`);
  if (!re.test(value)) {
    errors.push({
      message: `Hex value must be exactly ${length} hex characters.`,
      severity: "error",
      path
    });
    return false;
  }
  return true;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
