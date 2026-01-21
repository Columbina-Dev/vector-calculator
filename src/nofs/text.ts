import { applyEdits, format, parse, ParseError } from "jsonc-parser";

export interface NofsMeta {
  name?: string;
  version?: string;
}

export function stripJsoncComments(input: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  let escape = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = i + 1 < input.length ? input[i + 1] : "";

    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }

    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      out += ch;
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      inLine = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    out += ch;
  }

  return out;
}

export function extractJsonObject(input: string): string {
  const text = input.trim();
  let inString = false;
  let quote = "";
  let escape = false;
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }
    if (ch === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          return text.slice(start, i + 1);
        }
      }
    }
  }

  return text;
}

export function prepareNofsJsonText(input: string): string {
  const stripped = stripJsoncComments(input);
  return extractJsonObject(stripped);
}

export function formatJsoncText(input: string): string {
  try {
    const edits = format(input, undefined, {
      insertSpaces: true,
      tabSize: 2,
      eol: "\n"
    });
    return applyEdits(input, edits);
  } catch {
    return input;
  }
}

export function parseNofsMeta(input: string): NofsMeta {
  const text = prepareNofsJsonText(input);
  const errors: ParseError[] = [];
  const data = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !data || typeof data !== "object" || Array.isArray(data)) {
    return {};
  }
  const record = data as Record<string, unknown>;
  return {
    name: typeof record.name === "string" ? record.name : undefined,
    version: typeof record.version === "string" ? record.version : undefined
  };
}

export function canonicalizeJsonText(input: string): string | null {
  const errors: ParseError[] = [];
  const data = parse(input, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    return null;
  }
  try {
    return JSON.stringify(data);
  } catch {
    return null;
  }
}
