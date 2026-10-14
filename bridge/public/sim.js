import { ACCENT, STATUS, drawScreen, permissionDetail } from './mascot.js';

const boot = JSON.parse(document.getElementById('boot').textContent || '{}');
const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

const allowBtn = document.getElementById('allow');
const denyBtn = document.getElementById('deny');
const taskForm = document.getElementById('task-form');
const taskInput = document.getElementById('task-text');
const queueEl = document.getElementById('queue');
const linkEl = document.getElementById('link');

const params = new URLSearchParams(location.search);
const sleepParam = params.get('sleep_ms');
const SLEEP_MS = sleepParam !== null && Number(sleepParam) >= 0 ? Number(sleepParam) : 5 * 60 * 1000;

const model = {
  state: 'idle',
  detail: '',
  tool: '',
  summary: '',
  permissionId: null,
  queueLen: 0,
};
let sleeping = false;
let sleepTimer = 0;
let socket = null;
let reconnectTimer = 0;

function armSleep() {
  window.clearTimeout(sleepTimer);
  if (sleeping) return;
  if (model.state !== 'idle' || model.permissionId) return;
  sleepTimer = window.setTimeout(() => {
    if (model.state === 'idle' && !model.permissionId) {
      sleeping = true;
      render();
    }
  }, SLEEP_MS);
}

function wake() {
  sleeping = false;
  armSleep();
}

function render() {
  const state = sleeping ? 'sleep' : model.state;
  let detail = model.detail;
  if (state === 'permission') detail = permissionDetail(model.tool, model.summary || model.detail);
  if (state === 'sleep') detail = '闲置 5 分钟 · 摸一下屏幕叫醒';
  drawScreen(ctx, state, {
    status: STATUS[state] ?? '',
    detail,
    accent: ACCENT[state],
  });
  const pending = Boolean(model.permissionId) && socket && socket.readyState === WebSocket.OPEN;
  allowBtn.disabled = !pending;
  denyBtn.disabled = !pending;
  if (model.permissionId && model.queueLen > 0) {
    queueEl.hidden = false;
    queueEl.textContent = `还有 ${model.queueLen} 条在排队`;
  } else {
    queueEl.hidden = true;
    queueEl.textContent = '';
  }
}

function setLink(text) {
  linkEl.textContent = text;
}

function reply(decision) {
  if (!model.permissionId || !socket || socket.readyState !== WebSocket.OPEN) return;
  const id = model.permissionId;
  model.permissionId = null;
  render();
  socket.send(JSON.stringify({ type: 'permission_reply', id, decision }));
}

allowBtn.addEventListener('click', () => reply('allow'));
denyBtn.addEventListener('click', () => reply('deny'));

taskForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = taskInput.value.trim();
  if (!text || !socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'task', text }));
  taskInput.value = '';
});

canvas.addEventListener('pointerdown', () => {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'input', kind: 'touch' }));
  }
  if (sleeping) {
    wake();
    render();
  }
});

function onMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'hello_ack') {
    setLink(`已连接 · bridge ${msg.bridge_version ?? ''}`);
    return;
  }
  if (msg.type === 'state') {
    model.state = typeof msg.state === 'string' ? msg.state : 'idle';
    model.detail = typeof msg.detail === 'string' ? msg.detail : '';
    if (model.state !== 'permission') {
      model.permissionId = null;
      model.tool = '';
      model.summary = '';
      model.queueLen = 0;
    }
    wake();
    render();
    return;
  }
  if (msg.type === 'permission') {
    model.state = 'permission';
    model.permissionId = typeof msg.id === 'string' ? msg.id : null;
    model.tool = typeof msg.tool === 'string' ? msg.tool : '';
    model.summary = typeof msg.summary === 'string' ? msg.summary : '';
    model.queueLen = typeof msg.queue_len === 'number' ? msg.queue_len : 0;
    wake();
    render();
    return;
  }
  if (msg.type === 'permission_cancel' && msg.id === model.permissionId) {
    model.permissionId = null;
    render();
  }
}

function connect() {
  if (!boot.local || !boot.token) {
    setLink('模拟器只在本机打开时连接设备');
    return;
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/v1/device`);
  socket = ws;
  ws.addEventListener('open', () => {
    setLink('正在握手…');
    ws.send(
      JSON.stringify({
        type: 'hello',
        v: 1,
        token: boot.token,
        device_id: `web-sim-${crypto.randomUUID()}`,
        fw: 'sim',
        board: 'web',
      }),
    );
  });
  ws.addEventListener('message', (event) => onMessage(String(event.data)));
  ws.addEventListener('close', () => {
    if (socket !== ws) return;
    setLink('未连接，正在重试…');
    allowBtn.disabled = true;
    denyBtn.disabled = true;
    window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(connect, 1000);
  });
  ws.addEventListener('error', () => {
    setLink('连接失败');
  });
}

render();
armSleep();
connect();
