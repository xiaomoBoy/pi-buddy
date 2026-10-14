#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { loadOrCreateConfig } from './config.js';
import { DEFAULT_PORT } from './protocol.js';
import { startBridge } from './server.js';
import { SERVICE_HELP, installLaunchAgent, statusLaunchAgent, uninstallLaunchAgent } from './service.js';

const USAGE = '用法: pi-buddy-bridge [token | pair <code> | service <install|uninstall|status>]\n';

function serviceCommand(argv: string[]): never {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(SERVICE_HELP);
    process.exit(0);
  }
  if (process.platform !== 'darwin') {
    process.stderr.write('只支持 macOS\n');
    process.exit(1);
  }
  const uid = process.getuid?.();
  if (uid === undefined) {
    process.stderr.write('只支持 macOS\n');
    process.exit(1);
  }
  const cliPath = fileURLToPath(import.meta.url);
  const sub = argv[0];
  if (sub === 'install') {
    process.exit(installLaunchAgent({ uid, nodePath: process.execPath, cliPath }));
  }
  if (sub === 'uninstall') {
    process.exit(uninstallLaunchAgent({ uid }));
  }
  if (sub === 'status') {
    process.exit(statusLaunchAgent({ uid }));
  }
  process.stderr.write(SERVICE_HELP);
  process.exit(1);
}

function readPort(): number {
  const port = process.env.PI_BUDDY_PORT ? Number(process.env.PI_BUDDY_PORT) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write('PI_BUDDY_PORT 无效\n');
    process.exit(1);
  }
  return port;
}

const arg = process.argv[2];

if (arg === '--help' || arg === '-h') {
  process.stdout.write(USAGE);
  process.exit(0);
}

if (arg === 'token') {
  const config = loadOrCreateConfig();
  process.stdout.write(`${config.token}\n`);
  process.exit(0);
}

if (arg === 'service') {
  serviceCommand(process.argv.slice(3));
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
  process.stderr.write(USAGE);
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
