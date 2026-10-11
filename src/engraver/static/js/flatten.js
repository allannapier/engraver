// Turns SVG path data into polylines the laser can follow.
// Pure functions: no DOM, so they can be unit tested.

const ARGS = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

/** Parse path data into absolute commands: ["M",x,y] ["L",x,y] ["C",x1,y1,x2,y2,x,y] ["Z"]. */
export function parsePath(d) {
  const out = [];
  let i = 0;
  const skip = () => {
    while (i < d.length && (d.charCodeAt(i) <= 32 || d[i] === ",")) i += 1;
  };
  const number = () => {
    skip();
    NUMBER.lastIndex = i;
    const match = NUMBER.exec(d);
    if (!match) return null;
    i = NUMBER.lastIndex;
    return parseFloat(match[0]);
  };
  // Arc flags are single digits and may be written with no separator ("a1 1 0 01 5 5").
  const flag = () => {
    skip();
    if (d[i] === "0" || d[i] === "1") return Number(d[i++]);
    return null;
  };

  let cmd = null;
  let x = 0, y = 0, startX = 0, startY = 0;
  let ctrlX = null, ctrlY = null, prev = "";
  for (;;) {
    skip();
    if (i >= d.length) break;
    if (/[a-zA-Z]/.test(d[i])) {
      cmd = d[i++];
      if (!(cmd.toUpperCase() in ARGS)) break;
    } else if (cmd === null || cmd.toUpperCase() === "Z") {
      break; // numbers with no command: malformed, stop like browsers do
    }
    const upper = cmd.toUpperCase();
    const rel = cmd !== upper;
    const args = [];
    let bad = false;
    for (let k = 0; k < ARGS[upper]; k += 1) {
      const value = upper === "A" && (k === 3 || k === 4) ? flag() : number();
      if (value === null) {
        bad = true;
        break;
      }
      args.push(value);
    }
    if (bad) break;
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    switch (upper) {
      case "M":
        x = args[0] + ox; y = args[1] + oy;
        startX = x; startY = y;
        out.push(["M", x, y]);
        cmd = rel ? "l" : "L"; // extra pairs after a moveto are linetos
        break;
      case "L":
        x = args[0] + ox; y = args[1] + oy;
        out.push(["L", x, y]);
        break;
      case "H":
        x = args[0] + ox;
        out.push(["L", x, y]);
        break;
      case "V":
        y = args[0] + oy;
        out.push(["L", x, y]);
        break;
      case "C":
        out.push(["C", args[0] + ox, args[1] + oy, args[2] + ox, args[3] + oy, args[4] + ox, args[5] + oy]);
        ctrlX = args[2] + ox; ctrlY = args[3] + oy;
        x = args[4] + ox; y = args[5] + oy;
        break;
      case "S": {
        const smooth = prev === "C" || prev === "S";
        const x1 = smooth ? 2 * x - ctrlX : x;
        const y1 = smooth ? 2 * y - ctrlY : y;
        out.push(["C", x1, y1, args[0] + ox, args[1] + oy, args[2] + ox, args[3] + oy]);
        ctrlX = args[0] + ox; ctrlY = args[1] + oy;
        x = args[2] + ox; y = args[3] + oy;
        break;
      }
      case "Q":
      case "T": {
        let qx, qy, ex, ey;
        if (upper === "Q") {
          qx = args[0] + ox; qy = args[1] + oy; ex = args[2] + ox; ey = args[3] + oy;
        } else {
          const smooth = prev === "Q" || prev === "T";
          qx = smooth ? 2 * x - ctrlX : x;
          qy = smooth ? 2 * y - ctrlY : y;
          ex = args[0] + ox; ey = args[1] + oy;
        }
        // Quadratic to cubic.
        out.push(["C", x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey]);
        ctrlX = qx; ctrlY = qy;
        x = ex; y = ey;
        break;
      }
      case "A": {
        const ex = args[5] + ox, ey = args[6] + oy;
        for (const c of arcToCubics(x, y, args[0], args[1], args[2], args[3], args[4], ex, ey)) out.push(["C", ...c]);
        x = ex; y = ey;
        break;
      }
      case "Z":
        out.push(["Z"]);
        x = startX; y = startY;
        break;
    }
    prev = upper;
  }
  return out;
}

/** SVG elliptical arc to cubic Béziers (endpoint to centre parameterisation, SVG 1.1 F.6). */
export function arcToCubics(x1, y1, rx, ry, angle, large, sweep, x2, y2) {
  if (x1 === x2 && y1 === y2) return [];
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (rx === 0 || ry === 0) return [[x1, y1, x2, y2, x2, y2]];
  const phi = (angle * Math.PI) / 180;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const xp = cos * dx + sin * dy, yp = -sin * dx + cos * dy;
  const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  const den = rx * rx * yp * yp + ry * ry * xp * xp;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (Boolean(large) === Boolean(sweep)) coef = -coef;
  const cxp = (coef * rx * yp) / ry, cyp = (-coef * ry * xp) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const theta1 = Math.atan2((yp - cyp) / ry, (xp - cxp) / rx);
  let delta = Math.atan2((-yp - cyp) / ry, (-xp - cxp) / rx) - theta1;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  const pieces = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / pieces;
  const t = (4 / 3) * Math.tan(step / 4);
  const point = (theta) => {
    const c = Math.cos(theta), s = Math.sin(theta);
    return [cx + rx * c * cos - ry * s * sin, cy + rx * c * sin + ry * s * cos, -rx * s * cos - ry * c * sin, -rx * s * sin + ry * c * cos];
  };
  const out = [];
  for (let k = 0; k < pieces; k += 1) {
    const [ax, ay, adx, ady] = point(theta1 + k * step);
    const [bx, by, bdx, bdy] = point(theta1 + (k + 1) * step);
    out.push([ax + t * adx, ay + t * ady, bx - t * bdx, by - t * bdy, bx, by]);
  }
  // Land exactly on the endpoint so closed shapes really close.
  out[out.length - 1][4] = x2;
  out[out.length - 1][5] = y2;
  return out;
}

export const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const apply = (m, x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];

function cubic(points, p0, p1, p2, p3, tol, depth) {
  // Flat enough when both control points sit within `tol` of the chord.
  const dx = p3[0] - p0[0], dy = p3[1] - p0[1];
  const len = Math.hypot(dx, dy);
  let d1, d2;
  if (len < 1e-9) {
    d1 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    d2 = Math.hypot(p2[0] - p0[0], p2[1] - p0[1]);
  } else {
    d1 = Math.abs(dy * (p1[0] - p0[0]) - dx * (p1[1] - p0[1])) / len;
    d2 = Math.abs(dy * (p2[0] - p0[0]) - dx * (p2[1] - p0[1])) / len;
  }
  if (depth >= 14 || Math.max(d1, d2) <= tol) {
    points.push(p3);
    return;
  }
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const p01 = mid(p0, p1), p12 = mid(p1, p2), p23 = mid(p2, p3);
  const p012 = mid(p01, p12), p123 = mid(p12, p23);
  const m = mid(p012, p123);
  cubic(points, p0, p01, p012, m, tol, depth + 1);
  cubic(points, m, p123, p23, p3, tol, depth + 1);
}

/**
 * Flatten absolute path commands into polylines. Points are transformed by
 * `matrix` first, so `tolerance` is in output units (mm on the bed).
 */
export function flattenCommands(commands, matrix = IDENTITY, tolerance = 0.03) {
  const paths = [];
  let current = null;
  let last = null;
  let start = null;
  const begin = (pt) => {
    current = [pt];
    paths.push(current);
  };
  for (const cmd of commands) {
    if (cmd[0] === "M") {
      last = start = apply(matrix, cmd[1], cmd[2]);
      current = null; // a subpath only exists once something is drawn from it
    } else if (cmd[0] === "L") {
      if (!last) continue;
      if (!current) begin(last);
      last = apply(matrix, cmd[1], cmd[2]);
      current.push(last);
    } else if (cmd[0] === "C") {
      if (!last) continue;
      if (!current) begin(last);
      const end = apply(matrix, cmd[5], cmd[6]);
      cubic(current, last, apply(matrix, cmd[1], cmd[2]), apply(matrix, cmd[3], cmd[4]), end, tolerance, 0);
      last = end;
    } else if (cmd[0] === "Z") {
      if (current && start) {
        const tail = current[current.length - 1];
        if (Math.hypot(tail[0] - start[0], tail[1] - start[1]) > 1e-6) current.push(start);
        else current[current.length - 1] = start;
      }
      last = start;
      current = null;
    }
  }
  return paths.filter((path) => path.length >= 2);
}

// --- basic shapes as path commands ---------------------------------------------

export function rectCommands(x, y, w, h, rx = 0, ry = 0) {
  if (w <= 0 || h <= 0) return [];
  rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
  if (rx <= 0 || ry <= 0) return [["M", x, y], ["L", x + w, y], ["L", x + w, y + h], ["L", x, y + h], ["Z"]];
  const arc = (x1, y1, x2, y2) => arcToCubics(x1, y1, rx, ry, 0, 0, 1, x2, y2).map((c) => ["C", ...c]);
  return [
    ["M", x + rx, y], ["L", x + w - rx, y], ...arc(x + w - rx, y, x + w, y + ry),
    ["L", x + w, y + h - ry], ...arc(x + w, y + h - ry, x + w - rx, y + h),
    ["L", x + rx, y + h], ...arc(x + rx, y + h, x, y + h - ry),
    ["L", x, y + ry], ...arc(x, y + ry, x + rx, y), ["Z"],
  ];
}

export function ellipseCommands(cx, cy, rx, ry) {
  if (rx <= 0 || ry <= 0) return [];
  return [
    ["M", cx + rx, cy],
    ...arcToCubics(cx + rx, cy, rx, ry, 0, 0, 1, cx - rx, cy).map((c) => ["C", ...c]),
    ...arcToCubics(cx - rx, cy, rx, ry, 0, 0, 1, cx + rx, cy).map((c) => ["C", ...c]),
    ["Z"],
  ];
}

export function polyCommands(points, close) {
  if (points.length < 2) return [];
  const out = points.map(([x, y], i) => [i ? "L" : "M", x, y]);
  if (close) out.push(["Z"]);
  return out;
}
