// Runs the Intiface output against a small mock of the Intiface Central (Buttplug v3) server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';

const { Intiface, PRESETS } = await import('../src/intiface.ts');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function mockServer() {
  const wss = new WebSocketServer({ port: 0 });
  const log = [];
  wss.on('connection', (ws) => ws.on('message', (raw) => {
    for (const msg of JSON.parse(String(raw))) {
      const [type, body] = Object.entries(msg)[0];
      log.push({ type, body });
      const reply = type === 'RequestServerInfo' ? { ServerInfo: { Id: body.Id, ServerName: 'mock', MessageVersion: 3, MaxPingTime: 0 } }
        : type === 'RequestDeviceList' ? { DeviceList: { Id: body.Id, Devices: [{ DeviceName: 'Lovense Lush', DeviceIndex: 0, DeviceMessages: { ScalarCmd: [{ StepCount: 20, FeatureDescriptor: '', ActuatorType: 'Vibrate' }], StopDeviceCmd: {} } }] } }
        : { Ok: { Id: body.Id } };
      ws.send(JSON.stringify([reply]));
    }
  }));
  return { wss, log, url: () => `ws://127.0.0.1:${wss.address().port}` };
}

const act = (extra = {}) => ({ type: 'vibrate', function: 'Vibrate', strength: 10, seconds: 1, preset: 'pulse', pattern: '', patternStepMs: 100, ...extra });

test('connects, finds the toy, vibrates at the right level and stops on time', async () => {
  const m = mockServer();
  await new Promise((r) => m.wss.on('listening', r));
  const i = new Intiface(() => ({ url: m.url(), device: '' }));
  i.ensure(true);
  await wait(300);
  assert.match(i.status, /connected · 1 toy/);
  await i.play(act(), 10, 1, null);
  const first = m.log.find((x) => x.type === 'ScalarCmd');
  assert.equal(first.body.Scalars[0].Scalar, 0.5);
  assert.equal(first.body.Scalars[0].ActuatorType, 'Vibrate');
  assert.ok(!m.log.some((x) => x.type === 'StopAllDevices'), 'still running');
  await wait(1200);
  assert.ok(m.log.some((x) => x.type === 'StopAllDevices'), 'stopped after the duration');
  i.close(); m.wss.close();
});

test('custom patterns and presets step through levels', async () => {
  const m = mockServer();
  await new Promise((r) => m.wss.on('listening', r));
  const i = new Intiface(() => ({ url: m.url(), device: 'lush' }));
  i.ensure(true);
  await wait(300);
  await i.play(act({ type: 'pattern' }), 10, 1, [20, 0, 10]);
  await wait(450);
  const levels = m.log.filter((x) => x.type === 'ScalarCmd').map((x) => x.body.Scalars[0].Scalar);
  assert.deepEqual(levels.slice(0, 3), [1, 0, 0.5]);
  await i.play(act({ type: 'preset', preset: 'pulse' }), 20, 1, null);
  await wait(100);
  const last = m.log.filter((x) => x.type === 'ScalarCmd').at(-1).body.Scalars[0].Scalar;
  assert.equal(last, PRESETS.pulse.steps[0] / 20);
  await i.stop();
  i.close(); m.wss.close();
});

test('a device filter that matches nothing refuses to play', async () => {
  const m = mockServer();
  await new Promise((r) => m.wss.on('listening', r));
  const i = new Intiface(() => ({ url: m.url(), device: 'hush' }));
  i.ensure(true);
  await wait(300);
  await assert.rejects(() => i.play(act(), 10, 1, null), /no toy/);
  i.close(); m.wss.close();
});
