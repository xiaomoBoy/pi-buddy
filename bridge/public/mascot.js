/** P 仔 320×240 drawing. Cell geometry matches assets/mascot/draw.py. */

export const BG = '#26313A';
export const CREAM = '#F8F5ED';
export const TEAL = '#4F90AA';
export const DEEP = '#276D89';
export const MUTED = '#A9B0B5';
export const AMBER = '#F1BE58';
export const CORAL = '#E5645A';
export const BAR = '#1C242B';

export const S = 7;
export const OX = 112;
export const OY = 44;
export const TEXT_X = 14;
export const SCREEN_W = 320;
/** Status-bar text may run from TEXT_X to the right edge of the 320px screen. */
export const TEXT_MAX_WIDTH = SCREEN_W - TEXT_X;
export const PERMISSION_HINT = '短按允许 · 长按拒绝';

const P_ROWS = [
  '#########...',
  '###########.',
  '############',
  '####.....###',
  '####.....###',
  '####.....###',
  '####.....###',
  '############',
  '###########.',
  '#########...',
  '####........',
  '####........',
  '####........',
  '####........',
  '####........',
  '####........',
];

const DOT = ['.oo.', 'oooo', 'oooo', '.oo.'];

function cellsFrom(rows, ch) {
  const cells = [];
  for (let y = 0; y < rows.length; y += 1) {
    const row = rows[y];
    for (let x = 0; x < row.length; x += 1) {
      if (row[x] === ch) cells.push([x, y]);
    }
  }
  return cells;
}

const P_CELLS = cellsFrom(P_ROWS, '#');
const DOT_CELLS = cellsFrom(DOT, 'o');

function px(ctx, x, y, color, dx = 0, dy = 0) {
  const X = OX + (x + dx) * S;
  const Y = OY + (y + dy) * S;
  ctx.fillStyle = color;
  ctx.fillRect(X, Y, S, S);
}

function body(ctx, dy = 0, squash = false) {
  for (const [x, y] of P_CELLS) {
    if (squash && y >= 10 && y === 15) continue;
    const shift = squash && y < 10 ? 1 : 0;
    px(ctx, x, y, CREAM, 0, dy + shift);
  }
}

function dot(ctx, x, y, color = TEAL, small = false) {
  if (small) {
    for (const [cx, cy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]) {
      px(ctx, x + cx, y + cy, color);
    }
    return;
  }
  for (const [cx, cy] of DOT_CELLS) px(ctx, x + cx, y + cy, color);
}

function eyes(ctx, kind, dy = 0) {
  if (kind === 'open') {
    for (const x of [5, 7]) {
      px(ctx, x, 4, CREAM, 0, dy);
      px(ctx, x, 5, CREAM, 0, dy);
    }
  } else if (kind === 'up') {
    for (const x of [5, 7]) {
      px(ctx, x, 3, CREAM, 0, dy);
      px(ctx, x, 4, CREAM, 0, dy);
    }
  } else if (kind === 'down') {
    for (const x of [5, 7]) {
      px(ctx, x, 5, CREAM, 0, dy);
      px(ctx, x, 6, CREAM, 0, dy);
    }
  } else if (kind === 'wide') {
    for (const x0 of [4, 7]) {
      for (const cx of [0, 1]) {
        for (const cy of [3, 4]) px(ctx, x0 + cx, cy + 1, CREAM, 0, dy);
      }
    }
  } else if (kind === 'happy') {
    for (const x0 of [4, 7]) {
      px(ctx, x0, 5, CREAM, 0, dy);
      px(ctx, x0 + 1, 4, CREAM, 0, dy);
      px(ctx, x0 + 2, 5, CREAM, 0, dy);
    }
  } else if (kind === 'x') {
    for (const x0 of [4, 7]) {
      for (const [cx, cy] of [
        [0, 0],
        [2, 0],
        [1, 1],
        [0, 2],
        [2, 2],
      ]) {
        px(ctx, x0 + cx, 3 + cy, CORAL, 0, dy);
      }
    }
  } else if (kind === 'closed') {
    for (const x0 of [4, 7]) {
      px(ctx, x0, 5, CREAM, 0, dy);
      px(ctx, x0 + 1, 5, CREAM, 0, dy);
    }
  }
}

export const STATUS = {
  idle: '待机',
  thinking: '思考中',
  working: '干活中',
  permission: '请示：可以执行吗？',
  done: '完成',
  error: '出错了',
  sleep: '睡着了',
};

export const ACCENT = {
  idle: MUTED,
  thinking: TEAL,
  working: TEAL,
  permission: AMBER,
  done: CREAM,
  error: CORAL,
  sleep: MUTED,
};

const Z = [
  [0, 0],
  [1, 0],
  [2, 0],
  [1, 1],
  [0, 2],
  [1, 2],
  [2, 2],
];

/**
 * Keep `text` within `maxWidth` pixels. Overflow ends with "…".
 * @param {string} text
 * @param {number} maxWidth
 * @param {(value: string) => number} measure
 */
export function fitText(text, maxWidth, measure) {
  if (!text) return '';
  if (measure(text) <= maxWidth) return text;
  const ellipsis = '…';
  if (measure(ellipsis) > maxWidth) return '';
  const chars = Array.from(text);
  let best = 0;
  let lo = 0;
  let hi = chars.length;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = chars.slice(0, mid).join('') + ellipsis;
    if (measure(candidate) <= maxWidth) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return chars.slice(0, best).join('') + ellipsis;
}

function fitted(ctx, text) {
  if (!text) return '';
  if (typeof ctx.measureText !== 'function') return text;
  return fitText(text, TEXT_MAX_WIDTH, (value) => ctx.measureText(value).width);
}

export function permissionSummaryLine(tool, summary) {
  return [tool, summary].filter((part) => typeof part === 'string' && part.length > 0).join(' · ');
}

/**
 * @param {{ fillStyle: string, font: string, textBaseline: string, fillRect: (x: number, y: number, w: number, h: number) => void, fillText: (text: string, x: number, y: number) => void, measureText?: (text: string) => { width: number } }} ctx
 * @param {string} state
 * @param {{ status?: string, detail?: string, accent?: string, drawText?: boolean, tool?: string, summary?: string }} [options]
 */
export function drawScreen(ctx, state, options = {}) {
  const accent = options.accent ?? ACCENT[state] ?? MUTED;
  const status = options.status ?? STATUS[state] ?? '';
  const detail = options.detail ?? '';
  const drawText = options.drawText !== false;

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, 320, 240);

  if (state === 'idle') {
    body(ctx);
    eyes(ctx, 'open');
    dot(ctx, 8, 12);
  } else if (state === 'thinking') {
    body(ctx);
    eyes(ctx, 'up');
    dot(ctx, 13, -4);
    px(ctx, 12, -1, TEAL);
    px(ctx, 11, 0, TEAL);
  } else if (state === 'working') {
    body(ctx);
    eyes(ctx, 'down');
    dot(ctx, 9, 13, TEAL, true);
    for (let i = 0; i < 8; i += 1) px(ctx, 5 + i, 16, i % 2 === 0 ? MUTED : DEEP);
  } else if (state === 'permission') {
    body(ctx);
    eyes(ctx, 'wide');
    for (let y = -1; y < 3; y += 1) px(ctx, 12, y, TEAL);
    dot(ctx, 11, -5, AMBER);
  } else if (state === 'done') {
    body(ctx, -3);
    eyes(ctx, 'happy', -3);
    dot(ctx, 13, -5);
    for (const [x, y] of [
      [-3, -2],
      [15, 2],
      [-2, 6],
      [16, -2],
      [14, -7],
    ]) {
      px(ctx, x, y, CREAM);
    }
  } else if (state === 'error') {
    body(ctx);
    eyes(ctx, 'x');
    dot(ctx, 15, 12);
    px(ctx, 13, 15, MUTED);
  } else if (state === 'sleep') {
    body(ctx, 0, true);
    eyes(ctx, 'closed', 1);
    const zs = [
      [12, -1],
      [15, -4],
    ];
    for (let i = 0; i < zs.length; i += 1) {
      const [x, y] = zs[i];
      const color = i === 0 ? TEAL : DEEP;
      for (const [cx, cy] of Z) px(ctx, x + cx, y + cy, color);
    }
  }

  ctx.fillStyle = BAR;
  ctx.fillRect(0, 196, 320, 44);
  ctx.fillStyle = accent;
  ctx.fillRect(0, 196, 4, 44);

  if (!drawText) return;
  ctx.textBaseline = 'top';
  if (state === 'permission') {
    const summaryLine = permissionSummaryLine(options.tool, options.summary) || detail || status;
    ctx.font = 'bold 15px sans-serif';
    ctx.fillStyle = accent;
    ctx.fillText(fitted(ctx, summaryLine), TEXT_X, 200);
    ctx.font = '11px sans-serif';
    ctx.fillStyle = MUTED;
    ctx.fillText(PERMISSION_HINT, TEXT_X, 220);
  } else {
    ctx.font = 'bold 15px sans-serif';
    ctx.fillStyle = accent;
    ctx.fillText(status, TEXT_X, 200);
    ctx.font = '11px sans-serif';
    ctx.fillStyle = MUTED;
    ctx.fillText(fitted(ctx, detail), TEXT_X, 220);
  }
  ctx.fillText('P. pi', 262, 6);
}
