/**
 * pi-buddy extension for the pi coding agent.
 *
 * Syncs session state to the bridge, asks the device and the terminal before
 * dangerous bash commands, and delivers voice tasks while the TUI is open.
 * Long-lived work starts in session_start and is released in session_shutdown.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';
import {
  EVENT_TIMEOUT_MS,
  PERMISSION_TIMEOUT_S,
  SOURCE,
  TASK_RETRY_MS,
  approvalMode,
  bridgeBase,
  doneDetail,
  idleDelayMs,
  modelName,
  needsApproval,
  permissionSummary,
  turnDetail,
  workingDetail,
} from './src/rules.ts';

const DENIED_ON_DEVICE = '在 P 仔上被拒绝';
const DENIED_ON_TERMINAL = '在终端被拒绝';
const TIMED_OUT = '在 P 仔上等待超时';
const BLOCKED_NO_UI = '危险命令已拦截（没有界面可确认）';
const BLOCKED_ERROR = '审批失败，已拦截';
const TASK_NOTICE = '收到 P 仔派来的任务';
const BRIDGE_DOWN = 'P 仔桥接连不上，状态暂停同步';
const ERROR_DETAIL = '出错';

type SessionState = 'idle' | 'thinking' | 'working' | 'done' | 'error';
type DeviceDecision = 'allow' | 'deny' | 'timeout' | 'fallback';

interface UiResult {
  kind: 'ui';
  yes: boolean;
  dismissed: boolean;
}

interface HttpResult {
  kind: 'http';
  decision: DeviceDecision;
}

export default function (pi: ExtensionAPI) {
  let running = false;
  let errored = false;
  let toolCount = 0;
  let runStartedAt: number | undefined;
  let thinkingDetail = 'turn';
  let failureStreak = 0;
  let postTail = Promise.resolve();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let pollAbort: AbortController | undefined;
  let latestUi: ExtensionContext['ui'] | undefined;
  const inflight = new Set<string>();

  const note = (ctx: ExtensionContext) => {
    latestUi = ctx.ui;
  };

  const sessionOf = (ctx: ExtensionContext): string => {
    try {
      return ctx.sessionManager.getSessionId();
    } catch {
      return '';
    }
  };

  const clearIdleTimer = () => {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const scheduleIdle = (ctx: ExtensionContext) => {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      enqueueState('idle', '', ctx);
    }, idleDelayMs());
    idleTimer.unref?.();
  };

  const warnOnce = (ui: ExtensionContext['ui'] | undefined) => {
    failureStreak += 1;
    if (failureStreak !== 1) return;
    try {
      ui?.notify(BRIDGE_DOWN, 'warning');
    } catch {
      // A missing terminal must not surface as an extension error.
    }
  };

  const sendEvent = async (state: SessionState, detail: string, session: string, ui: ExtensionContext['ui']) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EVENT_TIMEOUT_MS);
    try {
      const response = await fetch(`${bridgeBase()}/v1/event`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: SOURCE, session, state, detail }),
        signal: controller.signal,
      });
      if (!response.ok) {
        warnOnce(ui);
        return;
      }
      failureStreak = 0;
    } catch {
      warnOnce(ui);
    } finally {
      clearTimeout(timer);
    }
  };

  const enqueueState = (state: SessionState, detail: string, ctx: ExtensionContext) => {
    if (!running) return;
    const session = sessionOf(ctx);
    const ui = ctx.ui;
    postTail = postTail.then(() => sendEvent(state, detail, session, ui)).catch(() => {});
  };

  const rememberTurn = (ctx: ExtensionContext, turn: number) => {
    thinkingDetail = turnDetail(turn, modelName(ctx.model));
  };

  const postThinking = (ctx: ExtensionContext) => {
    clearIdleTimer();
    enqueueState('thinking', thinkingDetail, ctx);
  };

  const stopPoll = () => {
    const abort = pollAbort;
    pollAbort = undefined;
    abort?.abort();
  };

  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener('abort', finish, { once: true });
    });

  const pollTasks = async (signal: AbortSignal) => {
    while (!signal.aborted && running) {
      try {
        const response = await fetch(`${bridgeBase()}/v1/tasks?source=${encodeURIComponent(SOURCE)}`, { signal });
        if (signal.aborted || !running) return;
        if (response.status === 204) continue;
        if (response.status === 200) {
          let text = '';
          try {
            const body = (await response.json()) as { text?: unknown };
            if (typeof body.text === 'string') text = body.text;
          } catch {
            text = '';
          }
          if (text.length > 0) {
            pi.sendUserMessage(text, { deliverAs: 'followUp' });
            try {
              latestUi?.notify(TASK_NOTICE, 'info');
            } catch {
              // ignore
            }
            continue;
          }
        }
        await sleep(TASK_RETRY_MS, signal);
      } catch {
        if (signal.aborted || !running) return;
        await sleep(TASK_RETRY_MS, signal);
      }
    }
  };

  const startPoll = () => {
    stopPoll();
    const controller = new AbortController();
    pollAbort = controller;
    void pollTasks(controller.signal);
  };

  const stop = (ctx: ExtensionContext) => {
    if (!running) return;
    clearIdleTimer();
    inflight.clear();
    enqueueState('idle', '', ctx);
    running = false;
    stopPoll();
  };

  const start = (ctx: ExtensionContext) => {
    if (running) stop(ctx);
    running = true;
    errored = false;
    toolCount = 0;
    runStartedAt = undefined;
    thinkingDetail = 'turn';
    failureStreak = 0;
    inflight.clear();
    note(ctx);
    if (ctx.mode === 'tui') startPoll();
    enqueueState('idle', '', ctx);
  };

  const bashCommand = (event: ToolCallEvent): string | undefined => {
    if (event.toolName !== 'bash') return undefined;
    const command = (event.input as { command?: unknown }).command;
    return typeof command === 'string' ? command : undefined;
  };

  const askDevice = async (tool: string, summary: string, session: string, signal: AbortSignal): Promise<DeviceDecision> => {
    try {
      const response = await fetch(`${bridgeBase()}/v1/permission`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: SOURCE,
          session,
          tool,
          summary,
          timeout_s: PERMISSION_TIMEOUT_S,
        }),
        signal,
      });
      if (!response.ok) return 'fallback';
      const body = (await response.json()) as { decision?: unknown };
      if (body.decision === 'allow' || body.decision === 'deny' || body.decision === 'timeout') {
        return body.decision;
      }
      return 'fallback';
    } catch {
      return 'fallback';
    }
  };

  const askTerminal = (ctx: ExtensionContext, command: string, signal: AbortSignal): Promise<UiResult> => {
    const summary = permissionSummary(command, { cwd: ctx.cwd });
    return ctx.ui
      .confirm('P 仔审批', `危险命令：\n\n  ${summary}\n\n允许执行？`, { signal })
      .then(
        (yes) => ({ kind: 'ui' as const, yes: yes === true, dismissed: signal.aborted }),
        () => ({ kind: 'ui' as const, yes: false, dismissed: true }),
      );
  };

  const fromDevice = (decision: DeviceDecision): ToolCallEventResult | undefined => {
    if (decision === 'allow') return undefined;
    if (decision === 'deny') return { block: true, reason: DENIED_ON_DEVICE };
    if (decision === 'timeout') return { block: true, reason: TIMED_OUT };
    return { block: true, reason: BLOCKED_NO_UI };
  };

  const fromTerminal = (ui: UiResult): ToolCallEventResult | undefined => {
    if (ui.dismissed) return { block: true, reason: BLOCKED_NO_UI };
    if (ui.yes) return undefined;
    return { block: true, reason: DENIED_ON_TERMINAL };
  };

  const gate = async (ctx: ExtensionContext, command: string): Promise<ToolCallEventResult | undefined> => {
    const httpAbort = new AbortController();
    const uiAbort = new AbortController();
    const httpPromise = askDevice('bash', permissionSummary(command, { cwd: ctx.cwd }), sessionOf(ctx), httpAbort.signal);
    const uiPromise = ctx.hasUI ? askTerminal(ctx, command, uiAbort.signal) : undefined;

    if (!uiPromise) {
      return fromDevice(await httpPromise);
    }

    const httpTagged: Promise<HttpResult> = httpPromise.then((decision) => ({ kind: 'http', decision }));
    const first = await Promise.race([httpTagged, uiPromise]);

    if (first.kind === 'ui') {
      httpAbort.abort();
      return fromTerminal(first);
    }

    if (first.decision === 'allow' || first.decision === 'deny' || first.decision === 'timeout') {
      uiAbort.abort();
      return fromDevice(first.decision);
    }

    return fromTerminal(await uiPromise);
  };

  pi.on('session_start', (_event, ctx) => {
    try {
      start(ctx);
    } catch {
      // session startup must not take pi down with it
    }
  });

  pi.on('session_shutdown', (_event, ctx) => {
    try {
      note(ctx);
      stop(ctx);
    } catch {
      running = false;
      stopPoll();
      clearIdleTimer();
    }
  });

  pi.on('agent_start', (_event, ctx) => {
    try {
      note(ctx);
      errored = false;
      toolCount = 0;
      inflight.clear();
      runStartedAt = Date.now();
      rememberTurn(ctx, 1);
      postThinking(ctx);
    } catch {
      // ignore
    }
  });

  pi.on('turn_start', (event, ctx) => {
    try {
      note(ctx);
      rememberTurn(ctx, event.turnIndex + 1);
      postThinking(ctx);
    } catch {
      // ignore
    }
  });

  pi.on('tool_execution_start', (event, ctx) => {
    try {
      note(ctx);
      const added = !inflight.has(event.toolCallId);
      inflight.add(event.toolCallId);
      if (added) toolCount += 1;
      clearIdleTimer();
      enqueueState('working', workingDetail(event.toolName, event.args, { cwd: ctx.cwd }), ctx);
    } catch {
      // ignore
    }
  });

  pi.on('tool_execution_end', (event, ctx) => {
    try {
      note(ctx);
      inflight.delete(event.toolCallId);
      if (inflight.size === 0 && !errored) postThinking(ctx);
    } catch {
      // ignore
    }
  });

  pi.on('agent_before_settle', (event, ctx) => {
    try {
      note(ctx);
      if (event.outcome !== 'error') return;
      errored = true;
      inflight.clear();
      clearIdleTimer();
      enqueueState('error', ERROR_DETAIL, ctx);
      scheduleIdle(ctx);
    } catch {
      // ignore
    }
  });

  pi.on('agent_settled', (_event, ctx) => {
    try {
      note(ctx);
      if (errored) return;
      const seconds =
        runStartedAt === undefined ? 0 : Math.max(0, Math.round((Date.now() - runStartedAt) / 1000));
      clearIdleTimer();
      enqueueState('done', doneDetail(seconds, toolCount), ctx);
      scheduleIdle(ctx);
    } catch {
      // ignore
    }
  });

  pi.on('tool_call', async (event, ctx) => {
    note(ctx);
    if (event.toolName !== 'bash') return undefined;
    const command = bashCommand(event) ?? '';
    if (!needsApproval(command)) return undefined;
    try {
      return await gate(ctx, command);
    } catch {
      return { block: true, reason: BLOCKED_ERROR };
    }
  });
}
