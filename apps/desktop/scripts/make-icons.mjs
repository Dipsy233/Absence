// Generate the DAZE app icon (assets/icon.png, icon.ico) with no image
// dependencies: the icon is a simple drawing we can rasterize by hand.
//
// DAZE's mark is a dark disc with a teal "pause/observe" ring and a warm dot —
// an eye that is also a stop button. Precise enough for an app icon, and it
// never depends on a binary asset being committed.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// This script is apps/desktop/scripts → the assets live in the sibling dir.
const assets = path.resolve(here, "..", "assets");

/** A tiny RGBA canvas with the few primitives we need. */
function canvas(size) {
  const px = Buffer.alloc(size * size * 4);
  const put = (x, y, [r, g, b, a]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const sa = a / 255;
    // Source-over against whatever is already there.
    const da = px[i + 3] / 255;
    const outA = sa + da * (1 - sa);
    if (outA === 0) return;
    px[i] = Math.round((r * sa + px[i] * da * (1 - sa)) / outA);
    px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / outA);
    px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / outA);
    px[i + 3] = Math.round(outA * 255);
  };
  return { size, px, put };
}

const BG = [13, 15, 20, 255]; // #0b0d12, the app's window background
const RING = [94, 234, 212, 255]; // teal
const DOT = [251, 146, 60, 255]; // amber

/** Disc of radius r at (cx, cy), antialiased at the edge. */
function disc(c, cx, cy, r, color) {
  for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) {
    for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d > r + 0.5) continue;
      const a = d <= r - 0.5 ? 1 : r + 0.5 - d;
      c.put(x, y, [color[0], color[1], color[2], Math.round(color[3] * a)]);
    }
  }
}

/** Hollow ring: the area between rIn and rOut, antialiased on both edges. */
function ring(c, cx, cy, rIn, rOut, color) {
  for (let y = Math.floor(cy - rOut - 1); y <= Math.ceil(cy + rOut + 1); y++) {
    for (let x = Math.floor(cx - rOut - 1); x <= Math.ceil(cx + rOut + 1); x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      // Coverage of the outer disc minus coverage of the inner hole.
      const outerCov = coverage(d, rOut);
      const innerCov = coverage(d, rIn);
      const a = Math.max(0, Math.min(1, outerCov - innerCov));
      if (a <= 0) continue;
      c.put(x, y, [color[0], color[1], color[2], Math.round(color[3] * a)]);
    }
  }
}

/** Antialiased coverage of a disc of radius r at distance d from its centre. */
function coverage(d, r) {
  if (d <= r - 0.5) return 1;
  if (d >= r + 0.5) return 0;
  return r + 0.5 - d;
}

function draw(size) {
  const c = canvas(size);
  const s = size / 256; // all coordinates below are authored for 256px
  const center = size / 2;
  // Rounded-square backing so the icon reads on light and dark docks alike.
  disc(c, center, center, 118 * s, BG);
  // Corner softening: shave the extreme corners of the square backing.
  ring(c, center, center, 92 * s, 100 * s, RING);
  disc(c, center, center, 34 * s, DOT);
  return c;
}

/** Encode RGBA pixels as a PNG (zlib + CRC32, no dependencies). */
function png(c) {
  const { size, px } = c;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const crcTable = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c2 = n;
      for (let k = 0; k < 8; k++) c2 = c2 & 1 ? 0xedb88320 ^ (c2 >>> 1) : c2 >>> 1;
      table[n] = c2;
    }
    return table;
  })();
  const crc = (buf) => {
    let c2 = -1;
    for (const byte of buf) c2 = crcTable[(c2 ^ byte) & 0xff] ^ (c2 >>> 8);
    return (c2 ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Build an .ico that embeds PNG frames (supported since Windows Vista). */
function ico(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(frames.length, 4);
  const entries = [];
  const blobs = [];
  let offset = 6 + 16 * frames.length;
  for (const { size, data } of frames) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32BE(0, 8); // placeholder, fixed below
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
    blobs.push(data);
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

fs.mkdirSync(assets, { recursive: true });

// 512px master for macOS/Linux (electron-builder derives .icns and the
// AppImage icon from a large PNG). The .ico embeds its own downscaled frames.
const master = draw(512);
fs.writeFileSync(path.join(assets, "icon.png"), png(master));
console.log(`[icons] wrote ${path.join("assets", "icon.png")}`);

const icoFrames = [16, 32, 48, 64, 128, 256].map((size) => ({
  size,
  data: png(draw(size)),
}));
fs.writeFileSync(path.join(assets, "icon.ico"), ico(icoFrames));
console.log(`[icons] wrote ${path.join("assets", "icon.ico")}`);

// The tray icon is a small version of the same mark, kept square and legible
// at 16px: just the ring and dot, no square backing.
const tray = canvas(16);
const tc = tray.size / 2;
disc(tray, tc, tc, 7, BG);
ring(tray, tc, tc, 4, 6.5, RING);
disc(tray, tc, tc, 2, DOT);
fs.writeFileSync(path.join(assets, "tray.png"), png(tray));
console.log(`[icons] wrote ${path.join("assets", "tray.png")}`);
