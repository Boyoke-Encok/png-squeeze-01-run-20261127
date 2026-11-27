// Lossless PNG re-encoder, written from scratch.
// Reads 1280x720 RGBA stored PNGs, reduces colour type where exact, picks per-row
// filters by minimum signed-absolute-sum, compresses with zlib level 9.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync, deflateSync } from 'node:zlib';

const W = 1280, H = 720;
const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---- CRC32 ----
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out[4] = type.charCodeAt(0); out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2); out[7] = type.charCodeAt(3);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}
function ihdr(ct) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, W); v.setUint32(4, H);
  d[8] = 8; d[9] = ct;
  return d;
}
function pngOf(chunks) {
  let size = 8;
  for (const c of chunks) size += c.length;
  const out = new Uint8Array(size);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let at = 8;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// ---- Decode input PNG (colour type 6, 8-bit, non-interlaced) ----
function decodePng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0, height = 0, ct = 6;
  const idat = [];
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = view.getUint32(at + 8); height = view.getUint32(at + 12);
      ct = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    at += 12 + len;
  }
  if (width !== W || height !== H) throw new Error('unexpected size ' + width + 'x' + height);
  if (ct !== 6) throw new Error('unexpected colour type ' + ct);
  const raw = inflateSync(Buffer.concat(idat));
  // Unfilter rows (input is filter 0, but handle generally).
  const stride = W * 4;
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride, p = o - stride;
    if (ft === 0) rgba.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) rgba[o + i] = raw[src + i] + (i >= 4 ? rgba[o + i - 4] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) rgba[o + i] = raw[src + i] + (y > 0 ? rgba[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) rgba[o + i] = raw[src + i] + (((i >= 4 ? rgba[o + i - 4] : 0) + (y > 0 ? rgba[p + i] : 0)) >> 1);
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? rgba[o + i - 4] : 0;
        const b = y > 0 ? rgba[p + i] : 0;
        const c = y > 0 && i >= 4 ? rgba[p + i - 4] : 0;
        rgba[o + i] = raw[src + i] + paeth(a, b, c);
      }
    }
  }
  return rgba;
}

// ---- Filter one row with given type into out ----
function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) { out.set(cur); return; }
  if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    if (prev === null) { out.set(cur); return; }
    for (let i = 0; i < n; i++) out[i] = cur[i] - prev[i];
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      out[i] = cur[i] - ((a + b) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) { const v = row[i]; s += v < 128 ? v : 256 - v; }
  return s;
}

// Entropy-ish cost of a filtered byte: 0 for a zero byte, ~1+0.9*log2(|v|+1) otherwise.
// Precomputed table so the per-row choice is a lookup, not a log per byte.
const ECOST = new Float64Array(256);
for (let v = 0; v < 256; v++) {
  const sv = v < 128 ? v : v - 256;
  const a = sv < 0 ? -sv : sv;
  ECOST[v] = a === 0 ? 0.2 : 1 + 0.9 * Math.log2(a + 1);
}
function entropyCost(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) s += ECOST[row[i]];
  return s;
}

// Build filtered raw data. `mode`: 'minsum' / 'entropy' adaptive, or fixed 0..4.
function filterImage(samples, bpp, mode) {
  const stride = W * bpp;
  const raw = new Uint8Array(H * (stride + 1));
  const trial = [];
  if (mode === 'minsum' || mode === 'entropy') for (let t = 0; t < 5; t++) trial.push(new Uint8Array(stride));
  for (let y = 0; y < H; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const dst = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    if (mode === 'minsum' || mode === 'entropy') {
      let best = Infinity, bt = 0;
      for (let t = 0; t < 5; t++) {
        filterRow(t, cur, prev, bpp, trial[t]);
        const s = mode === 'minsum' ? signedSum(trial[t]) : entropyCost(trial[t]);
        if (s < best) { best = s; bt = t; }
      }
      dst.set(trial[bt]);
      raw[y * (stride + 1)] = bt;
    } else {
      filterRow(mode, cur, prev, bpp, dst);
      raw[y * (stride + 1)] = mode;
    }
  }
  return raw;
}

function deflateWith(raw, strategy) {
  return deflateSync(raw, { level: 9, memLevel: 9, strategy });
}

// Encode one image; returns PNG bytes.
function encode(rgba) {
  const n = W * H;
  // Analysis: unique colours (cap 257), grey, alpha.
  const seen = new Map();
  let grey = true, allOpaque = true;
  let over = false;
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2], a = rgba[i * 4 + 3];
    if (r !== g || g !== b) grey = false;
    if (a !== 255) allOpaque = false;
    if (!over) {
      const key = (r << 24) | (g << 16) | (b << 8) | a;
      if (!seen.has(key)) {
        seen.set(key, (seen.get(key) ?? 0) + 1);
        if (seen.size > 256) over = true;
      } else seen.set(key, seen.get(key) + 1);
    }
  }

  let ct, samples, bpp, plte = null, trns = null;

  // Grey first: type 0/4 stores the grey value itself (1 byte/px), which filters
  // far better than palette indices for gradients with many grey steps.
  if (grey) {
    if (allOpaque) {
      ct = 0; bpp = 1;
      samples = new Uint8Array(n);
      for (let i = 0; i < n; i++) samples[i] = rgba[i * 4];
    } else {
      ct = 4; bpp = 2;
      samples = new Uint8Array(n * 2);
      for (let i = 0; i < n; i++) { samples[i * 2] = rgba[i * 4]; samples[i * 2 + 1] = rgba[i * 4 + 3]; }
    }
  } else if (!over) {
    // Palette, entries sorted by frequency descending (frequent colours -> low indices).
    const entries = [...seen.entries()].sort((x, y) => y[1] - x[1]);
    const idx = new Map();
    plte = new Uint8Array(entries.length * 3);
    const alphas = new Uint8Array(entries.length);
    for (let e = 0; e < entries.length; e++) {
      const key = entries[e][0];
      idx.set(key, e);
      plte[e * 3] = (key >>> 24) & 0xff;
      plte[e * 3 + 1] = (key >>> 16) & 0xff;
      plte[e * 3 + 2] = (key >>> 8) & 0xff;
      alphas[e] = key & 0xff;
    }
    samples = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const key = (rgba[i * 4] << 24) | (rgba[i * 4 + 1] << 16) | (rgba[i * 4 + 2] << 8) | rgba[i * 4 + 3];
      samples[i] = idx.get(key);
    }
    ct = 3; bpp = 1;
    if (!allOpaque) {
      let last = entries.length - 1;
      while (last > 0 && alphas[last] === 255) last--;
      trns = alphas.subarray(0, last + 1);
    }
  } else if (allOpaque) {
    ct = 2; bpp = 3;
    samples = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      samples[i * 3] = rgba[i * 4]; samples[i * 3 + 1] = rgba[i * 4 + 1]; samples[i * 3 + 2] = rgba[i * 4 + 2];
    }
  } else {
    // Check single transparent colour + no semi-transparent: type 2 + tRNS.
    let transKey = -1, semi = false, ok = true;
    for (let i = 0; i < n; i++) {
      const a = rgba[i * 4 + 3];
      if (a === 0) {
        const k = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
        if (transKey === -1) transKey = k;
        else if (transKey !== k) { ok = false; break; }
      } else if (a !== 255) { semi = true; ok = false; break; }
    }
    if (ok && transKey !== -1 && !semi) {
      ct = 2; bpp = 3;
      samples = new Uint8Array(n * 3);
      for (let i = 0; i < n; i++) {
        samples[i * 3] = rgba[i * 4]; samples[i * 3 + 1] = rgba[i * 4 + 1]; samples[i * 3 + 2] = rgba[i * 4 + 2];
      }
      trns = new Uint8Array([0, (transKey >>> 16) & 0xff, 0, (transKey >>> 8) & 0xff, 0, transKey & 0xff]);
    } else {
      ct = 6; bpp = 4;
      samples = rgba;
    }
  }

  // Candidate encodings: two adaptive choices (min-sum, entropy) plus the fixed
  // filters (None often wins on flat screenshots: raw repeats compress well).
  // Deflate each with the default strategy, keep the smallest, then also try
  // Z_FILTERED on that winner.
  let bestRaw = null, bestComp = null;
  for (const m of ['minsum', 'entropy', 0, 1, 2, 3, 4]) {
    const raw = filterImage(samples, bpp, m);
    const comp = deflateWith(raw, 0);
    if (bestComp === null || comp.length < bestComp.length) { bestComp = comp; bestRaw = raw; }
  }
  const compF = deflateWith(bestRaw, 1);
  if (compF.length < bestComp.length) bestComp = compF;

  const chunks = [chunk('IHDR', ihdr(ct))];
  if (plte) chunks.push(chunk('PLTE', plte));
  if (trns) chunks.push(chunk('tRNS', trns));
  chunks.push(chunk('IDAT', bestComp));
  chunks.push(chunk('IEND', new Uint8Array(0)));
  return pngOf(chunks);
}

for (const id of readdirSync(INPUT).sort()) {
  const rgba = decodePng(readFileSync(join(INPUT, id, 'image.png')));
  const out = encode(rgba);
  mkdirSync(join(OUTPUT, id), { recursive: true });
  writeFileSync(join(OUTPUT, id, 'image.png'), out);
}
