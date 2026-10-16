// A made-up webcam picture of the bed for the browser test: a ply bed seen at an angle,
// a dark board on it and four calibration crosses, written as a one-frame Y4M file that
// Chromium plays as its fake camera (--use-file-for-fake-video-capture).

import { writeFileSync } from "node:fs";

export const WIDTH = 1280;
export const HEIGHT = 720;
export const BED = { w: 410, h: 400 };
// Machine coordinates (mm from front-left, y away) of what's in the picture.
export const BOARD = { x0: 100, y0: 120, x1: 260, y1: 220 };
export const MARKS = [[40, 360], [370, 360], [370, 40], [40, 40]];
// Where the bed's corners land in the picture: the camera looks down at a slight angle.
const CORNERS = [[[0, 0], [200, 660]], [[410, 0], [1090, 640]], [[410, 400], [1010, 60]], [[0, 400], [250, 80]]];

function solve(from, to) {
  const a = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i], [u, v] = to[i];
    a.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u], [0, 0, 0, x, y, 1, -x * v, -y * v, v]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const k = a[r][c] / a[c][c];
      for (let j = c; j < 9; j++) a[r][j] -= k * a[c][j];
    }
  }
  return [...a.map((row, i) => row[8] / row[i]), 1];
}
const apply = (h, x, y) => {
  const w = h[6] * x + h[7] * y + 1;
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
};

const toPicture = solve(CORNERS.map((c) => c[0]), CORNERS.map((c) => c[1]));
const toBed = solve(CORNERS.map((c) => c[1]), CORNERS.map((c) => c[0]));

/** Where a bed point (machine mm) appears in the picture, in pixels. */
export const pictureOf = (x, y) => apply(toPicture, x, y);

function colourAt(px, py) {
  const [x, y] = apply(toBed, px + 0.5, py + 0.5);
  if (x < 0 || y < 0 || x > BED.w || y > BED.h) return [28, 30, 34];
  for (const [mx, my] of MARKS) {
    const dx = Math.abs(x - mx), dy = Math.abs(y - my);
    if ((dx < 0.8 && dy < 7) || (dy < 0.8 && dx < 7)) return [15, 15, 15];
  }
  if (x > BOARD.x0 && x < BOARD.x1 && y > BOARD.y0 && y < BOARD.y1) return [140, 85, 40];
  return [228, 218, 192];
}

export function writeFakeCamera(path) {
  const y = Buffer.alloc(WIDTH * HEIGHT);
  const u = Buffer.alloc((WIDTH / 2) * (HEIGHT / 2));
  const v = Buffer.alloc((WIDTH / 2) * (HEIGHT / 2));
  const rgb = new Array(WIDTH * HEIGHT);
  for (let j = 0; j < HEIGHT; j++) {
    for (let i = 0; i < WIDTH; i++) {
      const [r, g, b] = (rgb[j * WIDTH + i] = colourAt(i, j));
      y[j * WIDTH + i] = Math.round(0.257 * r + 0.504 * g + 0.098 * b + 16);
    }
  }
  for (let j = 0; j < HEIGHT / 2; j++) {
    for (let i = 0; i < WIDTH / 2; i++) {
      const [r, g, b] = rgb[j * 2 * WIDTH + i * 2];
      u[j * (WIDTH / 2) + i] = Math.round(-0.148 * r - 0.291 * g + 0.439 * b + 128);
      v[j * (WIDTH / 2) + i] = Math.round(0.439 * r - 0.368 * g - 0.071 * b + 128);
    }
  }
  const header = Buffer.from(`YUV4MPEG2 W${WIDTH} H${HEIGHT} F10:1 Ip A1:1 C420jpeg\n`);
  const frame = Buffer.from("FRAME\n");
  writeFileSync(path, Buffer.concat([header, frame, y, u, v]));
}
