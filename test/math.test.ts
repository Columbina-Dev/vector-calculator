import * as assert from "assert";
import { applyBus, hexToVec32, mixVectors, setMagnitude, vec32ToHex } from "../src/mixer/math";

describe("mixer math", () => {
  it("roundtrips hex encode/decode", () => {
    const vec = new Float32Array(32);
    vec[0] = 1.25;
    vec[1] = -2.5;
    vec[2] = 3.75;
    const hex = vec32ToHex(vec);
    const decoded = hexToVec32(hex);
    assert.strictEqual(decoded.length, 32);
    for (let i = 0; i < 32; i += 1) {
      assert.ok(Object.is(decoded[i], vec[i]));
    }
  });

  it("mixes using sum of absolute weights", () => {
    const v1 = new Float32Array(32);
    const v2 = new Float32Array(32);
    v1[0] = 1;
    v2[0] = 3;
    const result = mixVectors([v1, v2], [1, -0.5]);
    assert.strictEqual(result.sumAbs, 1.5);
    assert.ok(Math.abs(result.vector[0] - -0.3333333) < 1e-6);
  });

  it("applies bus scaling", () => {
    const v = new Float32Array(32);
    v[0] = 2;
    const out = applyBus(v, 50);
    assert.strictEqual(out[0], 1);
  });

  it("sets magnitude with negative target", () => {
    const v = new Float32Array(32);
    v[0] = 3;
    v[1] = 4;
    const out = setMagnitude(v, -10);
    assert.ok(Math.abs(out[0] + 6) < 1e-6);
    assert.ok(Math.abs(out[1] + 8) < 1e-6);
  });

  it("preserves negative zero magnitude", () => {
    const v = new Float32Array(32);
    v[0] = 1;
    const out = setMagnitude(v, -0);
    assert.ok(Object.is(out[0], -0));
  });
});
