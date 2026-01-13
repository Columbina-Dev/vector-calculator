const HEX_RE_256 = /^[0-9a-fA-F]{256}$/;

export function hexToVec32(hex: string): Float32Array {
  if (!HEX_RE_256.test(hex)) {
    throw new Error("Expected 256 hex characters.");
  }
  const bytes = new Uint8Array(128);
  for (let i = 0; i < bytes.length; i += 1) {
    const offset = i * 2;
    bytes[i] = Number.parseInt(hex.slice(offset, offset + 2), 16);
  }
  const view = new DataView(bytes.buffer);
  const out = new Float32Array(32);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = view.getFloat32(i * 4, true);
  }
  return out;
}

export function vec32ToHex(vec: ArrayLike<number>): string {
  if (vec.length !== 32) {
    throw new Error("Expected 32 float values.");
  }
  const bytes = new Uint8Array(128);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < 32; i += 1) {
    view.setFloat32(i * 4, vec[i], true);
  }
  return bytesToHex(bytes);
}

export function l2Magnitude(vec: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < vec.length; i += 1) {
    const v = vec[i];
    sum += v * v;
  }
  return Math.sqrt(sum);
}

export function mixVectors(
  vectors: Float32Array[],
  weights: number[]
): { vector: Float32Array; sumAbs: number } {
  if (vectors.length !== weights.length) {
    throw new Error("Weights length mismatch.");
  }
  const out = new Float32Array(32);
  let sumAbs = 0;
  for (let i = 0; i < weights.length; i += 1) {
    const weight = weights[i];
    sumAbs += Math.abs(weight);
    const vec = vectors[i];
    for (let j = 0; j < out.length; j += 1) {
      out[j] += vec[j] * weight;
    }
  }
  if (sumAbs === 0) {
    return { vector: new Float32Array(32), sumAbs };
  }
  for (let i = 0; i < out.length; i += 1) {
    out[i] /= sumAbs;
  }
  return { vector: out, sumAbs };
}

export function applyBus(vec: Float32Array, busPercent: number): Float32Array {
  const scale = busPercent / 100;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i += 1) {
    out[i] = vec[i] * scale;
  }
  return out;
}

export function setMagnitude(vec: Float32Array, targetMag: number): Float32Array {
  const mag = l2Magnitude(vec);
  if (mag === 0) {
    return new Float32Array(vec.length);
  }
  const isNegZero = Object.is(targetMag, -0);
  const sign = targetMag < 0 || isNegZero ? -1 : 1;
  const scale = (Math.abs(targetMag) * sign) / mag;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i += 1) {
    out[i] = vec[i] * scale;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) {
    const value = bytes[i].toString(16).padStart(2, "0");
    hex += value;
  }
  return hex.toUpperCase();
}
