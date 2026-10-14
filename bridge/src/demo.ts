/**
 * Walk the simulator through idle → thinking → working → one permission → done → error → idle.
 * Start the bridge first (`npm start`), open http://127.0.0.1:4317/sim, then run `npm run demo`.
 */

const port = process.env.PI_BUDDY_PORT ?? '4317';
const base = process.env.PI_BUDDY_URL ?? `http://127.0.0.1:${port}`;
const session = 'demo';

const events: Array<{ state: string; detail: string }> = [
  { state: 'idle', detail: 'pi 在等你的下一个任务' },
  { state: 'thinking', detail: 'turn 3 · deepseek-v4-flash' },
  { state: 'working', detail: 'bash · npm test' },
];

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function post(pathname: string, body: unknown): Promise<Response> {
  try {
    return await fetch(`${base}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`连不上 ${base}（${message}）。请先在 bridge 目录执行 npm start。\n`);
    process.exit(1);
  }
}

async function sendEvent(state: string, detail: string): Promise<void> {
  const res = await post('/v1/event', { source: 'pi', session, state, detail });
  if (!res.ok) {
    process.stderr.write(`event ${state} 失败：HTTP ${res.status} ${await res.text()}\n`);
    process.exit(1);
  }
  process.stdout.write(`${state}  ${detail}\n`);
}

for (const event of events) {
  await sendEvent(event.state, event.detail);
  await pause(1500);
}

process.stdout.write('permission  bash · rm -rf dist（在模拟器上点允许或拒绝）\n');
const perm = await post('/v1/permission', {
  source: 'pi',
  session,
  tool: 'bash',
  summary: 'rm -rf dist',
  timeout_s: 120,
  project: 'pi-buddy',
});
if (!perm.ok) {
  process.stderr.write(`permission 失败：HTTP ${perm.status} ${await perm.text()}\n`);
  process.exit(1);
}
const decision = (await perm.json()) as { decision?: string };
process.stdout.write(`permission → ${decision.decision ?? 'unknown'}\n`);
await pause(800);

await sendEvent('done', '3 个文件已修改 · 用时 42 秒');
await pause(1500);
await sendEvent('error', 'npm test 失败：2 个用例未通过');
await pause(1500);
await sendEvent('idle', 'pi 在等你的下一个任务');
process.stdout.write('demo 结束\n');
