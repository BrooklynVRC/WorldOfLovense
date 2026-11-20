// Differences between running from source (npm start), the packaged server, and inside the desktop window.
// Same file in both repos.
import { dirname, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { exec } from 'node:child_process';

declare const __PACKAGED__: boolean | undefined;
declare const __VERSION__: string | undefined;

export const PACKAGED = typeof __PACKAGED__ !== 'undefined' && __PACKAGED__;
export const VERSION = typeof __VERSION__ !== 'undefined' ? __VERSION__ : 'dev';
/** True when started by the desktop window (WoW-LovenseLink.exe), which shows the UI itself. */
export const HOSTED = process.env.MSB_HOSTED === '1';
const SRC_ROOT = PACKAGED ? '' : resolve(import.meta.dirname, '..');

/** Where this app's settings live: %APPDATA%\<folder> for the .exe, the repo folder when run from source. */
export function dataDir(folder: string) {
  const dir = PACKAGED ? resolve(process.env.APPDATA || dirname(process.execPath), folder) : SRC_ROOT;
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Reads a bundled text file from public/. */
export function readAsset(name: string): string {
  if (PACKAGED) return (require('node:sea') as typeof import('node:sea')).getAsset(name, 'utf8');
  return readFileSync(resolve(SRC_ROOT, 'public', name), 'utf8');
}

/** The window-capture helper: the desktop host exe run with --capture. */
export function captureExe(): { exe: string; args: string[] } {
  if (process.env.MSB_HOST_EXE) return { exe: process.env.MSB_HOST_EXE, args: ['--capture'] };
  const found = !PACKAGED && findFile(resolve(SRC_ROOT, 'host', 'bin'), 'LovenseLinkHost.exe');
  if (found) return { exe: found, args: ['--capture'] };
  throw new Error('capture helper not found: start the app with WoW-LovenseLink.exe (or run "npm run build:host" when developing)');
}

function findFile(dir: string, name: string): string | null {
  if (!existsSync(dir)) return null;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return p;
    if (e.isDirectory()) { const f = findFile(p, name); if (f) return f; }
  }
  return null;
}

/** Tells the desktop window where to navigate; otherwise opens the browser (when run on its own). */
export function showUi(url: string, openWhenStandalone: boolean, alreadyRunning = false) {
  if (HOSTED) { console.log(`${alreadyRunning ? 'MSB_ALREADY' : 'MSB_READY'} ${url}`); return; }
  if (openWhenStandalone || alreadyRunning) openBrowser(url);
}

export function openBrowser(url: string) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => { /* ignore failures */ });
}

/** When run as a bare console exe, keep the window open so error messages can be read. */
export async function pauseIfPackaged(message = 'Press Enter to close this window.') {
  if (!PACKAGED || HOSTED || !process.stdin.isTTY) return;
  console.log(`\n${message}`);
  await new Promise((r) => { process.stdin.resume(); process.stdin.once('data', r); });
}
