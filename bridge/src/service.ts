import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SERVICE_LABEL = 'dev.pibuddy.bridge';

export const SERVICE_HELP = `用法: pi-buddy-bridge service <install|uninstall|status>

在 macOS 上把桥接程序注册为登录时启动的 LaunchAgent（Label: dev.pibuddy.bridge）。

  install     写入 ~/Library/LaunchAgents/dev.pibuddy.bridge.plist 并 launchctl bootstrap
              已经存在时先卸载再装
              ProgramArguments 使用当前 node 与本 cli.js 的绝对路径
              RunAtLoad 和 KeepAlive 都打开
              标准输出和标准错误写到 ~/.pi-buddy/bridge.log
  uninstall   launchctl bootout 卸载并删除 plist
  status      显示是否已加载、pid、日志路径

只支持 macOS。
`;

export interface ServicePlistInput {
  nodePath: string;
  cliPath: string;
  logPath: string;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** LaunchAgent plist. Pure: it does not touch the filesystem or launchctl. */
export function servicePlist({ nodePath, cliPath, logPath }: ServicePlistInput): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(SERVICE_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(cliPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

export function launchAgentPlistPath(home = os.homedir()): string {
  return path.join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

export function bridgeLogPath(home = os.homedir()): string {
  return path.join(home, '.pi-buddy', 'bridge.log');
}

export function formatServiceStatus(loaded: boolean, pid: number | undefined, logPath: string): string {
  const pidText = loaded && pid !== undefined ? String(pid) : '无';
  return `已加载: ${loaded ? '是' : '否'}\npid: ${pidText}\n日志: ${logPath}\n`;
}

function assertMac(): void {
  if (process.platform !== 'darwin') {
    throw new Error('只支持 macOS');
  }
}

interface LaunchctlResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runLaunchctl(args: string[]): LaunchctlResult {
  const result = spawnSync('launchctl', args, { encoding: 'utf8' });
  if (result.error) {
    return { status: 1, stdout: '', stderr: result.error.message };
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function isLaunchctlAbsent(result: LaunchctlResult): boolean {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    text.includes('no such') ||
    text.includes('could not find') ||
    text.includes('not found') ||
    text.includes('boot-out failed: 3')
  );
}

export function uninstallLaunchAgent(input: { uid: number; homeDirectory?: string; quiet?: boolean }): number {
  assertMac();
  const home = input.homeDirectory ?? os.homedir();
  const plistPath = launchAgentPlistPath(home);
  const domain = `gui/${input.uid}`;
  const args = fs.existsSync(plistPath)
    ? ['bootout', domain, plistPath]
    : ['bootout', `${domain}/${SERVICE_LABEL}`];
  const boot = runLaunchctl(args);
  if (boot.status !== 0 && !isLaunchctlAbsent(boot)) {
    const detail = (boot.stderr || boot.stdout || 'launchctl bootout 失败').trim();
    process.stderr.write(`${detail}\n`);
    if (fs.existsSync(plistPath)) fs.rmSync(plistPath);
    return 1;
  }
  if (fs.existsSync(plistPath)) fs.rmSync(plistPath);
  if (!input.quiet) process.stdout.write(`已卸载 ${SERVICE_LABEL}\n`);
  return 0;
}

export function installLaunchAgent(input: {
  uid: number;
  nodePath: string;
  cliPath: string;
  homeDirectory?: string;
}): number {
  assertMac();
  const home = input.homeDirectory ?? os.homedir();
  const plistPath = launchAgentPlistPath(home);
  const logPath = bridgeLogPath(home);
  if (fs.existsSync(plistPath)) {
    const removed = uninstallLaunchAgent({ uid: input.uid, homeDirectory: home, quiet: true });
    if (removed !== 0) return removed;
  }
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  try {
    fs.chmodSync(path.dirname(logPath), 0o700);
  } catch {
    // The directory is already there; keep going if its mode cannot be changed.
  }
  fs.writeFileSync(
    plistPath,
    servicePlist({ nodePath: input.nodePath, cliPath: input.cliPath, logPath }),
    { encoding: 'utf8', mode: 0o644 },
  );
  const boot = runLaunchctl(['bootstrap', `gui/${input.uid}`, plistPath]);
  if (boot.status !== 0) {
    const detail = (boot.stderr || boot.stdout || 'launchctl bootstrap 失败').trim();
    process.stderr.write(`${detail}\n`);
    return 1;
  }
  process.stdout.write(`已安装并加载 ${SERVICE_LABEL}\n日志: ${logPath}\n`);
  return 0;
}

export function statusLaunchAgent(input: { uid: number; homeDirectory?: string }): number {
  assertMac();
  const logPath = bridgeLogPath(input.homeDirectory ?? os.homedir());
  const result = runLaunchctl(['print', `gui/${input.uid}/${SERVICE_LABEL}`]);
  if (result.status !== 0) {
    if (result.stderr.startsWith('spawn')) {
      process.stderr.write(`${result.stderr.trim()}\n`);
      return 1;
    }
    process.stdout.write(formatServiceStatus(false, undefined, logPath));
    return 0;
  }
  const pidMatch = result.stdout.match(/(?:^|\n)\s*pid = (\d+)\s*(?:\n|$)/);
  const pid = pidMatch ? Number(pidMatch[1]) : undefined;
  process.stdout.write(formatServiceStatus(true, pid, logPath));
  return 0;
}
