#!/usr/bin/env node
import { loadOrCreateConfig } from './config.js';
import { DEFAULT_PORT } from './protocol.js';
import { startBridge } from './server.js';

function readPort(): number {
  const port = process.env.PI_BUDDY_PORT ? Number(process.env.PI_BUDDY_PORT) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write('PI_BUDDY_PORT 无效\n');
    process.exit(1);
  }
  return port;
}

const arg = process.argv[2];

if (arg === 'token') {
  const config = loadOrCreateConfig();
  process.stdout.write(`${config.token}\n`);
  process.exit(0);
}

if (arg === 'pair') {
  const code = process.argv[3];
  if (!code) {
    process.stderr.write('用法: pi-buddy-bridge pair <code>\n');
    process.exit(1);
  }
  const port = readPort();
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`无法连接桥接程序（${message}）\n`);
    process.exit(1);
  }
  const text = await response.text();
  const output = text.length === 0 || text.endsWith('\n') ? text : `${text}\n`;
  if (response.ok) {
    process.stdout.write(output);
    process.exit(0);
  }
  process.stderr.write(output);
  process.exit(1);
}

if (arg) {
  process.stderr.write('用法: pi-buddy-bridge [token | pair <code>]\n');
  process.exit(1);
}

const port = readPort();
const config = loadOrCreateConfig();
const bridge = await startBridge({ port, host: '0.0.0.0', token: config.token, mdns: true });
process.stdout.write(`pi-buddy-bridge 监听 0.0.0.0:${bridge.port}\n`);
process.stdout.write(`模拟器 http://127.0.0.1:${bridge.port}/sim\n`);

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void bridge.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
