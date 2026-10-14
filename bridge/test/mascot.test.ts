import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { drawScreen } from '../public/mascot.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATES = ['idle', 'thinking', 'working', 'permission', 'done', 'error', 'sleep'] as const;

const CREAM: Rgb = [0xf8, 0xf5, 0xed];
const TEAL: Rgb = [0x4f, 0x90, 0xaa];
const MUTED: Rgb = [0xa9, 0xb0, 0xb5];
const AMBER: Rgb = [0xf1, 0xbe, 0x58];
const CORAL: Rgb = [0xe5, 0x64, 0x5a];
const BAR: Rgb = [0x1c, 0x24, 0x2b];
const BG: Rgb = [0x26, 0x31, 0x3a];

type Rgb = [number, number, number];

function parseHex(style: string): Rgb {
  const match = /^#([0-9a-f]{6})$/i.exec(style);
  if (!match?.[1]) throw new Error(`bad fill ${style}`);
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function render(state: string): Buffer {
  const width = 320;
  const height = 240;
  const data = Buffer.alloc(width * height * 3);
  const ctx = {
    fillStyle: '#000000',
    font: '',
    textBaseline: 'top',
    fillRect(x: number, y: number, rectWidth: number, rectHeight: number) {
      const [red, green, blue] = parseHex(ctx.fillStyle);
      let x0 = Math.floor(x);
      let y0 = Math.floor(y);
      let x1 = Math.floor(x + rectWidth);
      let y1 = Math.floor(y + rectHeight);
      if (x0 < 0) x0 = 0;
      if (y0 < 0) y0 = 0;
      if (x1 > width) x1 = width;
      if (y1 > height) y1 = height;
      for (let yy = y0; yy < y1; yy += 1) {
        for (let xx = x0; xx < x1; xx += 1) {
          const index = (yy * width + xx) * 3;
          data[index] = red;
          data[index + 1] = green;
          data[index + 2] = blue;
        }
      }
    },
    fillText() {},
  };
  drawScreen(ctx, state, { drawText: false });
  return data;
}

function pixel(data: Buffer, x: number, y: number): Rgb {
  const index = (y * 320 + x) * 3;
  return [data[index] ?? 0, data[index + 1] ?? 0, data[index + 2] ?? 0];
}

describe('mascot canvas', () => {
  it('uses the draw.py grid, origin, and status bar', () => {
    const idle = render('idle');
    assert.deepEqual(pixel(idle, 0, 0), BG);
    assert.deepEqual(pixel(idle, 112, 44), CREAM);
    assert.deepEqual(pixel(idle, 112 + 7, 44), CREAM);
    assert.deepEqual(pixel(idle, 111, 44), BG);
    assert.deepEqual(pixel(idle, 4, 220), BAR);
    assert.deepEqual(pixel(idle, 0, 220), MUTED);
    assert.deepEqual(pixel(idle, 3, 239), MUTED);
    assert.deepEqual(pixel(idle, 4, 196), BAR);

    assert.deepEqual(pixel(render('thinking'), 0, 200), TEAL);
    assert.deepEqual(pixel(render('working'), 0, 200), TEAL);
    assert.deepEqual(pixel(render('permission'), 0, 200), AMBER);
    assert.deepEqual(pixel(render('done'), 0, 200), CREAM);
    assert.deepEqual(pixel(render('error'), 0, 200), CORAL);
    assert.deepEqual(pixel(render('sleep'), 0, 200), MUTED);

    const error = render('error');
    assert.deepEqual(pixel(error, 112 + 4 * 7, 44 + 3 * 7), CORAL);
  });

  it('matches assets/mascot/draw.py cell pixels for all 7 states', () => {
    const probe = spawnSync('python3', ['-c', 'import PIL'], { encoding: 'utf8' });
    if (probe.status !== 0) {
      return;
    }
    for (const state of STATES) {
      const oracle = spawnSync('python3', [path.join(HERE, 'mascot_oracle.py'), state], {
        maxBuffer: 1024 * 1024,
      });
      assert.equal(oracle.status, 0, oracle.stderr.toString());
      const expected = oracle.stdout;
      const actual = render(state);
      assert.equal(expected.length, 320 * 240 * 3);
      for (let index = 0; index < actual.length; index += 3) {
        if (
          actual[index] !== expected[index] ||
          actual[index + 1] !== expected[index + 1] ||
          actual[index + 2] !== expected[index + 2]
        ) {
          const pixelIndex = index / 3;
          const x = pixelIndex % 320;
          const y = Math.floor(pixelIndex / 320);
          assert.fail(
            `${state} @ ${x},${y} js=${actual[index]},${actual[index + 1]},${actual[index + 2]} py=${expected[index]},${expected[index + 1]},${expected[index + 2]}`,
          );
        }
      }
    }
  });
});
