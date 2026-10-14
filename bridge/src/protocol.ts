/** Protocol v1.1 constants and pure helpers. See docs/protocol.md. */

export const DEFAULT_PORT = 4317;
export const DEFAULT_HOST = '0.0.0.0';
export const HELLO_TIMEOUT_MS = 5_000;
/** A connection that sent `pair_request` has this long to finish `hello`. */
export const PAIR_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_PENDING_PAIRS = 3;
export const MAX_PAIR_FAILURES = 5;
export const TASK_POLL_MS = 30_000;
export const MAX_TIMEOUT_S = 86_400;
export const MDNS_TYPE = 'pibuddy';
export const MDNS_TXT_V = '1';

export const SESSION_STATES = ['idle', 'thinking', 'working', 'done', 'error'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/** Highest priority first. `permission` is bridge-derived, not a session state. */
export const AGGREGATE_PRIORITY = [
  'permission',
  'error',
  'working',
  'thinking',
  'done',
  'idle',
] as const;

export type AggregateState = (typeof AGGREGATE_PRIORITY)[number];

export interface SessionSnapshot {
  source: string;
  session: string;
  state: SessionState;
  detail: string;
}

export interface Aggregate {
  state: AggregateState;
  detail: string;
  sessions: SessionSnapshot[];
}

const RANK = new Map<string, number>(AGGREGATE_PRIORITY.map((state, index) => [state, index]));

export function isSessionState(value: unknown): value is SessionState {
  return typeof value === 'string' && (SESSION_STATES as readonly string[]).includes(value);
}

/**
 * Loopback is exactly 127.0.0.1 or ::1.
 * `::ffff:127.0.0.1` is the IPv4 loopback address as Node reports it on dual-stack sockets.
 */
export function isLoopback(address: string | undefined | null): boolean {
  if (!address) return false;
  if (address === '127.0.0.1' || address === '::1') return true;
  if (address.startsWith('::ffff:')) return isLoopback(address.slice('::ffff:'.length));
  return false;
}

/** Host / Origin hostname the browser may use for this machine. Port is ignored. */
const LOCAL_BROWSER_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function isLocalBrowserHostname(hostname: string | undefined | null): boolean {
  if (!hostname) return false;
  return LOCAL_BROWSER_HOSTS.has(hostname.toLowerCase());
}

/** `Host` header value, any port. Rejects missing, userinfo, and non-local names. */
export function isLocalHttpHost(hostHeader: string | undefined | null): boolean {
  if (!hostHeader) return false;
  const value = hostHeader.trim();
  if (value.length === 0 || value.includes('@') || /[\s/\\]/.test(value)) return false;
  try {
    return isLocalBrowserHostname(new URL(`http://${value}`).hostname);
  } catch {
    return false;
  }
}

/** Browser `Origin` header. Absent origins are not local page origins. */
export function isLocalPageOrigin(origin: string | undefined | null): boolean {
  if (!origin) return false;
  try {
    return isLocalBrowserHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** `application/json` with an optional charset parameter. */
export function isJsonContentType(header: string | undefined | null): boolean {
  if (!header) return false;
  const media = header.split(';', 1)[0]?.trim().toLowerCase();
  return media === 'application/json';
}

/** Device pairing codes are exactly six digits, kept as a string so leading zeros survive. */
export function isPairCode(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{6}$/.test(value);
}

export const REPLY_VIAS = ['touch', 'button', 'voice'] as const;
export type ReplyVia = (typeof REPLY_VIAS)[number];

/** A missing or unrecognized `via` is unknown. The reply itself still stands. */
export function normalizeReplyVia(value: unknown): ReplyVia | undefined {
  if (value === 'touch' || value === 'button' || value === 'voice') return value;
  return undefined;
}

/** Unicode code points, not UTF-16 code units. */
export const MAX_PROJECT_CHARS = 32;

/**
 * Keep a legal `project` string. Anything else is dropped and the permission continues.
 * An empty string is legal and is forwarded as-is.
 */
export function normalizeProject(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (Array.from(value).length > MAX_PROJECT_CHARS) return undefined;
  return value;
}

/**
 * Pick one summary for the device.
 * Equal priority: the later snapshot wins (callers append the most recently updated session last).
 * A pending permission outranks every session.
 */
export function aggregateSessions(
  sessions: readonly SessionSnapshot[],
  permissionSummary: string | null,
): Aggregate {
  const list = sessions.map((session) => ({ ...session }));
  if (permissionSummary !== null) {
    return { state: 'permission', detail: permissionSummary, sessions: list };
  }
  if (list.length === 0) {
    return { state: 'idle', detail: '', sessions: list };
  }
  let best = list[0]!;
  let bestRank = RANK.get(best.state) ?? Number.POSITIVE_INFINITY;
  for (let i = 1; i < list.length; i++) {
    const candidate = list[i]!;
    const rank = RANK.get(candidate.state) ?? Number.POSITIVE_INFINITY;
    if (rank <= bestRank) {
      best = candidate;
      bestRank = rank;
    }
  }
  return { state: best.state, detail: best.detail, sessions: list };
}
