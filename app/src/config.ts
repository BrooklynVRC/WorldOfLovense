import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dataDir } from './runtime.js';

export const DATA_DIR = dataDir('WoWLovenseLink');
const CONFIG_PATH = resolve(DATA_DIR, 'config.json');

export type ActionType = 'vibrate' | 'preset' | 'pattern' | 'stop';
export interface Action {
  type: ActionType;
  function: string;   // Vibrate, Rotate, Pump, Thrusting, Fingering, Suction, Depth, Oscillate, All
  strength: number;   // 0-20
  seconds: number;
  preset: string;     // pulse, wave, fireworks, earthquake
  pattern: string;    // "20;0;20;0" strengths, one step per patternStepMs
  patternStepMs: number;
}

export const act = (type: ActionType, strength: number, seconds: number, extra: Partial<Action> = {}): Action => ({
  type, function: 'Vibrate', strength, seconds, preset: 'pulse', pattern: '', patternStepMs: 300, ...extra,
});
const rule = (enabled: boolean, action: Action, scaleWithIntensity = false) => ({ enabled, scaleWithIntensity, action });

/** Event codes sent by the LovenseLink addon (must match LovenseLink.lua). */
export const EVENTS: { code: number; key: EventKey; label: string }[] = [
  { code: 1, key: 'test', label: 'Test (/ll test)' },
  { code: 2, key: 'combat_start', label: 'Entering combat' },
  { code: 3, key: 'combat_end', label: 'Leaving combat' },
  { code: 4, key: 'damage', label: 'Taking damage' }, // 4 and 5 are worked out by the app from the health bar
  { code: 5, key: 'low_health', label: 'Low health (under 25%)' },
  { code: 6, key: 'died', label: 'You died' },
  { code: 7, key: 'resurrected', label: 'You were resurrected' },
  { code: 10, key: 'level_up', label: 'Level up' },
  { code: 11, key: 'quest_done', label: 'Quest turned in' },
  { code: 12, key: 'loot_rare', label: 'Looted a rare (blue)' },
  { code: 13, key: 'loot_epic', label: 'Looted an epic (purple)' },
  { code: 14, key: 'loot_legendary', label: 'Looted a legendary (orange)' },
  { code: 15, key: 'honor_kill', label: 'Honorable kill' },
  { code: 17, key: 'boss_pull', label: 'Boss pulled' },
  { code: 18, key: 'boss_kill', label: 'Boss killed' },
  { code: 19, key: 'wipe', label: 'Wipe' },
];

export const DEFAULT_CONFIG = {
  port: 7703,
  openBrowserOnStart: true,
  enabled: true,
  output: 'lovense' as 'lovense' | 'intiface',
  intiface: { url: 'ws://127.0.0.1:12345', device: '' },
  lovense: { host: '127.0.0.1', port: 20010, https: false, toy: '', platform: 'WoW LovenseLink' },
  safety: { maxStrength: 20, maxSeconds: 30, queueMode: 'queue' as 'queue' | 'override' | 'ignore', maxQueue: 10 },
  game: { processName: 'Wow', checksPerSecond: 12 },
  events: {
    test: rule(true, act('vibrate', 8, 2)),
    combat_start: rule(false, act('vibrate', 4, 1)),
    combat_end: rule(false, act('vibrate', 3, 1)),
    damage: rule(true, act('vibrate', 14, 1), true),
    low_health: rule(true, act('pattern', 14, 3, { pattern: '20;0;20;0;20;0', patternStepMs: 250 })),
    died: rule(true, act('preset', 18, 6, { preset: 'earthquake' })),
    resurrected: rule(false, act('preset', 8, 3, { preset: 'wave' })),
    level_up: rule(true, act('preset', 16, 8, { preset: 'fireworks' })),
    quest_done: rule(true, act('vibrate', 6, 2)),
    loot_rare: rule(true, act('vibrate', 8, 2)),
    loot_epic: rule(true, act('preset', 14, 5, { preset: 'fireworks' })),
    loot_legendary: rule(true, act('preset', 20, 10, { preset: 'earthquake' })),
    honor_kill: rule(true, act('vibrate', 10, 2)),
    boss_pull: rule(true, act('vibrate', 6, 2)),
    boss_kill: rule(true, act('preset', 18, 10, { preset: 'fireworks' })),
    wipe: rule(true, act('pattern', 16, 5, { pattern: '20;0;15;0;10;0' })),
  },
};
export type Config = typeof DEFAULT_CONFIG;
export type EventKey = keyof Config['events'];
export type Rule = Config['events'][EventKey];

/**
 * The action to play for an addon event, or null if that event is off / unknown.
 * Damage-style events scale with the addon's intensity (0-15, for damage: 5% of your health per step):
 * the configured strength is what a 50%-of-your-health hit (intensity 10) feels like.
 */
export function actionFor(cfg: Config, code: number, intensity: number): { key: EventKey; label: string; action: Action } | null {
  const ev = EVENTS.find((e) => e.code === code);
  if (!ev) return null;
  const r: Rule | undefined = cfg.events[ev.key];
  if (!r?.enabled) return null;
  let action = r.action, label = ev.label;
  if (r.scaleWithIntensity) {
    const strength = Math.max(1, Math.min(20, Math.round(r.action.strength * Math.min(intensity, 15) / 10)));
    action = { ...action, strength };
    if (ev.key === 'damage') label = `${ev.label} (~${Math.min(intensity * 5, 75)}${intensity >= 15 ? '+' : ''}% of your health)`;
  }
  return { key: ev.key, label, action };
}

const ACTION_HINTS = {
  type: { options: [{ value: 'vibrate', label: 'Constant' }, { value: 'preset', label: 'Preset pattern' }, { value: 'pattern', label: 'Custom pattern' }, { value: 'stop', label: 'Stop' }] },
  function: { label: 'Function', options: ['Vibrate', 'Rotate', 'Pump', 'Thrusting', 'Fingering', 'Suction', 'Depth', 'Oscillate', 'All'] },
  strength: { label: 'Strength (0–20)', min: 0, max: 20, step: 1 },
  seconds: { min: 1, max: 600, step: 1 },
  preset: { label: 'Preset (for Preset type)', options: ['pulse', 'wave', 'fireworks', 'earthquake'] },
  pattern: { label: 'Pattern (for Custom type)', placeholder: '20;0;15;0', help: 'Strengths 0–20 separated by ;. Leave blank to use Strength.' },
  patternStepMs: { label: 'Pattern step (ms)', min: 100, step: 50 },
};

export const HINTS: Record<string, unknown> = {
  port: { advanced: true, label: 'Port', help: 'Only change this if another program already uses 7703. Restart the app after changing.' },
  openBrowserOnStart: { advanced: true, label: 'Open in browser when run on its own' },
  enabled: { label: 'Toy reactions on', help: 'Untick to pause everything (the toy stops) without losing your settings.' },
  output: { label: 'How to reach your toy', options: [{ value: 'lovense', label: 'Lovense Remote app (Game Mode)' }, { value: 'intiface', label: 'Intiface Central (Lovense + many other brands)' }], help: 'Pick the app that is connected to your toy, then fill in its section below and press Save.' },
  intiface: { label: '1b. Intiface Central', help: 'Only if you picked Intiface above. In Intiface Central press "Start Server", then connect your toy on its Devices tab.' },
  'intiface.url': { label: 'Server address', help: 'Intiface Central → Settings → Server. Default ws://127.0.0.1:12345.' },
  'intiface.device': { label: 'Only this toy', placeholder: 'blank = all toys' },
  lovense: { label: '1a. Lovense Remote', help: 'Only if you picked Lovense Remote above. In Lovense Remote: connect your toy, open Game Mode, and copy the Local IP and Port into the boxes below.' },
  'lovense.host': { label: 'Local IP (from Game Mode)', placeholder: 'e.g. 192.168.1.23' },
  'lovense.port': { label: 'Port (from Game Mode)' },
  'lovense.https': { label: 'Use HTTPS', help: 'Needed when Game Mode shows an HTTPS port (host looks like 192-168-1-5.lovense.club).' },
  'lovense.toy': { label: 'Toy ID', help: 'Blank = all connected toys.' },
  'lovense.platform': { advanced: true, label: 'Platform name' },
  safety: { label: '2. Safety limits', help: 'Hard limits that apply to everything.' },
  'safety.maxStrength': { label: 'Max strength cap', min: 0, max: 20, step: 1 },
  'safety.maxSeconds': { label: 'Max seconds per action', min: 1, max: 600 },
  'safety.queueMode': { label: 'When busy', options: [{ value: 'queue', label: 'Queue it' }, { value: 'override', label: 'Replace current' }, { value: 'ignore', label: 'Ignore new' }] },
  game: { advanced: true, label: 'Game window' },
  'game.processName': { label: 'Game process name', help: 'WoW Forever: Wow. Restart the app after changing.' },
  'game.checksPerSecond': { label: 'Checks per second', min: 4, max: 30, step: 1 },
  events: { label: '3. What happens in the game', closed: true, help: 'What the toy does for each event the LovenseLink addon reports.' },
  'events.*.scaleWithIntensity': { label: 'Scale with how big it was', help: 'For damage: the strength above is a hit that takes half your health; smaller hits are gentler, bigger ones stronger.' },
};
for (const { key, label } of EVENTS) HINTS[`events.${key}`] = { label };
for (const [k, v] of Object.entries(ACTION_HINTS)) HINTS[`events.*.action.${k}`] = v;

function merge<T>(base: T, over: unknown): T {
  if (Array.isArray(base)) return (Array.isArray(over) ? over : base) as T;
  if (base && typeof base === 'object') {
    const out: Record<string, unknown> = {};
    const o = (over && typeof over === 'object' ? over : {}) as Record<string, unknown>;
    for (const k of Object.keys(base)) out[k] = merge((base as Record<string, unknown>)[k], o[k]);
    return out as T;
  }
  return (over !== undefined && typeof over === typeof base ? over : base) as T;
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return structuredClone(DEFAULT_CONFIG);
  try { return merge(DEFAULT_CONFIG, JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))); }
  catch (e) { console.error('config.json is invalid, using defaults:', e); return structuredClone(DEFAULT_CONFIG); }
}
export function saveConfig(cfg: unknown): Config {
  const merged = merge(DEFAULT_CONFIG, cfg);
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  return merged;
}
