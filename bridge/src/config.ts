import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface BridgeConfig {
  token: string;
}

/** `PI_BUDDY_HOME` overrides the default `~/.pi-buddy` directory (tests and local runs). */
export function buddyHome(): string {
  if (process.env.PI_BUDDY_HOME) return path.resolve(process.env.PI_BUDDY_HOME);
  return path.join(os.homedir(), '.pi-buddy');
}

export function configFile(home = buddyHome()): string {
  return path.join(home, 'config.json');
}

function writeConfig(file: string, config: BridgeConfig): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o700);
  const body = `${JSON.stringify(config, null, 2)}\n`;
  fs.writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** Load `config.json`, creating a random token with mode 600 the first time. */
export function loadOrCreateConfig(home = buddyHome()): BridgeConfig {
  const file = configFile(home);
  if (!fs.existsSync(file)) {
    writeConfig(file, { token: randomBytes(32).toString('hex') });
  } else {
    fs.chmodSync(file, 0o600);
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !('token' in parsed)) {
    throw new Error(`invalid config: ${file}`);
  }
  const token = (parsed as { token: unknown }).token;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(`invalid token in ${file}`);
  }
  return { token };
}
