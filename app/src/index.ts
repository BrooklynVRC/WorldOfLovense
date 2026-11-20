import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { DATA_DIR, EVENTS, HINTS, actionFor, loadConfig, saveConfig, type Config } from './config.js';
import { VERSION, captureExe, pauseIfPackaged, readAsset, showUi } from './runtime.js';
import { Lovense } from './lovense.js';
import { CornerCapture, readStrip, type Signal } from './strip.js';
import { HealthWatch } from './health.js';

let config: Config = loadConfig();
const toy = new Lovense(() => config);

const localOrigins = () => [`http://localhost:${config.port}`, `http://127.0.0.1:${config.port}`];

// ---------------- WoW: read the addon's strip ----------------
const game = {
  status: 'starting…',
  capturing: false,   // the WoW window is being captured
  stripSeen: false,   // the addon's strip was found in the last few seconds
  lastSeen: 0,
  lastEvent: '',
  lastEventAt: 0,
  health: null as number | null, // % read from the addon's health bar
};
let lastSeq = -1;
let capture: CornerCapture | null = null;
let loop: NodeJS.Timeout | null = null;

const health = new HealthWatch();
function play(code: number, intensity: number) {
  const ev = EVENTS.find((e) => e.code === code);
  game.lastEvent = ev ? ev.label : `unknown event ${code}`;
  game.lastEventAt = Date.now();
  if (!config.enabled) return;
  const a = actionFor(config, code, intensity);
  if (a) toy.play(a.action, a.label);
}

function onSignal(s: Signal) {
  game.lastSeen = Date.now();
  game.stripSeen = true;
  game.health = s.health === null ? null : Math.round(s.health * 100);
  for (const h of health.update(s.health, Date.now())) play(h.key === 'damage' ? 4 : 5, h.key === 'damage' ? h.intensity : 12);
  if (s.seq === lastSeq) return;
  const first = lastSeq === -1;
  lastSeq = s.seq;
  if (first || s.code === 0) return; // what was already on screen when we started, or the addon's "loaded" state
  play(s.code, s.intensity);
}

function startReading() {
  let exe: { exe: string; args: string[] };
  try { exe = captureExe(); } catch (e) { game.status = (e as Error).message; return; }
  capture = new CornerCapture(exe.exe, [...exe.args, '--process', config.game.processName, '--no-aspect']);
  const tick = async () => {
    loop = null;
    try {
      const img = await capture!.grab();
      game.capturing = true;
      const s = readStrip(img);
      if (s) onSignal(s);
      if (!s) health.reset();
      if (Date.now() - game.lastSeen > 3000) {
        game.stripSeen = false; game.health = null;
        game.status = 'WoW found, but no LovenseLink strip in the top-left corner. Is the addon enabled? Try /reload.';
      } else game.status = 'reading WoW';
    } catch (e) {
      game.capturing = false; game.stripSeen = false; game.health = null; health.reset();
      game.status = (e as Error).message;
      lastSeq = -1;
      await new Promise((r) => setTimeout(r, 1500)); // window closed / minimized: check again a bit slower
    }
    if (capture) loop = setTimeout(tick, Math.round(1000 / Math.max(4, Math.min(30, config.game.checksPerSecond))));
  };
  void tick();
}
function stopReading() { if (loop) clearTimeout(loop); loop = null; const c = capture; capture = null; c?.close(); }

// ---------------- HTTP ----------------
function send(res: ServerResponse, code: number, body: unknown, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function file(res: ServerResponse, name: string, type: string) {
  try { send(res, 200, readAsset(name), type); } catch { send(res, 404, 'not found', 'text/plain'); }
}
async function body(req: IncomingMessage): Promise<any> {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > 1e6) throw new Error('too large'); }
  return data ? JSON.parse(data) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const origin = req.headers.origin;
  if (req.method !== 'GET' && origin && !localOrigins().includes(origin)) return send(res, 403, { error: 'forbidden origin' });
  try {
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /': return file(res, 'settings.html', 'text/html; charset=utf-8');
      case 'GET /ui.js': return file(res, 'ui.js', 'text/javascript; charset=utf-8');
      case 'GET /api/config': return send(res, 200, { config, hints: HINTS, events: EVENTS });
      case 'POST /api/config':
        config = saveConfig(await body(req));
        return send(res, 200, { ok: true, config });
      case 'GET /api/status': return send(res, 200, {
        version: VERSION, dataDir: DATA_DIR,
        enabled: config.enabled,
        lovense: { lastError: toy.lastError, lastOk: toy.lastOk, busy: toy.busy, queue: toy.queueLength, output: config.output, status: toy.connectionStatus, ok: toy.connectionOk },
        game,
        log: toy.log.slice(0, 25),
      });
      case 'POST /api/stop': await toy.stopAll('STOP button'); return send(res, 200, { ok: true });
      case 'POST /api/enabled': {
        const b = await body(req);
        config = saveConfig({ ...config, enabled: !!b.enabled });
        if (!config.enabled) await toy.stopAll('master switch off');
        return send(res, 200, { ok: true, enabled: config.enabled });
      }
      case 'POST /api/toys': return send(res, 200, { toys: await toy.getToys() });
      case 'POST /api/test': {
        const { key, intensity } = await body(req) as { key: string; intensity?: number };
        const ev = EVENTS.find((e) => e.key === key);
        if (!ev) return send(res, 400, { error: 'unknown event' });
        const r = config.events[ev.key];
        const a = actionFor({ ...config, events: { ...config.events, [ev.key]: { ...r, enabled: true } } }, ev.code, intensity ?? 10);
        if (a) toy.play(a.action, `test: ${a.label}`);
        return send(res, 200, { ok: true });
      }
      case 'POST /api/shutdown': {
        send(res, 200, { ok: true });
        return void shutdown('app closing');
      }
      default: return send(res, 404, { error: 'not found' });
    }
  } catch (e) {
    send(res, 500, { error: (e as Error).message });
  }
});

const home = `http://localhost:${config.port}/`;
server.on('error', async (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Port ${config.port} is already in use. The app is probably already running.`);
    showUi(home, true, true);
  } else console.error('Server error:', e);
  await pauseIfPackaged();
  process.exit(1);
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`WoW LovenseLink ${VERSION}`);
  console.log(`  Settings: ${home}`);
  console.log(`  Data:     ${DATA_DIR}`);
  showUi(home, config.openBrowserOnStart);
  startReading();
  toy.sync();
  setInterval(() => toy.sync(), 3000);
});

process.on('uncaughtException', (e) => console.error('[error]', e));
process.on('unhandledRejection', (e) => console.error('[error]', e));

// Stop the toy when the app closes (window closed, console closed, Ctrl+C).
let closing = false;
async function shutdown(label: string) {
  if (closing) return;
  closing = true;
  stopReading();
  await toy.stopAll(label).catch(() => {});
  setTimeout(() => process.exit(0), 200);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(sig, () => void shutdown('app closing'));
