#!/usr/bin/env node
import { loadOrCreateConfig } from './config.js';
import { DEFAULT_PORT } from './protocol.js';
import { startBridge } from './server.js';

const arg = process.argv[2];

if (arg === 'token') {
  const config = loadOrCreateConfig();
  process.stdout.write(`${config.token}\n`);
  process.exit(0);
}

if (arg) {
  process.stderr.write('用法: pi-buddy-bridge [token]\n');
  process.exit(1);
}

const port = process.env.PI_BUDDY_PORT ? Number(process.env.PI_BUDDY_PORT) : DEFAULT_PORT;
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write('PI_BUDDY_PORT 无效\n');
  process.exit(1);
}

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
