import { ACCENT, STATUS, drawScreen, permissionCornerLabel, simulatorPermissionReply } from './mascot.js';

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
  project: '',
  permissionId: null,
  queueLen: 0,
  deadlineMs: 0,
};
let sleeping = false;
let sleepTimer = 0;
let cornerTimer = 0;
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

function syncCornerTimer() {
  const active = Boolean(model.permissionId);
  if (active && !cornerTimer) {
    cornerTimer = window.setInterval(() => {
      render();
    }, 250);
  } else if (!active && cornerTimer) {
    window.clearInterval(cornerTimer);
    cornerTimer = 0;
  }
}

function render() {
  const state = sleeping ? 'sleep' : model.state;
  let detail = model.detail;
  if (state === 'sleep') detail = '闲置 5 分钟 · 摸一下屏幕叫醒';
  const permission = state === 'permission';
  const secondsLeft = model.deadlineMs > 0 ? (model.deadlineMs - Date.now()) / 1000 : 0;
  const corner = permission && model.permissionId ? permissionCornerLabel(model.project, secondsLeft) : '';
  drawScreen(ctx, state, {
    status: STATUS[state] ?? '',
    detail,
    accent: ACCENT[state],
    tool: permission ? model.tool : '',
    summary: permission ? model.summary || model.detail : '',
    corner,
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
  syncCornerTimer();
}

function setLink(text) {
  linkEl.textContent = text;
}

function reply(decision) {
  if (!model.permissionId || !socket || socket.readyState !== WebSocket.OPEN) return;
  const id = model.permissionId;
  model.permissionId = null;
  model.project = '';
  model.deadlineMs = 0;
  render();
  socket.send(JSON.stringify(simulatorPermissionReply(id, decision)));
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
      model.project = '';
      model.queueLen = 0;
      model.deadlineMs = 0;
    }
    wake();
    render();
    return;
  }
  if (msg.type === 'permission') {
    const id = typeof msg.id === 'string' ? msg.id : null;
    const fresh = id !== model.permissionId;
    model.state = 'permission';
    model.permissionId = id;
    model.tool = typeof msg.tool === 'string' ? msg.tool : '';
    model.summary = typeof msg.summary === 'string' ? msg.summary : '';
    model.queueLen = typeof msg.queue_len === 'number' ? msg.queue_len : 0;
    if (typeof msg.project === 'string') model.project = msg.project;
    else if (fresh) model.project = '';
    if (fresh) {
      const timeoutS =
        typeof msg.timeout_s === 'number' && Number.isFinite(msg.timeout_s) && msg.timeout_s > 0
          ? msg.timeout_s
          : 120;
      model.deadlineMs = Date.now() + timeoutS * 1000;
    }
    wake();
    render();
    return;
  }
  if (msg.type === 'permission_cancel' && msg.id === model.permissionId) {
    model.permissionId = null;
    model.project = '';
    model.deadlineMs = 0;
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
