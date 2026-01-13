import * as assert from "assert";
import { normalizeNofsConfig, validateNofsData } from "../src/nofs/validate";

function validConfig() {
  return {
    name: "Test VB",
    version: "200a0",
    vendor: "Test Vendor",
    language: "English",
    phoneset: "arpabet",
    support_languages: ["english", "spanish"],
    base_model: "0cc8e47f4cbc55274c8af9ddd3b99952",
    sing_model: "1a83aa71cb09e94bb8171a4f34d22cac",
    timing_model: "1537c807a892bb00136c22a8edce6b64",
    f0_model: "074caf0d79b926635bb8c1c36d2c0a36",
    styles: [
      { name: "Soft", data: "A".repeat(256) },
      { name: "Power", data: "B".repeat(256) }
    ],
    pitch: "C".repeat(256),
    timing: "D".repeat(1024)
  };
}

describe("NOFS validation", () => {
  it("accepts a valid config", () => {
    const normalized = normalizeNofsConfig(validConfig());
    const result = validateNofsData(normalized);
    assert.strictEqual(result.errors.length, 0);
  });

  it("rejects invalid language", () => {
    const config = validConfig();
    config.language = "klingon";
    const result = validateNofsData(config);
    assert.ok(result.errors.some((issue) => issue.message.includes("language")));
  });

  it("rejects mismatched phoneset", () => {
    const config = validConfig();
    config.phoneset = "xsampa";
    const result = validateNofsData(config);
    assert.ok(result.errors.some((issue) => issue.message.includes("phoneset")));
  });

  it("flags duplicate style names", () => {
    const config = validConfig();
    config.styles = [
      { name: "Soft", data: "A".repeat(256) },
      { name: "Soft", data: "B".repeat(256) }
    ];
    const result = validateNofsData(config);
    assert.ok(result.errors.some((issue) => issue.message.includes("Duplicate style")));
  });

  it("flags invalid style data length", () => {
    const config = validConfig();
    config.styles = [{ name: "Soft", data: "A".repeat(10) }];
    const result = validateNofsData(config);
    assert.ok(result.errors.some((issue) => issue.message.includes("256 hex")));
  });

  it("warns on unknown keys", () => {
    const config = validConfig() as Record<string, unknown>;
    config.unknown_key = "oops";
    const result = validateNofsData(config);
    assert.ok(result.warnings.some((issue) => issue.message.includes("Unknown key")));
  });

  it("requires pitch", () => {
    const config = validConfig() as Record<string, unknown>;
    delete config.pitch;
    const result = validateNofsData(config);
    assert.ok(result.errors.some((issue) => issue.message.includes("\"pitch\"")));
  });

  it("requires timing", () => {
    const config = validConfig() as Record<string, unknown>;
    delete config.timing;
    const result = validateNofsData(config);
    assert.ok(result.errors.some((issue) => issue.message.includes("\"timing\"")));
  });

  it("rejects invalid version format", () => {
    const config = validConfig();
    config.version = "v2";
    const result = validateNofsData(config);
    assert.ok(result.errors.some((issue) => issue.message.includes("version")));
  });
});
