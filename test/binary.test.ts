import { strict as assert } from "assert";
import { decryptNofsToJson, encryptJsonToNofs } from "../src/nofs/binary";

describe("nofs binary", () => {
  it("roundtrips json with model and extra transforms", () => {
    const jsonText = JSON.stringify({
      name: "Test",
      sing_model: "abc123",
      styles: [
        {
          name: "Style1",
          data: "00".repeat(128),
          extra: 0.5
        }
      ]
    });
    const encrypted = encryptJsonToNofs(jsonText);
    const decrypted = decryptNofsToJson(encrypted);
    const parsed = JSON.parse(decrypted) as {
      sing_model?: string;
      pitch_model?: string;
      styles: Array<{ extra?: number | string }>;
    };
    assert.equal(parsed.sing_model, "abc123");
    assert.equal(parsed.pitch_model, undefined);
    assert.equal(typeof parsed.styles[0].extra, "number");
    assert.equal(parsed.styles[0].extra, 0.5);
  });

  it("writes consistent header and trailer lengths", () => {
    const jsonText = JSON.stringify({ name: "Header", styles: [] });
    const encrypted = encryptJsonToNofs(jsonText);
    const headerSize = 192;
    const magic = encrypted.subarray(headerSize, headerSize + 4).toString("ascii");
    assert.equal(magic, "SVDB");
    const ciphertextLength = encrypted.length - headerSize - 4 - 16 - 4;
    const svdbLength = 20 + ciphertextLength;
    const headerTotal = encrypted.readUInt32LE(0xb0);
    const headerSvdb = encrypted.readUInt32LE(0xbc);
    const trailer = encrypted.readUInt32LE(encrypted.length - 4);
    assert.equal(headerSvdb, svdbLength);
    assert.equal(headerTotal, svdbLength + 20);
    assert.equal(trailer, svdbLength + 20);
  });
});
