// Reads the LovenseLink addon's colour strip from the top-left corner of the WoW window.
// The window is captured with Windows Graphics Capture (like OBS / Discord screen share); the game is
// never touched. Strip layout is documented in LovenseLink.lua.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface Rgb { w: number; h: number; px: Uint8Array } // 3 bytes per pixel, top-down
export interface Signal { seq: number; code: number; intensity: number }

/** Decodes a 24-bit bottom-up BMP (what the capture helper sends) into top-down RGB. */
export function decodeBmpRgb(buf: Buffer): Rgb {
  const off = buf.readUInt32LE(10), w = buf.readInt32LE(18);
  let h = buf.readInt32LE(22);
  const topDown = h < 0; h = Math.abs(h);
  const bpp = buf.readUInt16LE(28);
  const bytes = bpp / 8, stride = Math.floor((bpp * w + 31) / 32) * 4;
  const px = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const row = off + (topDown ? y : h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      const i = row + x * bytes, o = (y * w + x) * 3;
      px[o] = buf[i + 2]; px[o + 1] = buf[i + 1]; px[o + 2] = buf[i];
    }
  }
  return { w, h, px };
}

const level = (v: number) => Math.round(v / 17);
const at = (img: Rgb, x: number, y: number) => { const o = (y * img.w + x) * 3; return [img.px[o], img.px[o + 1], img.px[o + 2]]; };
const isMagenta = ([r, g, b]: number[]) => r > 200 && g < 70 && b > 200;
const isCyan = ([r, g, b]: number[]) => r < 70 && g > 200 && b > 200;

function tryAt(img: Rgb, x: number, y: number, size: number): Signal | null {
  const cy = Math.min(img.h - 1, y + Math.floor(size / 2));
  const sample = (i: number) => at(img, Math.min(img.w - 1, x + Math.floor(size * i + size / 2)), cy);
  if (!isCyan(sample(3))) return null;
  const [r2, g2, b2] = sample(1), [r3, g3, b3] = sample(2);
  const intensity = level(r3);
  if (level(g3) !== 15 - intensity || level(b3) !== 8) return null; // check square
  return { seq: level(r2), code: level(g2) * 16 + level(b2), intensity };
}

/** Finds the strip and decodes it, or null if it isn't visible / fails its checks. */
export function readStrip(img: Rgb): Signal | null {
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (!isMagenta(at(img, x, y))) continue;
      let size = 0;
      while (x + size < img.w && isMagenta(at(img, x + size, y))) size++;
      if (size < 2) continue;
      // Square 2 can itself look magenta (e.g. seq 13, event 12), so the run may be one or two squares wide.
      for (const s of [size, size / 2]) {
        if (s < 2) continue;
        const r = tryAt(img, x, y, s);
        if (r) return r;
      }
      x += size - 1;
    }
  }
  return null;
}

/** Captures the top-left corner of the game window over and over. */
export class CornerCapture {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private waiting: { resolve: (b: Buffer) => void; reject: (e: Error) => void }[] = [];
  constructor(private exe: string, private args: string[]) {}

  private start() {
    const p = spawn(this.exe, this.args, { windowsHide: true });
    this.proc = p;
    createInterface({ input: p.stdout }).on('line', (line) => {
      const w = this.waiting.shift(); if (!w) return;
      if (line.startsWith('OK ')) { const zoom = line.slice(3).split(' ')[1]; zoom ? w.resolve(Buffer.from(zoom, 'base64')) : w.reject(new Error('no corner picture')); }
      else w.reject(new Error(line.replace(/^ERR /, '')));
    });
    p.stderr.on('data', () => {});
    p.on('exit', () => { if (this.proc === p) this.proc = null; for (const w of this.waiting.splice(0)) w.reject(new Error('capture helper stopped')); });
  }

  /** The top-left corner (a small area at full resolution) as RGB. */
  grab(): Promise<Rgb> {
    if (!this.proc) this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('capture timed out')); this.close(); }, 4000);
      this.waiting.push({ resolve: (b) => { clearTimeout(timer); try { resolve(decodeBmpRgb(b)); } catch (e) { reject(e as Error); } }, reject: (e) => { clearTimeout(timer); reject(e); } });
      // Tiny main picture (unused) + the corner at full resolution.
      this.proc!.stdin.write('cap 64 0 0 0.08 0.06\n');
    });
  }

  close() { const p = this.proc; this.proc = null; if (p) { try { p.stdin.write('quit\n'); } catch {} setTimeout(() => p.kill(), 500); } }
}
