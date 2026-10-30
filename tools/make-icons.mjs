// Generates icons/icon-{16,32,48,128}.png: a rose rounded square with a white
// speech bubble and pen stroke. Run: node tools/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { crc32 } from '../src/lib/zip.js';

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Shapes in unit coordinates (0..1); 4x4 supersampling for anti-aliasing.
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  return x >= x0 && x <= x1 && y >= y0 && y <= y1 && (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function distToSegment(px, py, ax, ay, bx, by) {
  const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
}
function sample(x, y) {
  if (!inRoundRect(x, y, 0, 0, 1, 1, 0.22)) return null;
  const bubble = inRoundRect(x, y, 0.18, 0.2, 0.82, 0.68, 0.12) ||
    (y >= 0.66 && y <= 0.84 && x >= 0.28 && x <= 0.46 && (x - 0.28) >= (y - 0.66) * 1.0);
  if (bubble) {
    if (distToSegment(x, y, 0.3, 0.52, 0.7, 0.36) < 0.045) return [225, 29, 72];
    return [255, 255, 255];
  }
  return [225, 29, 72];
}

for (const size of [16, 32, 48, 128]) {
  const S = 4;
  const buf = png(size, (px, py) => {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const c = sample((px + (sx + 0.5) / S) / size, (py + (sy + 0.5) / S) / size);
      if (c) { r += c[0]; g += c[1]; b += c[2]; a += 1; }
    }
    return a ? [Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round((a / (S * S)) * 255)] : [0, 0, 0, 0];
  });
  writeFileSync(new URL(`../icons/icon-${size}.png`, import.meta.url), buf);
}
console.log('icons written');
