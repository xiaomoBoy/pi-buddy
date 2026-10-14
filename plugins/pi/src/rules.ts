/** Pure helpers for the pi-buddy pi extension. */

import os from 'node:os';

export type ApprovalMode = 'off' | 'dangerous' | 'bash';

export interface PathRoots {
  cwd?: string;
  home?: string;
}

export const SOURCE = 'pi';
export const EVENT_TIMEOUT_MS = 500;
export const PERMISSION_TIMEOUT_S = 120;
export const IDLE_AFTER_MS = 60_000;
export const TASK_RETRY_MS = 5_000;
export const SUMMARY_LIMIT = 40;
export const PERMISSION_LIMIT = 80;

const SHORT_FLAG = /^-[A-Za-z]{1,5}$/;

export function bridgeBase(): string {
  const raw = process.env.PI_BUDDY_URL?.trim() || 'http://127.0.0.1:4317';
  return raw.replace(/\/+$/, '');
}

export function approvalMode(): ApprovalMode {
  const raw = process.env.PI_BUDDY_APPROVAL?.trim().toLowerCase();
  if (raw === 'off' || raw === 'dangerous' || raw === 'bash') return raw;
  return 'dangerous';
}

/** `PI_BUDDY_IDLE_MS` shortens the post-done idle delay in tests. Users get 60 seconds. */
export function idleDelayMs(): number {
  const raw = process.env.PI_BUDDY_IDLE_MS;
  if (raw === undefined || raw.trim() === '') return IDLE_AFTER_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return IDLE_AFTER_MS;
  return value;
}

export function clip(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, max).join('');
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function pathRoot(prefix: string | undefined, fallback: string): string {
  const value = (prefix && prefix.trim()) || fallback;
  return value.replace(/[\\/]+$/, '');
}

/**
 * Replace a directory prefix with `.` or `~` only at a path boundary.
 * `/proj/src` with cwd `/proj` becomes `./src`, not a partial match on `/project`.
 */
function replacePathPrefix(text: string, prefix: string, replacement: string): string {
  if (!prefix || prefix === '.' || prefix === '~' || prefix === '/' || prefix === '\\') return text;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|[\\s"'\`=])${escaped}(?=$|[\\s"'\`\\\\/])`, 'g');
  return text.replace(pattern, (_match, lead: string) => `${lead}${replacement}`);
}

export function shortenPaths(text: string, roots: PathRoots = {}): string {
  const cwd = pathRoot(roots.cwd, process.cwd());
  const home = pathRoot(roots.home, os.homedir());
  return replacePathPrefix(replacePathPrefix(text, cwd, '.'), home, '~');
}

function tokensAfter(command: string, word: RegExp): string[] {
  const match = word.exec(command);
  if (!match || match.index === undefined) return [];
  return command
    .slice(match.index + match[0].length)
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function isRecursiveRm(command: string): boolean {
  const tokens = tokensAfter(command, /\brm\b/i);
  if (tokens.length === 0 && !/\brm\b/i.test(command)) return false;
  for (const token of tokens) {
    if (token === '--') break;
    if (/^--recursive(?:=.*)?$/i.test(token)) return true;
    if (token.startsWith('--')) continue;
    if (SHORT_FLAG.test(token) && /[rR]/.test(token)) return true;
  }
  return false;
}

function isForcePush(command: string): boolean {
  if (!/\bgit\s+push\b/i.test(command)) return false;
  if (/--force(?![\w-])/i.test(command)) return true;
  return command.split(/\s+/).some((token) => SHORT_FLAG.test(token) && /f/i.test(token.slice(1)));
}

function isHardReset(command: string): boolean {
  return /\bgit\s+reset\b/i.test(command) && /(?:^|\s)--hard(?:\s|$)/i.test(command);
}

function isWorldMode(command: string): boolean {
  return /\b(?:chmod|chown)\b/i.test(command) && /\b777\b/.test(command);
}

function isPipedShell(command: string): boolean {
  if (!/\b(?:curl|wget)\b/i.test(command)) return false;
  return /\|\s*(?:sudo\s+)?(?:bash|sh)\b/i.test(command);
}

export function isDangerousCommand(command: string): boolean {
  return (
    isRecursiveRm(command) ||
    /\bsudo\b/i.test(command) ||
    isWorldMode(command) ||
    isForcePush(command) ||
    isHardReset(command) ||
    /\bnpm\s+publish\b/i.test(command) ||
    isPipedShell(command)
  );
}

export function needsApproval(command: string, mode: ApprovalMode = approvalMode()): boolean {
  if (mode === 'off') return false;
  if (mode === 'bash') return true;
  return isDangerousCommand(command);
}

export function turnDetail(turn: number | undefined, modelName: string | undefined): string {
  const model = modelName?.trim();
  if (turn === undefined) return 'turn';
  if (!model) return `turn ${turn}`;
  return `turn ${turn} · ${model}`;
}

function argumentText(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const record = args as Record<string, unknown>;
  if (toolName === 'bash') {
    return typeof record.command === 'string' ? record.command : undefined;
  }
  if (toolName === 'read' || toolName === 'edit' || toolName === 'write') {
    return typeof record.path === 'string' ? record.path : undefined;
  }
  return undefined;
}

export function workingDetail(toolName: string, args: unknown, roots?: PathRoots): string {
  const summary = clip(oneLine(shortenPaths(argumentText(toolName, args) ?? '', roots)), SUMMARY_LIMIT);
  if (!summary) return toolName;
  return `${toolName} · ${summary}`;
}

export function permissionSummary(command: string, roots?: PathRoots): string {
  return clip(oneLine(shortenPaths(command, roots)), PERMISSION_LIMIT);
}

export function doneDetail(seconds: number, toolCalls: number): string {
  return `用时 ${seconds} 秒 · ${toolCalls} 次工具调用`;
}

export function modelName(model: { name?: string } | undefined): string | undefined {
  const name = model?.name?.trim();
  return name ? name : undefined;
}
