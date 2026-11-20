// Draws the addon's strip into a fake corner screenshot (as the capture helper sends it) and reads it back.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { decodeBmpRgb, readStrip } = await import('../src/strip.ts');
const { DEFAULT_CONFIG, EVENTS, actionFor } = await import('../src/config.ts');
const { HealthWatch } = await import('../src/health.ts');

const L = (n) => n * 17;
/** Same colours LovenseLink.lua draws for show(code, intensity). */
function stripColours(seq, code, intensity) {
  return [[255, 0, 255], [L(seq), L(code >> 4), L(code & 15)], [L(intensity), L(15 - intensity), L(8)], [0, 255, 255]];
}

/** 24-bit bottom-up BMP, background = some game scenery, strip at (ox, oy) with `size` px squares. */
function bmp(w, h, { ox = 0, oy = 0, size = 8, colours, noise = 0, health = 0.5 } = {}) {
  const stride = Math.ceil((w * 3) / 4) * 4, off = 54;
  const buf = Buffer.alloc(off + stride * h);
  buf.write('BM', 0); buf.writeUInt32LE(buf.length, 2); buf.writeUInt32LE(off, 10); buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18); buf.writeInt32LE(h, 22); buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let c = [(x * 7) % 200, (y * 5) % 180, 90];
    const i = Math.floor((x - ox) / size);
    if (colours && y >= oy && y < oy + size && x >= ox + 4 * size && x < ox + 12 * size) c = x < ox + 4 * size + Math.round(health * 8 * size) ? [255, 255, 255] : [0, 0, 0];
    if (colours && y >= oy && y < oy + size && x >= ox && i >= 0 && i < 4) c = colours[i].map((v) => Math.max(0, Math.min(255, v + (noise ? Math.round((Math.random() * 2 - 1) * noise) : 0))));
    const o = off + (h - 1 - y) * stride + x * 3;
    buf[o] = c[2]; buf[o + 1] = c[1]; buf[o + 2] = c[0];
  }
  return buf;
}

test('reads every event code and intensity', () => {
  for (const { code } of EVENTS) for (const intensity of [0, 4, 15]) {
    const img = decodeBmpRgb(bmp(150, 60, { colours: stripColours(code % 15 + 1, code, intensity) }));
    assert.deepEqual(readStrip(img), { seq: code % 15 + 1, code, intensity, health: 0.5 });
  }
});

test('works at other square sizes, offsets and with slight colour noise', () => {
  for (const [size, ox, oy] of [[4, 0, 0], [8, 2, 1], [12, 5, 3], [16, 0, 0]]) {
    const img = decodeBmpRgb(bmp(220, 60, { size, ox, oy, colours: stripColours(7, 13, 9), noise: 6 }));
    const r = readStrip(img);
    assert.deepEqual({ ...r, health: Math.round(r.health * 100) }, { seq: 7, code: 13, intensity: 9, health: 50 }, `size ${size}`);
  }
});

test('ignores the corner when the strip is missing or fails its check', () => {
  assert.equal(readStrip(decodeBmpRgb(bmp(150, 60))), null);
  const bad = stripColours(3, 4, 10); bad[2][1] = L(2); // check square wrong
  assert.equal(readStrip(decodeBmpRgb(bmp(150, 60, { colours: bad }))), null);
  const noCyan = stripColours(3, 4, 10); noCyan[3] = [40, 40, 40];
  assert.equal(readStrip(decodeBmpRgb(bmp(150, 60, { colours: noCyan }))), null);
});

test('damage strength scales with how hard you were hit', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  const s = (i) => actionFor(cfg, 4, i).action.strength;
  assert.ok(s(1) < s(5) && s(5) < s(10) && s(10) <= s(15));
  assert.equal(s(10), cfg.events.damage.action.strength);
  assert.ok(s(15) <= 20);
  cfg.events.damage.enabled = false;
  assert.equal(actionFor(cfg, 4, 10), null);
  assert.equal(actionFor(cfg, 99, 10), null);
});

test('reads the health bar', () => {
  for (const hp of [0, 0.1, 0.33, 0.77, 1]) {
    const r = readStrip(decodeBmpRgb(bmp(150, 60, { colours: stripColours(1, 1, 0), health: hp })));
    assert.ok(Math.abs(r.health - hp) < 0.02, `${hp} read as ${r.health}`);
  }
});

test('health drops become damage events, low health fires once', () => {
  const w = new HealthWatch();
  let t = 0; const at = (h, dt = 80) => { t += dt; return w.update(h, t); };
  assert.deepEqual(at(1), []);
  assert.deepEqual(at(0.995), []);                // noise
  at(0.9); at(0.8);                               // two hits close together...
  const ev = at(0.8, 500);                        // ...add up into one 20% event
  assert.deepEqual(ev, [{ key: 'damage', intensity: 4, percent: 20 }]);
  at(0.79); assert.deepEqual(at(0.79, 600), []);  // 1%: too small
  const ev2 = [...at(0.2), ...at(0.2, 600)];
  assert.ok(ev2.some((e) => e.key === 'low_health'));
  assert.ok(ev2.some((e) => e.key === 'damage' && e.intensity === 12));
  at(0.1); assert.ok(!at(0.1, 600).some((e) => e.key === 'low_health')); // only once
  at(0.5); assert.ok([...at(0.1), ...at(0.1, 600)].some((e) => e.key === 'low_health')); // re-armed above 40%
  at(0); assert.deepEqual(at(0, 600), []);        // dying: the died event covers it
});
