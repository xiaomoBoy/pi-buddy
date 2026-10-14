import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
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
  options: { helloTimeoutMs?: number; taskPollMs?: number; token?: string } = {},
): Promise<void> {
  const bridge = await startBridge({
    host: '0.0.0.0',
    port: 0,
    token: options.token ?? 'test-token',
    mdns: false,
    silent: true,
    helloTimeoutMs: options.helloTimeoutMs ?? 400,
    taskPollMs: options.taskPollMs ?? 250,
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

function openDevice(port: number, token: string, deviceId = 'dev-test'): Device {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/device`);
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

function permissionBody(summary: string, timeout_s = 5) {
  return { source: 'pi', session: 's', tool: 'bash', summary, timeout_s };
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
      const remoteHtml = await remotePage.text();
      assert.equal(remoteHtml.includes(bridge.token), false);
      assert.match(remoteHtml, /"token":null/);

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
});
