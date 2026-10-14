import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocket, type RawData } from 'ws';
import { loadOrCreateConfig } from '../src/config.js';
import { aggregateSessions, isLoopback } from '../src/protocol.js';
import { startBridge, type RunningBridge } from '../src/server.js';

const BRIDGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Device {
  ws: WebSocket;
  messages: Array<Record<string, unknown>>;
  waitFor: (predicate: (message: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>;
  ready: Promise<void>;
}

function lanAddress(): string | null {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

async function withBridge(
  fn: (bridge: RunningBridge) => Promise<void>,
  options: {
    helloTimeoutMs?: number;
    pairTimeoutMs?: number;
    taskPollMs?: number;
    token?: string;
    silent?: boolean;
    onPairRequest?: (deviceId: string) => void;
  } = {},
): Promise<void> {
  const bridge = await startBridge({
    host: '0.0.0.0',
    port: 0,
    token: options.token ?? 'test-token',
    mdns: false,
    silent: options.silent ?? true,
    helloTimeoutMs: options.helloTimeoutMs ?? 400,
    pairTimeoutMs: options.pairTimeoutMs,
    taskPollMs: options.taskPollMs ?? 250,
    onPairRequest: options.onPairRequest,
  });
  try {
    await fn(bridge);
  } finally {
    await bridge.close();
  }
}

function track(ws: WebSocket): Device['waitFor'] & { messages: Array<Record<string, unknown>> } {
  const messages: Array<Record<string, unknown>> = [];
  let cursor = 0;
  const pending: Array<{
    predicate: (message: Record<string, unknown>) => boolean;
    resolve: (message: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  const flush = () => {
    for (let index = 0; index < pending.length; ) {
      const waiter = pending[index]!;
      let found = -1;
      for (let messageIndex = cursor; messageIndex < messages.length; messageIndex += 1) {
        if (waiter.predicate(messages[messageIndex]!)) {
          found = messageIndex;
          break;
        }
      }
      if (found < 0) {
        index += 1;
        continue;
      }
      cursor = found + 1;
      clearTimeout(waiter.timer);
      pending.splice(index, 1);
      waiter.resolve(messages[found]!);
    }
  };

  ws.on('message', (data: RawData) => {
    messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
    flush();
  });

  const waitFor = (predicate: (message: Record<string, unknown>) => boolean, timeoutMs = 2000) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = pending.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) pending.splice(index, 1);
        reject(new Error(`timed out waiting for a device message; saw ${JSON.stringify(messages)}`));
      }, timeoutMs);
      pending.push({ predicate, resolve, reject, timer });
      flush();
    });

  return Object.assign(waitFor, { messages });
}

function openDevice(
  port: number,
  token: string,
  deviceId = 'dev-test',
  headers?: Record<string, string>,
): Device {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/device`, headers ? { headers } : undefined);
  ws.on('error', () => {});
  const tracked = track(ws);
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('device hello timed out')), 2000);
    ws.once('open', () => {
      ws.send(
        JSON.stringify({
          type: 'hello',
          v: 1,
          token,
          device_id: deviceId,
          fw: 'test',
          board: 'test',
        }),
      );
    });
    void tracked((message) => message.type === 'hello_ack')
      .then(() => {
        clearTimeout(timer);
        resolve();
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
  return { ws, messages: tracked.messages, waitFor: tracked, ready };
}

async function postJson(port: number, pathname: string, body: unknown, host = '127.0.0.1'): Promise<Response> {
  return fetch(`http://${host}:${port}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function pairArrival(): {
  onPairRequest: (deviceId: string) => void;
  wait: (deviceId: string) => Promise<void>;
} {
  const arrived = new Set<string>();
  const waiting = new Map<string, () => void>();
  return {
    onPairRequest: (deviceId) => {
      arrived.add(deviceId);
      const resolve = waiting.get(deviceId);
      if (!resolve) return;
      waiting.delete(deviceId);
      resolve();
    },
    wait: (deviceId) => {
      if (arrived.has(deviceId)) return Promise.resolve();
      return new Promise((resolve) => waiting.set(deviceId, resolve));
    },
  };
}

function openPairingDevice(port: number, deviceId: string, code: string): Device & { opened: Promise<void> } {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/device`);
  ws.on('error', () => {});
  const tracked = track(ws);
  const opened = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('pairing socket open timed out')), 2000);
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'pair_request', v: 1, device_id: deviceId, code }), (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
    });
  });
  return { ws, messages: tracked.messages, waitFor: tracked, ready: Promise.resolve(), opened };
}

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: BRIDGE_DIR,
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function permissionBody(summary: string, timeout_s = 5) {
  return { source: 'pi', session: 's', tool: 'bash', summary, timeout_s };
}

function requestWithHost(
  port: number,
  requestPath: string,
  hostHeader: string,
  method = 'GET',
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: requestPath,
        method,
        headers: { ...headers, host: hostHeader },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('pi-buddy bridge', () => {
  it('rejects a device hello with the wrong token and disconnects', async () => {
    await withBridge(async (bridge) => {
      const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/v1/device`);
      ws.on('error', () => {});
      const closed = new Promise<number>((resolve) => {
        ws.on('close', (code) => resolve(code));
      });
      await new Promise<void>((resolve) => ws.once('open', () => resolve()));
      ws.send(
        JSON.stringify({
          type: 'hello',
          v: 1,
          token: 'not-the-token',
          device_id: 'intruder',
          fw: '0',
          board: 'x',
        }),
      );
      assert.equal(await closed, 1008);
      const response = await postJson(bridge.port, '/v1/permission', permissionBody('nope', 1));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { decision: 'no_device' });
    });
  });

  it('returns no_device when no device is online', async () => {
    await withBridge(async (bridge) => {
      const response = await postJson(bridge.port, '/v1/permission', permissionBody('rm -rf dist', 2));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { decision: 'no_device' });
    });
  });

  it('queues two permission requests and handles them in order', async () => {
    await withBridge(async (bridge) => {
      const device = openDevice(bridge.port, bridge.token);
      await device.ready;
      const first = postJson(bridge.port, '/v1/permission', permissionBody('first', 5)).then((res) => res.json());
      const shown = await device.waitFor(
        (message) => message.type === 'permission' && message.summary === 'first' && message.queue_len === 0,
      );
      const second = postJson(bridge.port, '/v1/permission', permissionBody('second', 5)).then((res) => res.json());
      const updated = await device.waitFor(
        (message) => message.type === 'permission' && message.summary === 'first' && message.queue_len === 1,
      );
      assert.equal(updated.id, shown.id);
      assert.equal(device.messages.some((message) => message.summary === 'second'), false);

      device.ws.send(JSON.stringify({ type: 'permission_reply', id: shown.id, decision: 'allow' }));
      assert.deepEqual(await first, { decision: 'allow' });

      const next = await device.waitFor((message) => message.type === 'permission' && message.summary === 'second');
      assert.equal(next.queue_len, 0);
      device.ws.send(JSON.stringify({ type: 'permission_reply', id: next.id, decision: 'deny' }));
      assert.deepEqual(await second, { decision: 'deny' });
      device.ws.close();
    });
  });

  it('returns timeout when the device does not answer in time', async () => {
    await withBridge(async (bridge) => {
      const device = openDevice(bridge.port, bridge.token);
      await device.ready;
      const pending = postJson(bridge.port, '/v1/permission', permissionBody('slow', 0.3)).then((res) => res.json());
      const shown = await device.waitFor((message) => message.type === 'permission' && message.summary === 'slow');
      assert.equal(shown.timeout_s, 0.3);
      const cancelled = await device.waitFor((message) => message.type === 'permission_cancel');
      assert.equal(cancelled.id, shown.id);
      assert.equal(cancelled.reason, 'timeout');
      assert.deepEqual(await pending, { decision: 'timeout' });
      device.ws.close();
    });
  });

  it('returns no_device for pending permissions when the device disconnects', async () => {
    await withBridge(async (bridge) => {
      const device = openDevice(bridge.port, bridge.token);
      await device.ready;
      const first = postJson(bridge.port, '/v1/permission', permissionBody('shown', 8)).then((res) => res.json());
      await device.waitFor((message) => message.type === 'permission' && message.summary === 'shown');
      const second = postJson(bridge.port, '/v1/permission', permissionBody('queued', 8)).then((res) => res.json());
      await device.waitFor((message) => message.type === 'permission' && message.queue_len === 1);
      const closed = new Promise<void>((resolve) => device.ws.once('close', () => resolve()));
      device.ws.close();
      await closed;
      assert.deepEqual(await first, { decision: 'no_device' });
      assert.deepEqual(await second, { decision: 'no_device' });
    });
  });

  it('rejects plugin API calls that are not from loopback', async () => {
    const lan = lanAddress();
    assert.ok(lan, 'this test needs a non-loopback IPv4 address');
    await withBridge(async (bridge) => {
      const event = await postJson(bridge.port, '/v1/event', {
        source: 'pi',
        session: 's',
        state: 'idle',
        detail: 'remote',
      }, lan);
      assert.equal(event.status, 403);
      assert.deepEqual(await event.json(), { error: 'forbidden' });

      const permission = await postJson(bridge.port, '/v1/permission', permissionBody('remote', 1), lan);
      assert.equal(permission.status, 403);

      const tasks = await fetch(`http://${lan}:${bridge.port}/v1/tasks?source=pi`);
      assert.equal(tasks.status, 403);

      const local = await postJson(bridge.port, '/v1/event', {
        source: 'pi',
        session: 's',
        state: 'idle',
        detail: 'home',
      });
      assert.equal(local.status, 200);
      assert.deepEqual(await local.json(), { ok: true });

      const remotePage = await fetch(`http://${lan}:${bridge.port}/sim`);
      assert.equal(remotePage.status, 403);
      const remoteHtml = await remotePage.text();
      assert.equal(remoteHtml.includes(bridge.token), false);

      const localPage = await fetch(`http://127.0.0.1:${bridge.port}/sim`);
      const localHtml = await localPage.text();
      assert.match(localHtml, new RegExp(`"token":"${bridge.token}"`));
    });
  });

  it('disconnects a device that never sends hello', async () => {
    await withBridge(async (bridge) => {
      const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/v1/device`);
      ws.on('error', () => {});
      const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
      assert.equal(await closed, 4000);
    }, { helloTimeoutMs: 200 });
  });

  it('aggregates session state by priority and lets permission win', async () => {
    assert.deepEqual(
      aggregateSessions(
        [
          { source: 'pi', session: 'old', state: 'error', detail: 'old' },
          { source: 'pi', session: 'new', state: 'working', detail: 'new' },
        ],
        null,
      ).state,
      'error',
    );
    assert.equal(isLoopback('127.0.0.1'), true);
    assert.equal(isLoopback('::1'), true);
    assert.equal(isLoopback('::ffff:127.0.0.1'), true);
    assert.equal(isLoopback('10.0.0.8'), false);
    assert.equal(isLoopback('::ffff:10.0.0.8'), false);

    await withBridge(async (bridge) => {
      const device = openDevice(bridge.port, bridge.token);
      await device.ready;
      const errorEvent = await postJson(bridge.port, '/v1/event', {
        source: 'pi',
        session: 'a',
        state: 'error',
        detail: 'boom',
      });
      assert.equal(errorEvent.status, 200);
      await postJson(bridge.port, '/v1/event', {
        source: 'pi',
        session: 'b',
        state: 'working',
        detail: 'bash · npm test',
      });
      const state = await device.waitFor(
        (message) =>
          message.type === 'state' &&
          message.state === 'error' &&
          Array.isArray(message.sessions) &&
          message.sessions.length === 2,
      );
      assert.equal(state.detail, 'boom');
      const sessions = state.sessions as Array<{ session: string }>;
      assert.deepEqual(sessions.map((item) => item.session), ['a', 'b']);

      const pending = postJson(bridge.port, '/v1/permission', permissionBody('rm -rf dist', 3)).then((res) => res.json());
      await device.waitFor((message) => message.type === 'state' && message.state === 'permission');
      const shown = await device.waitFor((message) => message.type === 'permission');
      device.ws.send(JSON.stringify({ type: 'permission_reply', id: shown.id, decision: 'deny' }));
      assert.deepEqual(await pending, { decision: 'deny' });
      const restored = await device.waitFor((message) => message.type === 'state' && message.state === 'error');
      assert.equal(restored.detail, 'boom');
      device.ws.close();
    });
  });

  it('delivers a voice task to the long poll and returns 204 on timeout', async () => {
    await withBridge(async (bridge) => {
      const device = openDevice(bridge.port, bridge.token);
      await device.ready;
      const waiting = fetch(`http://127.0.0.1:${bridge.port}/v1/tasks?source=pi`);
      await new Promise((resolve) => setTimeout(resolve, 40));
      device.ws.send(JSON.stringify({ type: 'task', text: '跑一下测试' }));
      const response = await waiting;
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { text: '跑一下测试' });

      device.ws.send(JSON.stringify({ type: 'task', text: 'queued-first' }));
      const queued = await fetch(`http://127.0.0.1:${bridge.port}/v1/tasks?source=pi`);
      assert.equal(queued.status, 200);
      assert.deepEqual(await queued.json(), { text: 'queued-first' });

      const empty = await fetch(`http://127.0.0.1:${bridge.port}/v1/tasks?source=pi`);
      assert.equal(empty.status, 204);
      assert.equal(await empty.text(), '');
      device.ws.close();
    }, { taskPollMs: 200 });
  });

  it('stores the bridge token with mode 600', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-buddy-'));
    const first = loadOrCreateConfig(home);
    const second = loadOrCreateConfig(home);
    assert.equal(second.token, first.token);
    assert.match(first.token, /^[0-9a-f]{64}$/);
    const mode = fs.statSync(path.join(home, 'config.json')).mode & 0o777;
    assert.equal(mode, 0o600);
    const dirMode = fs.statSync(home).mode & 0o777;
    assert.equal(dirMode, 0o700);

    const printed = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'token'], {
      cwd: BRIDGE_DIR,
      env: { ...process.env, PI_BUDDY_HOME: home },
      encoding: 'utf8',
    });
    assert.equal(printed.status, 0, printed.stderr);
    assert.equal(printed.stdout.trim(), first.token);
  });

  it('rejects /sim and /v1/event when Host is not a loopback name', async () => {
    await withBridge(async (bridge) => {
      const sim = await requestWithHost(bridge.port, '/sim', 'evil.example');
      assert.equal(sim.status, 403);
      assert.equal(sim.body.includes(bridge.token), false);
      assert.deepEqual(JSON.parse(sim.body), { error: 'forbidden' });

      const event = await requestWithHost(
        bridge.port,
        '/v1/event',
        'evil.example:4317',
        'POST',
        { 'content-type': 'application/json' },
        JSON.stringify({ source: 'pi', session: 's', state: 'idle', detail: 'rebind' }),
      );
      assert.equal(event.status, 403);
      assert.deepEqual(JSON.parse(event.body), { error: 'forbidden' });

      const localhost = await requestWithHost(
        bridge.port,
        '/v1/event',
        `localhost:${bridge.port}`,
        'POST',
        { 'content-type': 'application/json' },
        JSON.stringify({ source: 'pi', session: 's', state: 'idle', detail: 'via-localhost' }),
      );
      assert.equal(localhost.status, 200);

      const v6 = await requestWithHost(bridge.port, '/sim', `[::1]:${bridge.port}`);
      assert.equal(v6.status, 200);
      assert.match(v6.body, new RegExp(`"token":"${bridge.token}"`));
    });
  });

  it('rejects text/plain plugin POSTs', async () => {
    await withBridge(async (bridge) => {
      const device = openDevice(bridge.port, bridge.token);
      await device.ready;
      const forged = JSON.stringify({
        source: 'pi',
        session: 's',
        state: 'error',
        detail: 'forged-from-page',
      });
      const event = await fetch(`http://127.0.0.1:${bridge.port}/v1/event`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: forged,
      });
      assert.equal(event.status, 415);
      assert.deepEqual(await event.json(), { error: 'unsupported_media_type' });

      const permission = await fetch(`http://127.0.0.1:${bridge.port}/v1/permission`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify(permissionBody('forged', 5)),
      });
      assert.equal(permission.status, 415);

      const charset = await fetch(`http://127.0.0.1:${bridge.port}/v1/event`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ source: 'pi', session: 's', state: 'idle', detail: 'json-charset' }),
      });
      assert.equal(charset.status, 200);
      await device.waitFor((message) => message.type === 'state' && message.detail === 'json-charset');
      assert.equal(
        device.messages.some((message) => message.detail === 'forged-from-page'),
        false,
      );
      device.ws.close();
    });
  });

  it('rejects an external Origin WebSocket handshake and accepts a local Origin', async () => {
    await withBridge(async (bridge) => {
      const evil = new WebSocket(`ws://127.0.0.1:${bridge.port}/v1/device`, {
        headers: { Origin: 'https://evil.example' },
      });
      evil.on('error', () => {});
      const status = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('external origin handshake did not fail')), 2000);
        evil.on('open', () => {
          clearTimeout(timer);
          reject(new Error('external origin was accepted'));
        });
        evil.on('unexpected-response', (_request, response) => {
          clearTimeout(timer);
          response.resume();
          resolve(response.statusCode ?? 0);
        });
      });
      assert.equal(status, 403);

      const device = openDevice(bridge.port, bridge.token, 'web-sim', {
        Origin: `http://127.0.0.1:${bridge.port}`,
      });
      await device.ready;
      const ack = device.messages.find((message) => message.type === 'hello_ack');
      assert.equal(ack?.v, 1);
      device.ws.close();
    });
  });

  it('lets a paired device hello and come online', async () => {
    const arrival = pairArrival();
    await withBridge(async (bridge) => {
      const device = openPairingDevice(bridge.port, 'desk-1', '012345');
      await device.opened;
      await arrival.wait('desk-1');
      const response = await postJson(bridge.port, '/v1/pair', { code: '012345' });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { device_id: 'desk-1' });
      const paired = await device.waitFor((message) => message.type === 'pair_ok');
      assert.equal(paired.token, bridge.token);
      device.ws.send(
        JSON.stringify({
          type: 'hello',
          v: 1,
          token: paired.token,
          device_id: 'desk-1',
          fw: '1.0.0',
          board: 'pibuddy-szp-s3',
        }),
      );
      const ack = await device.waitFor((message) => message.type === 'hello_ack');
      assert.equal(ack.v, 1);
      const pending = postJson(bridge.port, '/v1/permission', permissionBody('after-pair', 3)).then((res) =>
        res.json(),
      );
      const shown = await device.waitFor((message) => message.type === 'permission' && message.summary === 'after-pair');
      device.ws.send(JSON.stringify({ type: 'permission_reply', id: shown.id, decision: 'allow' }));
      assert.deepEqual(await pending, { decision: 'allow' });
      device.ws.close();
    }, { onPairRequest: arrival.onPairRequest });
  });

  it('returns 404 when the pairing code does not match', async () => {
    const arrival = pairArrival();
    await withBridge(async (bridge) => {
      const device = openPairingDevice(bridge.port, 'desk-1', '123456');
      await device.opened;
      await arrival.wait('desk-1');
      const wrong = await postJson(bridge.port, '/v1/pair', { code: '000000' });
      assert.equal(wrong.status, 404);
      assert.deepEqual(await wrong.json(), { error: 'not_found' });
      assert.equal(
        device.messages.some((message) => message.type === 'pair_ok'),
        false,
      );
      const right = await postJson(bridge.port, '/v1/pair', { code: '123456' });
      assert.equal(right.status, 200);
      assert.deepEqual(await right.json(), { device_id: 'desk-1' });
      device.ws.close();
    }, { onPairRequest: arrival.onPairRequest });
  });

  it('clears pending pair requests after five consecutive mismatches', async () => {
    const arrival = pairArrival();
    await withBridge(async (bridge) => {
      const first = openPairingDevice(bridge.port, 'dev-a', '111111');
      const second = openPairingDevice(bridge.port, 'dev-b', '222222');
      await first.opened;
      await arrival.wait('dev-a');
      await second.opened;
      await arrival.wait('dev-b');
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const miss = await postJson(bridge.port, '/v1/pair', { code: '999999' });
        assert.equal(miss.status, 404);
      }
      const stillThere = await postJson(bridge.port, '/v1/pair', { code: '111111' });
      assert.equal(stillThere.status, 200);
      assert.deepEqual(await stillThere.json(), { device_id: 'dev-a' });
      await first.waitFor((message) => message.type === 'pair_ok');

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const miss = await postJson(bridge.port, '/v1/pair', { code: '999999' });
        assert.equal(miss.status, 404);
        assert.deepEqual(await miss.json(), { error: 'not_found' });
      }
      const cleared = await postJson(bridge.port, '/v1/pair', { code: '222222' });
      assert.equal(cleared.status, 404);
      assert.equal(
        second.messages.some((message) => message.type === 'pair_ok'),
        false,
      );

      const fresh = openPairingDevice(bridge.port, 'dev-c', '333333');
      await fresh.opened;
      await arrival.wait('dev-c');
      const again = await postJson(bridge.port, '/v1/pair', { code: '333333' });
      assert.equal(again.status, 200);
      assert.deepEqual(await again.json(), { device_id: 'dev-c' });
      first.ws.close();
      second.ws.close();
      fresh.ws.close();
    }, { onPairRequest: arrival.onPairRequest });
  });

  it('drops a pair request when that device disconnects', async () => {
    const arrival = pairArrival();
    await withBridge(async (bridge) => {
      const gone = openPairingDevice(bridge.port, 'gone', '123456');
      const stay = openPairingDevice(bridge.port, 'stay', '654321');
      await gone.opened;
      await arrival.wait('gone');
      await stay.opened;
      await arrival.wait('stay');
      const closed = new Promise<void>((resolve) => gone.ws.once('close', () => resolve()));
      gone.ws.close();
      await closed;
      const missing = await postJson(bridge.port, '/v1/pair', { code: '123456' });
      assert.equal(missing.status, 404);
      assert.deepEqual(await missing.json(), { error: 'not_found' });
      const kept = await postJson(bridge.port, '/v1/pair', { code: '654321' });
      assert.equal(kept.status, 200);
      assert.deepEqual(await kept.json(), { device_id: 'stay' });
      stay.ws.close();
    }, { onPairRequest: arrival.onPairRequest });
  });

  it('rejects /v1/pair that is not a local JSON call', async () => {
    const lan = lanAddress();
    assert.ok(lan, 'this test needs a non-loopback IPv4 address');
    const arrival = pairArrival();
    await withBridge(async (bridge) => {
      const device = openPairingDevice(bridge.port, 'desk-1', '123456');
      await device.opened;
      await arrival.wait('desk-1');

      const remote = await postJson(bridge.port, '/v1/pair', { code: '123456' }, lan);
      assert.equal(remote.status, 403);
      assert.deepEqual(await remote.json(), { error: 'forbidden' });

      const rebind = await requestWithHost(
        bridge.port,
        '/v1/pair',
        'evil.example',
        'POST',
        { 'content-type': 'application/json' },
        JSON.stringify({ code: '123456' }),
      );
      assert.equal(rebind.status, 403);
      assert.deepEqual(JSON.parse(rebind.body), { error: 'forbidden' });

      const plain = await fetch(`http://127.0.0.1:${bridge.port}/v1/pair`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ code: '123456' }),
      });
      assert.equal(plain.status, 415);
      assert.deepEqual(await plain.json(), { error: 'unsupported_media_type' });
      assert.equal(
        device.messages.some((message) => message.type === 'pair_ok'),
        false,
      );

      const local = await postJson(bridge.port, '/v1/pair', { code: '123456' });
      assert.equal(local.status, 200);
      assert.deepEqual(await local.json(), { device_id: 'desk-1' });
      device.ws.close();
    }, { onPairRequest: arrival.onPairRequest });
  });

  it('rejects the earliest pair request when a fourth one arrives', async () => {
    const arrival = pairArrival();
    await withBridge(async (bridge) => {
      const codes = ['111111', '222222', '333333', '444444'];
      const devices: Array<Device & { opened: Promise<void>; closeCode: Promise<number> }> = [];
      for (let index = 0; index < codes.length; index += 1) {
        const device = openPairingDevice(bridge.port, `d${index}`, codes[index]!);
        const closeCode = new Promise<number>((resolve) => device.ws.once('close', (code) => resolve(code)));
        await device.opened;
        await arrival.wait(`d${index}`);
        devices.push({ ...device, closeCode });
      }
      const earliest = devices[0]!;
      assert.equal(await earliest.closeCode, 1008);
      const evicted = await postJson(bridge.port, '/v1/pair', { code: '111111' });
      assert.equal(evicted.status, 404);
      const kept = await postJson(bridge.port, '/v1/pair', { code: '222222' });
      assert.equal(kept.status, 200);
      assert.deepEqual(await kept.json(), { device_id: 'd1' });
      const newest = await postJson(bridge.port, '/v1/pair', { code: '444444' });
      assert.equal(newest.status, 200);
      assert.deepEqual(await newest.json(), { device_id: 'd3' });
      for (const device of devices.slice(1)) device.ws.close();
    }, { onPairRequest: arrival.onPairRequest });
  });

  it('waits five minutes worth of pair timeout instead of the hello timeout', async () => {
    const arrival = pairArrival();
    await withBridge(
      async (bridge) => {
        const device = openPairingDevice(bridge.port, 'slow', '123456');
        await device.opened;
        await arrival.wait('slow');
        let closed = false;
        device.ws.on('close', () => {
          closed = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
        assert.equal(closed, false);
        assert.equal(device.ws.readyState, WebSocket.OPEN);
        const code = await new Promise<number>((resolve) => device.ws.once('close', (closeCode) => resolve(closeCode)));
        assert.equal(code, 4000);
        const late = await postJson(bridge.port, '/v1/pair', { code: '123456' });
        assert.equal(late.status, 404);
      },
      { helloTimeoutMs: 200, pairTimeoutMs: 1500, onPairRequest: arrival.onPairRequest },
    );
  });

  it('rejects a pair_request whose code is not six digits', async () => {
    await withBridge(async (bridge) => {
      const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/v1/device`);
      ws.on('error', () => {});
      const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
      await new Promise<void>((resolve) => ws.once('open', () => resolve()));
      ws.send(JSON.stringify({ type: 'pair_request', v: 1, device_id: 'bad', code: '12345' }));
      assert.equal(await closed, 1008);
      const response = await postJson(bridge.port, '/v1/pair', { code: '12345' });
      assert.equal(response.status, 404);
    });
  });

  it('prints the pair result from pi-buddy-bridge pair <code>', async () => {
    const arrival = pairArrival();
    await withBridge(async (bridge) => {
      const device = openPairingDevice(bridge.port, 'cli-dev', '135790');
      await device.opened;
      await arrival.wait('cli-dev');
      const env = { ...process.env, PI_BUDDY_PORT: String(bridge.port) };
      const printed = await runCli(['pair', '135790'], env);
      assert.equal(printed.status, 0, printed.stderr);
      assert.deepEqual(JSON.parse(printed.stdout), { device_id: 'cli-dev' });
      const paired = await device.waitFor((message) => message.type === 'pair_ok');
      assert.equal(paired.token, bridge.token);

      const missing = await runCli(['pair', '000000'], env);
      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr, /not_found/);

      const usage = await runCli(['pair'], env);
      assert.notEqual(usage.status, 0);
      assert.match(usage.stderr, /pi-buddy-bridge pair <code>/);
      device.ws.close();
    }, { onPairRequest: arrival.onPairRequest });
  });

  it('permission_reply 的 via 合法时进入响应和日志，非法时忽略但仍接受回复', async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((part) => String(part)).join(' '));
      original.apply(console, args);
    };
    try {
      await withBridge(async (bridge) => {
        const device = openDevice(bridge.port, bridge.token);
        await device.ready;
        const decide = async (summary: string, decision: 'allow' | 'deny', via?: unknown) => {
          const pending = postJson(bridge.port, '/v1/permission', permissionBody(summary, 5)).then((res) => res.json());
          const shown = await device.waitFor(
            (message) => message.type === 'permission' && message.summary === summary,
          );
          const reply: Record<string, unknown> = { type: 'permission_reply', id: shown.id, decision };
          if (via !== undefined) reply.via = via;
          device.ws.send(JSON.stringify(reply));
          return pending;
        };
        assert.deepEqual(await decide('voice-deny', 'deny', 'voice'), { decision: 'deny', via: 'voice' });
        assert.deepEqual(await decide('touch-deny', 'deny', 'touch'), { decision: 'deny', via: 'touch' });
        assert.deepEqual(await decide('button-allow', 'allow', 'button'), { decision: 'allow', via: 'button' });
        assert.deepEqual(await decide('bad-via', 'deny', 'shout'), { decision: 'deny' });
        assert.deepEqual(await decide('numeric-via', 'deny', 1), { decision: 'deny' });
        assert.deepEqual(await decide('missing-via', 'deny'), { decision: 'deny' });
        device.ws.close();
      }, { silent: false });
    } finally {
      console.log = original;
    }
    assert.ok(lines.some((line) => line.includes('permission reply deny via=voice')));
    assert.ok(lines.some((line) => line.includes('permission reply allow via=button')));
    assert.ok(lines.some((line) => line.includes('permission reply deny via=unknown')));
  });

  it('permission 的 project 合法时原样转发，非法时丢掉且审批继续', async () => {
    await withBridge(async (bridge) => {
      const device = openDevice(bridge.port, bridge.token);
      await device.ready;
      const emoji = '😀';
      const send = async (summary: string, project?: unknown) => {
        const body: Record<string, unknown> = permissionBody(summary, 5);
        if (project !== undefined) body.project = project;
        const pending = postJson(bridge.port, '/v1/permission', body).then((res) => res.json());
        const shown = await device.waitFor(
          (message) => message.type === 'permission' && message.summary === summary && message.queue_len === 0,
        );
        return { pending, shown };
      };
      const finish = async (id: unknown, decision: 'allow' | 'deny', pending: Promise<unknown>) => {
        device.ws.send(JSON.stringify({ type: 'permission_reply', id, decision }));
        assert.deepEqual(await pending, { decision });
      };

      const first = await send('alpha-job', 'alpha');
      assert.equal(first.shown.project, 'alpha');
      const queuedBody: Record<string, unknown> = permissionBody('beta-job', 5);
      queuedBody.project = 'beta';
      const second = postJson(bridge.port, '/v1/permission', queuedBody).then((res) => res.json());
      const updated = await device.waitFor(
        (message) => message.type === 'permission' && message.summary === 'alpha-job' && message.queue_len === 1,
      );
      assert.equal(updated.id, first.shown.id);
      assert.equal(updated.project, 'alpha');
      await finish(first.shown.id, 'allow', first.pending);
      const next = await device.waitFor((message) => message.type === 'permission' && message.summary === 'beta-job');
      assert.equal(next.project, 'beta');
      assert.equal(next.queue_len, 0);
      await finish(next.id, 'deny', second);

      const kept = await send('keep-32', 'p'.repeat(32));
      assert.equal(kept.shown.project, 'p'.repeat(32));
      await finish(kept.shown.id, 'allow', kept.pending);

      const emojiKept = await send('emoji-32', emoji.repeat(32));
      assert.equal(emojiKept.shown.project, emoji.repeat(32));
      await finish(emojiKept.shown.id, 'allow', emojiKept.pending);

      const dropped = await send('too-long', 'p'.repeat(33));
      assert.equal('project' in dropped.shown, false);
      await finish(dropped.shown.id, 'allow', dropped.pending);

      const emojiDropped = await send('emoji-33', emoji.repeat(33));
      assert.equal('project' in emojiDropped.shown, false);
      await finish(emojiDropped.shown.id, 'deny', emojiDropped.pending);

      const notString = await send('not-string', 12);
      assert.equal('project' in notString.shown, false);
      await finish(notString.shown.id, 'allow', notString.pending);

      const empty = await send('empty-project', '');
      assert.equal(empty.shown.project, '');
      await finish(empty.shown.id, 'allow', empty.pending);
      device.ws.close();
    });
  });

  it('service --help 打印子命令用法', async () => {
    const help = await runCli(['service', '--help'], { ...process.env });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /pi-buddy-bridge service <install\|uninstall\|status>/);
    assert.match(help.stdout, /dev\.pibuddy\.bridge/);
    assert.match(help.stdout, /只支持 macOS/);
    const installHelp = await runCli(['service', 'install', '--help'], { ...process.env });
    assert.equal(installHelp.status, 0);
    assert.equal(installHelp.stdout, help.stdout);
  });

  it('非 macOS 上 service 命令提示只支持 macOS', async () => {
    if (process.platform === 'darwin') return;
    for (const args of [['service'], ['service', 'install'], ['service', 'uninstall'], ['service', 'status']]) {
      const result = await runCli(args, { ...process.env });
      assert.notEqual(result.status, 0, args.join(' '));
      assert.equal(result.stderr, '只支持 macOS\n', `${args.join(' ')} stderr=${result.stderr}`);
    }
  });
});
