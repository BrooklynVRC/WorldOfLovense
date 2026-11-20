// Talks to the Lovense Remote "Game Mode" / Lovense Connect local API and schedules actions.
import type { Action, Config } from './config.js';
import { Intiface } from './intiface.js';

const PATTERN_LETTER: Record<string, string> = {
  Vibrate: 'v', Rotate: 'r', Pump: 'p', Thrusting: 't', Fingering: 'f', Suction: 's', Depth: 'd', Oscillate: 'o', All: '',
};

export interface LogEntry { ts: number; label: string; detail: string; ok: boolean }

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(n) || 0)));

export class Lovense {
  log: LogEntry[] = [];
  lastError = '';
  lastOk = 0;
  private queue: { action: Action; label: string }[] = [];
  private timer: NodeJS.Timeout | null = null;
  private busyUntil = 0;

  readonly intiface: Intiface;
  constructor(private getConfig: () => Config) {
    this.intiface = new Intiface(() => this.getConfig().intiface);
  }
  get usingIntiface() { return this.getConfig().output === 'intiface'; }
  /** Keeps the Intiface connection matching the settings (call often). */
  sync() { this.intiface.ensure(this.usingIntiface); }
  get connectionStatus() { return this.usingIntiface ? this.intiface.status : this.lastError || (this.lastOk ? 'OK' : 'not tested yet'); }
  get connectionOk() { return this.usingIntiface ? this.intiface.status.startsWith('connected') && this.intiface.devices.length > 0 : !!this.lastOk && !this.lastError; }

  private get url() {
    const l = this.getConfig().lovense;
    return `${l.https ? 'https' : 'http'}://${l.host}:${l.port}/command`;
  }

  async command(body: Record<string, unknown>): Promise<any> {
    const l = this.getConfig().lovense;
    if (l.toy && body.command !== 'GetToys') body.toy = l.toy;
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-platform': l.platform || 'WoW LovenseLink' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(4000),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || (json.code && json.code !== 200)) throw new Error(`Lovense replied ${json.code ?? res.status}${json.message ? ': ' + json.message : ''}`);
      this.lastOk = Date.now(); this.lastError = '';
      return json;
    } catch (e) {
      this.lastError = (e as Error).message;
      throw e;
    }
  }

  async getToys(): Promise<{ id: string; name: string; nickName?: string; battery?: number; status?: unknown }[]> {
    if (this.usingIntiface) { this.sync(); return (await this.intiface.refresh()).map((d) => ({ id: String(d.index), name: d.name })); }
    const r = await this.command({ command: 'GetToys' });
    let toys = r?.data?.toys ?? {};
    if (typeof toys === 'string') { try { toys = JSON.parse(toys); } catch { toys = {}; } }
    return Object.values(toys) as any;
  }

  /** Build the Lovense request for an action, with safety caps applied. */
  buildRequest(a: Action): { body: Record<string, unknown>; seconds: number } {
    const s = this.getConfig().safety;
    const seconds = clamp(a.seconds, 1, s.maxSeconds);
    const strength = clamp(a.strength, 0, Math.min(20, s.maxStrength));
    if (a.type === 'stop') return { body: { command: 'Function', action: 'Stop', timeSec: 0, apiVer: 1 }, seconds: 0 };
    if (a.type === 'preset') return { body: { command: 'Preset', name: a.preset || 'pulse', timeSec: seconds, apiVer: 1 }, seconds };
    if (a.type === 'pattern') {
      const steps = (a.pattern || String(strength)).split(/[;,\s]+/).filter(Boolean).map((x) => clamp(Number(x), 0, Math.min(20, s.maxStrength)));
      const letter = PATTERN_LETTER[a.function] ?? 'v';
      const step = clamp(a.patternStepMs, 100, 10000);
      return { body: { command: 'Pattern', rule: `V:1;F:${letter};S:${step}#`, strength: steps.slice(0, 50).join(';'), timeSec: seconds, apiVer: 2 }, seconds };
    }
    const fn = a.function === 'All' ? 'All' : (a.function || 'Vibrate');
    return { body: { command: 'Function', action: `${fn}:${strength}`, timeSec: seconds, apiVer: 1 }, seconds };
  }

  /** Queue or play an action according to the safety.queueMode setting. */
  play(action: Action, label: string) {
    const cfg = this.getConfig();
    if (!cfg.enabled) return this.record(label, 'skipped (master switch off)', true);
    if (action.type === 'stop') return void this.stopAll(label);
    const busy = Date.now() < this.busyUntil;
    if (busy && cfg.safety.queueMode === 'ignore') return this.record(label, 'ignored (busy)', true);
    if (busy && cfg.safety.queueMode === 'queue') {
      if (this.queue.length >= cfg.safety.maxQueue) return this.record(label, 'dropped (queue full)', false);
      this.queue.push({ action, label });
      return this.record(label, `queued (#${this.queue.length})`, true);
    }
    if (cfg.safety.queueMode === 'override') this.queue = [];
    void this.run(action, label);
  }

  private async run(action: Action, label: string) {
    if (this.timer) clearTimeout(this.timer);
    const { body, seconds } = this.buildRequest(action);
    this.busyUntil = Date.now() + seconds * 1000;
    this.timer = setTimeout(() => this.next(), seconds * 1000);
    try {
      if (this.usingIntiface) {
        this.sync();
        const strength = Math.round(Number(String(body.action ?? '').split(':')[1] ?? action.strength)) || clampStrength(action.strength, this.getConfig().safety.maxStrength);
        const steps = typeof body.strength === 'string' ? (body.strength as string).split(';').map(Number) : null;
        await this.intiface.play(action, strength, seconds, steps);
      } else await this.command(body);
      this.record(label, `${body.command} ${body.action ?? body.name ?? body.strength} for ${seconds}s`, true);
    } catch (e) {
      this.record(label, `failed: ${(e as Error).message}`, false);
    }
  }

  private next() {
    this.timer = null; this.busyUntil = 0;
    const item = this.queue.shift();
    if (item) void this.run(item.action, item.label);
  }

  async stopAll(label = 'STOP') {
    this.queue = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null; this.busyUntil = 0;
    try { if (this.usingIntiface) await this.intiface.stop(); else await this.command({ command: 'Function', action: 'Stop', timeSec: 0, apiVer: 1 }); this.record(label, 'stopped, queue cleared', true); }
    catch (e) { this.record(label, `stop failed: ${(e as Error).message}`, false); }
  }

  get queueLength() { return this.queue.length; }
  get busy() { return Date.now() < this.busyUntil; }

  private record(label: string, detail: string, ok: boolean) {
    this.log.unshift({ ts: Date.now(), label, detail, ok });
    this.log.length = Math.min(this.log.length, 60);
    console.log(`[lovense] ${label}: ${detail}`);
  }
}

function clampStrength(s: number, max: number) { return Math.max(0, Math.min(20, Math.min(max, Math.round(Number(s) || 0)))); }
