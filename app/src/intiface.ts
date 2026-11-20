// Intiface Central (Buttplug protocol v3) output: talks to the local Intiface server over WebSocket.
// Intiface connects to the toys itself (Lovense and many other brands). Buttplug has no durations or
// presets, so this module runs the timing: it steps through patterns and stops the toy at the end.
import WebSocket from 'ws';
import type { Action } from './config.js';

interface Feature { index: number; actuator: string; steps: number }
export interface Device { index: number; name: string; scalars: Feature[]; rotators: number }

/** Lovense-style presets recreated as strength steps (0–20) and a step length in ms. */
export const PRESETS: Record<string, { steps: number[]; ms: number }> = {
  pulse: { steps: [20, 0], ms: 500 },
  wave: { steps: [4, 8, 12, 16, 20, 16, 12, 8], ms: 250 },
  fireworks: { steps: [20, 4, 16, 0, 20, 10, 18, 2], ms: 180 },
  earthquake: { steps: [20, 12, 20, 8, 20, 14, 20, 6], ms: 140 },
};
// Lovense function names → Buttplug actuator types.
const ACTUATOR: Record<string, string[]> = {
  Vibrate: ['Vibrate'], Rotate: ['Rotate'], Oscillate: ['Oscillate'], Pump: ['Inflate'], Suction: ['Constrict'],
  Thrusting: ['Oscillate'], Fingering: ['Oscillate'], Depth: ['Position'],
  All: ['Vibrate', 'Rotate', 'Oscillate', 'Inflate', 'Constrict'],
};

export class Intiface {
  status = 'not connected';
  devices: Device[] = [];
  private ws: WebSocket | null = null;
  private id = 1;
  private pending = new Map<number, { resolve: (m: any) => void; reject: (e: Error) => void }>();
  private ping: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private timeline: NodeJS.Timeout | null = null;
  private url = '';

  constructor(private getSettings: () => { url: string; device: string }) {}

  /** Connects (or reconnects after the URL changed). Safe to call often. */
  ensure(enabled: boolean) {
    const url = this.getSettings().url;
    if (!enabled) { this.close(); this.status = 'off'; return; }
    if (url === this.url && (this.ws || this.retry)) return;
    this.close();
    this.url = url;
    this.open();
  }

  private open() {
    this.retry = null;
    this.status = 'connecting…';
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on('open', async () => {
      try {
        const info = await this.send('RequestServerInfo', { ClientName: 'WoW LovenseLink', MessageVersion: 3 });
        const maxPing = info.ServerInfo?.MaxPingTime ?? 0;
        if (maxPing > 0) this.ping = setInterval(() => { this.send('Ping', {}).catch(() => {}); }, Math.max(200, maxPing / 2));
        await this.send('StartScanning', {}).catch(() => {}); // pick up toys that connect later
        await this.refresh();
      } catch (e) { this.status = `error: ${(e as Error).message}`; }
    });
    ws.on('message', (raw) => {
      let list: any[] = [];
      try { list = JSON.parse(String(raw)); } catch { return; }
      for (const msg of list) {
        const [type, body] = Object.entries(msg)[0] as [string, any];
        const p = this.pending.get(body?.Id);
        if (p && body.Id !== 0) { this.pending.delete(body.Id); type === 'Error' ? p.reject(new Error(body.ErrorMessage)) : p.resolve(msg); }
        if (type === 'DeviceAdded' || type === 'DeviceRemoved') void this.refresh();
      }
    });
    ws.on('error', () => { /* close follows */ });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.cleanup();
      this.status = 'Intiface Central not reachable (is it running with the server started?)';
      this.retry = setTimeout(() => this.open(), 5000);
    });
  }

  private send(type: string, body: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('Intiface not connected'));
      const Id = this.id++;
      this.pending.set(Id, { resolve, reject });
      this.ws.send(JSON.stringify([{ [type]: { Id, ...body } }]));
      setTimeout(() => { if (this.pending.delete(Id)) reject(new Error(`Intiface did not answer ${type}`)); }, 4000);
    });
  }

  async refresh() {
    const r = await this.send('RequestDeviceList', {});
    this.devices = (r.DeviceList?.Devices ?? []).map((d: any) => ({
      index: d.DeviceIndex, name: d.DeviceDisplayName || d.DeviceName,
      scalars: (d.DeviceMessages?.ScalarCmd ?? []).map((f: any, i: number) => ({ index: i, actuator: f.ActuatorType, steps: f.StepCount })),
      rotators: (d.DeviceMessages?.RotateCmd ?? []).length,
    }));
    this.status = `connected · ${this.devices.length} toy${this.devices.length === 1 ? '' : 's'}${this.devices.length ? '' : ' (connect one in Intiface Central)'}`;
    return this.devices;
  }

  private targets() {
    const want = this.getSettings().device.trim().toLowerCase();
    return this.devices.filter((d) => !want || d.name.toLowerCase().includes(want) || String(d.index) === want);
  }

  /** Sets every matching actuator to `level` (0..1). */
  private async level(level: number, fn: string) {
    const kinds = ACTUATOR[fn] ?? ACTUATOR.Vibrate;
    for (const d of this.targets()) {
      const scalars = d.scalars.filter((f) => kinds.includes(f.actuator)).map((f) => ({ Index: f.index, Scalar: level, ActuatorType: f.actuator }));
      if (scalars.length) await this.send('ScalarCmd', { DeviceIndex: d.index, Scalars: scalars }).catch(() => {});
      if (kinds.includes('Rotate') && d.rotators) await this.send('RotateCmd', { DeviceIndex: d.index, Rotations: Array.from({ length: d.rotators }, (_, i) => ({ Index: i, Speed: level, Clockwise: true })) }).catch(() => {});
    }
  }

  /** Plays an action for `seconds` (strengths already capped by the caller). Throws if nothing can play it. */
  async play(a: Action, strength: number, seconds: number, steps: number[] | null) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('Intiface Central is not connected');
    if (!this.targets().length) throw new Error('no toy connected in Intiface Central');
    this.clearTimeline();
    const fn = a.function || 'Vibrate';
    const end = Date.now() + seconds * 1000;
    const preset = a.type === 'preset' ? PRESETS[a.preset] ?? PRESETS.pulse : null;
    const seq = preset ? preset.steps.map((v) => Math.round((v * strength) / 20)) : steps;
    const ms = preset ? preset.ms : Math.max(100, a.patternStepMs || 300);
    if (!seq || seq.length <= 1) {
      await this.level((seq?.[0] ?? strength) / 20, fn);
      this.timeline = setTimeout(() => void this.stop(), seconds * 1000);
      return;
    }
    let i = 0;
    const tick = async () => {
      if (Date.now() >= end) { await this.stop(); return; }
      await this.level(seq[i % seq.length] / 20, fn);
      i++;
      this.timeline = setTimeout(tick, ms);
    };
    await tick();
  }

  private clearTimeline() { if (this.timeline) { clearTimeout(this.timeline); this.timeline = null; } }

  async stop() {
    this.clearTimeline();
    if (this.ws?.readyState === WebSocket.OPEN) await this.send('StopAllDevices', {}).catch(() => {});
  }

  private cleanup() {
    this.clearTimeline();
    if (this.ping) clearInterval(this.ping);
    this.ping = null; this.ws = null; this.devices = [];
    for (const p of this.pending.values()) p.reject(new Error('Intiface disconnected'));
    this.pending.clear();
  }

  close() {
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    const ws = this.ws;
    this.cleanup();
    this.url = '';
    if (ws) { try { ws.close(); } catch { /* ignore */ } }
  }
}
