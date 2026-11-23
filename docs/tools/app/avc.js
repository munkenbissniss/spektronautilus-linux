// H.264 parameter sets: the colour range written in them.
// Safari's video encoder (iPhone, iPad, Mac) marks what it writes as "full range" (0-255) even when it is told the frames are
// "limited range" (16-235, what the fast way hands it). A player then shows the picture greyer and flatter than it is, and the
// next step of the fast way reads it back the same wrong way, so every pass made it flatter still. Here the mark is set to what
// the picture really is: limited range, BT.709 colours. Only bits change (the same number of them), so frame sizes stay right
// apart from the rare escape byte, which is handled.

class Bits {
  constructor(u8) { this.b = u8; this.p = 0; }
  u(n) { let v = 0; for (let i = 0; i < n; i++) { const x = (this.b[this.p >> 3] >> (7 - (this.p & 7))) & 1; v = v * 2 + x; this.p++; } return v; }
  ue() { let z = 0; while (this.u(1) === 0) { if (++z > 31) throw new Error('bad ue'); } return z ? (2 ** z - 1) + this.u(z) : 0; }
  se() { const k = this.ue(); return k & 1 ? (k + 1) / 2 : -k / 2; }
  set(pos, n, v) { for (let i = n - 1; i >= 0; i--, pos++) { const bit = (v >> i) & 1, byte = pos >> 3, m = 1 << (7 - (pos & 7)); this.b[byte] = bit ? this.b[byte] | m : this.b[byte] & ~m; } }
}
const unescape = d => { const o = []; for (let i = 0; i < d.length; i++) { if (i >= 2 && d[i] === 3 && d[i - 1] === 0 && d[i - 2] === 0 && i + 1 < d.length && d[i + 1] <= 3) continue; o.push(d[i]); } return Uint8Array.from(o); };
const escape = r => { const o = []; let z = 0; for (const x of r) { if (z >= 2 && x <= 3) { o.push(3); z = 0; } o.push(x); z = x === 0 ? z + 1 : 0; } return Uint8Array.from(o); };

// one SPS NAL (with its header byte) -> the fixed NAL, or the same one when there is nothing to fix (or it cannot be read)
export function fixSps(nal) {
  try {
    const r = unescape(nal.subarray(1)), s = new Bits(r);
    const profile = s.u(8); s.u(8); s.u(8); s.ue();
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      const cf = s.ue(); if (cf === 3) s.u(1); s.ue(); s.ue(); s.u(1);
      if (s.u(1)) for (let i = 0; i < (cf !== 3 ? 8 : 12); i++) if (s.u(1)) { let last = 8, next = 8; const n = i < 6 ? 16 : 64; for (let j = 0; j < n; j++) { if (next) next = (last + s.se() + 256) % 256; last = next || last; } }
    }
    s.ue(); const poc = s.ue();
    if (poc === 0) s.ue(); else if (poc === 1) { s.u(1); s.se(); s.se(); const k = s.ue(); for (let i = 0; i < k; i++) s.se(); }
    s.ue(); s.u(1); s.ue(); s.ue();
    if (!s.u(1)) s.u(1); s.u(1);
    if (s.u(1)) { s.ue(); s.ue(); s.ue(); s.ue(); }
    if (!s.u(1)) return nal;                                   // no VUI: limited range is what a player assumes
    if (s.u(1)) { if (s.u(8) === 255) { s.u(16); s.u(16); } }  // aspect ratio
    if (s.u(1)) s.u(1);                                        // overscan
    if (!s.u(1)) return nal;                                   // no video signal type: limited range again
    s.u(3); const at = s.p, full = s.u(1);
    let changed = false;
    if (full) { s.set(at, 1, 0); changed = true; }
    if (s.u(1)) {                                              // colours: say BT.709 (what the fast way writes) instead of "unknown"
      const cp = s.p, a = s.u(8), b = s.u(8), c = s.u(8);
      if (a !== 1 || b !== 1 || c !== 1) { s.set(cp, 8, 1); s.set(cp + 8, 8, 1); s.set(cp + 16, 8, 1); changed = true; }
    }
    if (!changed) return nal;
    const e = escape(r), out = new Uint8Array(1 + e.length); out[0] = nal[0]; out.set(e, 1); return out;
  } catch (e) { return nal; }
}

// avcC (the decoder description) with its SPS fixed
export function fixAvcC(d) {
  if (!d || d.length < 7 || d[0] !== 1) return d;
  const out = [...d.subarray(0, 5)]; let p = 5;
  const nS = d[p] & 31; out.push(d[p++]);
  for (let i = 0; i < nS; i++) { const L = d[p] << 8 | d[p + 1]; const f = fixSps(d.subarray(p + 2, p + 2 + L)); out.push(f.length >> 8, f.length & 255, ...f); p += 2 + L; }
  out.push(...d.subarray(p));
  return Uint8Array.from(out);
}
export const lengthSize = d => (d && d.length > 4 ? (d[4] & 3) + 1 : 4);
// one frame (NAL units with a length in front): the SPS units in it fixed
export function fixSample(data, ls = 4) {
  let p = 0, hit = false; const parts = [];
  while (p + ls <= data.length) {
    let L = 0; for (let i = 0; i < ls; i++) L = L * 256 + data[p + i];
    if (L <= 0 || p + ls + L > data.length) return data;
    const nal = data.subarray(p + ls, p + ls + L);
    if ((nal[0] & 31) === 7) { const f = fixSps(nal); if (f !== nal) hit = true; parts.push(f); } else parts.push(nal);
    p += ls + L;
  }
  if (!hit) return data;
  const out = new Uint8Array(parts.reduce((a, x) => a + ls + x.length, 0)); let q = 0;
  for (const x of parts) { for (let i = ls - 1; i >= 0; i--) out[q + (ls - 1 - i)] = (x.length / 2 ** (8 * i)) & 255; out.set(x, q + ls); q += ls + x.length; }
  return out;
}
