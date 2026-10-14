import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bonjour } from 'bonjour-service';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  HELLO_TIMEOUT_MS,
  MAX_TIMEOUT_S,
  MDNS_TXT_V,
  MDNS_TYPE,
  TASK_POLL_MS,
  aggregateSessions,
  isLoopback,
  isSessionState,
  type SessionSnapshot,
} from './protocol.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url));

export interface StartOptions {
  port?: number;
  host?: string;
  token: string;
  /** Publish `_pibuddy._tcp`. Default true. Tests pass false. */
  mdns?: boolean;
  helloTimeoutMs?: number;
  taskPollMs?: number;
  silent?: boolean;
  version?: string;
}

export interface RunningBridge {
  port: number;
  host: string;
  token: string;
  version: string;
  close: () => Promise<void>;
}

type Decision = 'allow' | 'deny' | 'timeout' | 'no_device' | 'cancelled';

interface PendingPermission {
  id: string;
  source: string;
  session: string;
  tool: string;
  summary: string;
  timeout_s: number;
  settled: boolean;
  timer?: NodeJS.Timeout;
  resolve: (decision: Decision) => void;
}

interface TaskWaiter {
  resolve: (text: string | null) => void;
  timer: NodeJS.Timeout;
  done: boolean;
}

function readVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')) as { version?: string };
  return pkg.version ?? '0.0.0';
}

function tokensEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendEmpty(res: ServerResponse, status: number): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'cache-control': 'no-store' });
  res.end();
}

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function requiredString(obj: Record<string, unknown>, key: string, allowEmpty = false): string | null {
  const value = obj[key];
  if (typeof value !== 'string') return null;
  if (!allowEmpty && value.length === 0) return null;
  return value;
}

export async function startBridge(options: StartOptions): Promise<RunningBridge> {
  const host = options.host ?? DEFAULT_HOST;
  const requestedPort = options.port ?? DEFAULT_PORT;
  const token = options.token;
  const version = options.version ?? readVersion();
  const helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
  const taskPollMs = options.taskPollMs ?? TASK_POLL_MS;
  const silent = options.silent ?? false;
  const log = (...args: unknown[]) => {
    if (!silent) console.log(...args);
  };

  const sessions = new Map<string, SessionSnapshot>();
  const devices = new Set<WebSocket>();
  const queue: PendingPermission[] = [];
  let active: PendingPermission | null = null;
  const taskQueue: string[] = [];
  const taskWaiters: TaskWaiter[] = [];

  const broadcast = (message: unknown) => {
    const data = JSON.stringify(message);
    for (const ws of devices) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  };

  const broadcastState = () => {
    const agg = aggregateSessions([...sessions.values()], active ? active.summary : null);
    broadcast({ type: 'state', state: agg.state, detail: agg.detail, sessions: agg.sessions });
  };

  const permissionMessage = (item: PendingPermission) => ({
    type: 'permission',
    id: item.id,
    source: item.source,
    tool: item.tool,
    summary: item.summary,
    timeout_s: item.timeout_s,
    queue_len: queue.length,
  });

  const showActive = () => {
    if (!active) return;
    broadcastState();
    broadcast(permissionMessage(active));
  };

  const settle = (item: PendingPermission, decision: Decision): boolean => {
    if (item.settled) return false;
    item.settled = true;
    if (item.timer) clearTimeout(item.timer);
    item.resolve(decision);
    return true;
  };

  const promote = () => {
    active = queue.shift() ?? null;
    if (!active) {
      broadcastState();
      return;
    }
    arm(active);
    showActive();
  };

  const onTimeout = (item: PendingPermission) => {
    if (item.settled || active !== item) return;
    broadcast({ type: 'permission_cancel', id: item.id, reason: 'timeout' });
    settle(item, 'timeout');
    active = null;
    promote();
  };

  const arm = (item: PendingPermission) => {
    item.timer = setTimeout(() => onTimeout(item), item.timeout_s * 1000);
  };

  const failAll = (decision: Decision) => {
    const pending = [active, ...queue].filter((item): item is PendingPermission => item !== null);
    active = null;
    queue.length = 0;
    for (const item of pending) settle(item, decision);
    broadcastState();
  };

  const cancelPermission = (id: string) => {
    if (active?.id === id) {
      if (active.settled) return;
      broadcast({ type: 'permission_cancel', id, reason: 'cancelled' });
      settle(active, 'cancelled');
      active = null;
      promote();
      return;
    }
    const index = queue.findIndex((item) => item.id === id);
    if (index < 0) return;
    const [item] = queue.splice(index, 1);
    if (item) settle(item, 'cancelled');
    if (active) broadcast(permissionMessage(active));
  };

  const startPermission = (fields: {
    source: string;
    session: string;
    tool: string;
    summary: string;
    timeout_s: number;
  }): { item: PendingPermission; done: Promise<Decision> } => {
    let resolveDecision: (decision: Decision) => void = () => {};
    const done = new Promise<Decision>((resolve) => {
      resolveDecision = resolve;
    });
    const item: PendingPermission = {
      id: randomUUID(),
      ...fields,
      settled: false,
      resolve: resolveDecision,
    };
    if (!active) {
      active = item;
      arm(item);
      showActive();
    } else {
      queue.push(item);
      broadcast(permissionMessage(active));
    }
    return { item, done };
  };

  const deliverTask = (text: string) => {
    const waiter = taskWaiters.shift();
    if (waiter && !waiter.done) {
      clearTimeout(waiter.timer);
      waiter.resolve(text);
      return;
    }
    taskQueue.push(text);
  };

  const pollTask = (waitMs: number): { promise: Promise<string | null>; cancel: () => void } => {
    const queued = taskQueue.shift();
    if (queued !== undefined) {
      return { promise: Promise.resolve(queued), cancel: () => {} };
    }
    let waiter!: TaskWaiter;
    const promise = new Promise<string | null>((resolve) => {
      waiter = {
        done: false,
        resolve: (text) => {
          if (waiter.done) return;
          waiter.done = true;
          resolve(text);
        },
        timer: setTimeout(() => {
          const index = taskWaiters.indexOf(waiter);
          if (index >= 0) taskWaiters.splice(index, 1);
          waiter.resolve(null);
        }, waitMs),
      };
      taskWaiters.push(waiter);
    });
    return {
      promise,
      cancel: () => {
        clearTimeout(waiter.timer);
        const index = taskWaiters.indexOf(waiter);
        if (index >= 0) taskWaiters.splice(index, 1);
        waiter.resolve(null);
      },
    };
  };

  const dropWaiters = () => {
    for (const waiter of taskWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
  };

  const handleHttp = async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const local = isLoopback(req.socket.remoteAddress);

    if (method === 'GET' && url.pathname === '/sim') {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, 'sim.html'), 'utf8');
      const boot = JSON.stringify({ token: local ? token : null, local }).replace(/</g, '\\u003c');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(html.replace('__BOOT_JSON__', boot));
      return;
    }

    if (method === 'GET' && (url.pathname === '/sim.js' || url.pathname === '/mascot.js')) {
      const body = fs.readFileSync(path.join(PUBLIC_DIR, url.pathname.slice(1)));
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(body);
      return;
    }

    if (method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('pi-buddy bridge\nsimulator: /sim\n');
      return;
    }

    const pluginPath =
      url.pathname === '/v1/event' || url.pathname === '/v1/permission' || url.pathname === '/v1/tasks';
    if (!pluginPath) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    const methodOk =
      (method === 'POST' && (url.pathname === '/v1/event' || url.pathname === '/v1/permission')) ||
      (method === 'GET' && url.pathname === '/v1/tasks');
    if (!methodOk) {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    if (!local) {
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }

    if (method === 'GET' && url.pathname === '/v1/tasks') {
      const source = url.searchParams.get('source');
      if (!source) {
        sendJson(res, 400, { error: 'bad_request', message: 'source is required' });
        return;
      }
      const poll = pollTask(taskPollMs);
      let finished = false;
      res.on('close', () => {
        if (!finished) poll.cancel();
      });
      const text = await poll.promise;
      finished = true;
      if (res.destroyed || res.writableEnded) return;
      if (text === null) sendEmpty(res, 204);
      else sendJson(res, 200, { text });
      return;
    }

    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = raw.length === 0 ? null : JSON.parse(raw);
    } catch {
      sendJson(res, 400, { error: 'bad_request', message: 'invalid json' });
      return;
    }
    const body = asObject(parsed);
    if (!body) {
      sendJson(res, 400, { error: 'bad_request', message: 'json object required' });
      return;
    }

    if (url.pathname === '/v1/event') {
      const source = requiredString(body, 'source');
      const session = requiredString(body, 'session');
      const detail = body.detail === undefined ? '' : requiredString(body, 'detail', true);
      if (!source || !session || detail === null || !isSessionState(body.state)) {
        sendJson(res, 400, { error: 'bad_request', message: 'invalid event' });
        return;
      }
      const key = `${source}\0${session}`;
      sessions.delete(key);
      sessions.set(key, { source, session, state: body.state, detail });
      broadcastState();
      sendJson(res, 200, { ok: true });
      return;
    }

    const source = requiredString(body, 'source');
    const session = requiredString(body, 'session');
    const tool = requiredString(body, 'tool', true);
    const summary = requiredString(body, 'summary', true);
    const timeout_s = body.timeout_s;
    if (
      !source ||
      !session ||
      tool === null ||
      summary === null ||
      typeof timeout_s !== 'number' ||
      !Number.isFinite(timeout_s) ||
      timeout_s <= 0 ||
      timeout_s > MAX_TIMEOUT_S
    ) {
      sendJson(res, 400, { error: 'bad_request', message: 'invalid permission' });
      return;
    }
    if (devices.size === 0) {
      sendJson(res, 200, { decision: 'no_device' });
      return;
    }

    const { item, done } = startPermission({ source, session, tool, summary, timeout_s });
    let finished = false;
    res.on('close', () => {
      if (!finished) cancelPermission(item.id);
    });
    const decision = await done;
    finished = true;
    if (decision === 'cancelled' || res.destroyed || res.writableEnded) return;
    sendJson(res, 200, { decision });
  };

  const server = createServer((req, res) => {
    void handleHttp(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'error';
      if (message === 'body too large') {
        sendJson(res, 413, { error: 'too_large' });
        return;
      }
      log('http error', message);
      if (!res.headersSent && !res.writableEnded) sendJson(res, 400, { error: 'bad_request' });
    });
  });
  server.requestTimeout = 0;
  server.timeout = 0;
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  const wss = new WebSocketServer({ server, path: '/v1/device', maxPayload: 1_000_000 });

  wss.on('connection', (ws) => {
    let authed = false;
    const helloTimer = setTimeout(() => {
      if (!authed) ws.close(4000, 'hello timeout');
    }, helloTimeoutMs);

    ws.on('message', (data: RawData, isBinary) => {
      if (isBinary) return;
      let message: Record<string, unknown> | null = null;
      try {
        message = asObject(JSON.parse(data.toString()));
      } catch {
        message = null;
      }
      if (!message || typeof message.type !== 'string') {
        clearTimeout(helloTimer);
        ws.close(1008, 'bad message');
        return;
      }

      if (!authed) {
        if (message.type !== 'hello') {
          clearTimeout(helloTimer);
          ws.close(1008, 'hello required');
          return;
        }
        const provided = message.token;
        const deviceId = message.device_id;
        const fw = message.fw;
        const board = message.board;
        const ok =
          message.v === 1 &&
          typeof provided === 'string' &&
          tokensEqual(provided, token) &&
          typeof deviceId === 'string' &&
          deviceId.length > 0 &&
          typeof fw === 'string' &&
          typeof board === 'string';
        if (!ok) {
          clearTimeout(helloTimer);
          log('device hello rejected');
          ws.close(1008, 'unauthorized');
          return;
        }
        authed = true;
        clearTimeout(helloTimer);
        devices.add(ws);
        log(`device online ${deviceId} fw=${fw} board=${board}`);
        ws.send(JSON.stringify({ type: 'hello_ack', v: 1, bridge_version: version }));
        const agg = aggregateSessions([...sessions.values()], active ? active.summary : null);
        ws.send(
          JSON.stringify({ type: 'state', state: agg.state, detail: agg.detail, sessions: agg.sessions }),
        );
        if (active) ws.send(JSON.stringify(permissionMessage(active)));
        return;
      }

      if (message.type === 'permission_reply') {
        const id = message.id;
        const decision = message.decision;
        if (typeof id !== 'string' || (decision !== 'allow' && decision !== 'deny')) return;
        if (!active || active.id !== id) return;
        if (!settle(active, decision)) return;
        active = null;
        promote();
        return;
      }

      if (message.type === 'task') {
        if (typeof message.text !== 'string' || message.text.length === 0) return;
        log('device task');
        deliverTask(message.text);
        return;
      }

      if (message.type === 'input') {
        const kind = message.kind;
        if (kind === 'button_short' || kind === 'button_long' || kind === 'touch' || kind === 'tap') {
          log(`device input ${kind}`);
        } else {
          log('device input unknown');
        }
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (!authed) return;
      devices.delete(ws);
      log('device offline');
      if (devices.size === 0) failAll('no_device');
    });

    ws.on('error', () => {
      log('device socket error');
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('error', onError);
      reject(error);
    };
    server.on('error', onError);
    server.listen(requestedPort, host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : requestedPort;

  let bonjour: Bonjour | null = null;
  if (options.mdns !== false) {
    try {
      bonjour = new Bonjour();
      const service = bonjour.publish({
        name: 'pi-buddy',
        type: MDNS_TYPE,
        protocol: 'tcp',
        port,
        txt: { v: MDNS_TXT_V },
      });
      service.on('error', (error: Error) => {
        log('mDNS error', error.message);
      });
    } catch (error) {
      log('mDNS publish failed', error instanceof Error ? error.message : error);
      try {
        bonjour?.destroy();
      } catch {
        /* ignore */
      }
      bonjour = null;
    }
  }

  let closed = false;
  return {
    port,
    host,
    token,
    version,
    close: async () => {
      if (closed) return;
      closed = true;
      failAll('no_device');
      dropWaiters();
      for (const ws of devices) {
        try {
          ws.close(1001, 'bridge closing');
        } catch {
          /* ignore */
        }
      }
      devices.clear();
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      if (bonjour) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            try {
              bonjour?.destroy();
            } catch {
              /* ignore */
            }
            resolve();
          }, 200);
          try {
            bonjour.unpublishAll(() => {
              clearTimeout(timer);
              try {
                bonjour?.destroy();
              } catch {
                /* ignore */
              }
              resolve();
            });
          } catch {
            clearTimeout(timer);
            resolve();
          }
        });
      }
    },
  };
}
