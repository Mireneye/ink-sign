// Turns raw pointer strokes into the filled outline the user sees as ink.
import { getStroke } from "perfect-freehand";

export const PRESETS = {
  pen:   { size: 3.2, thinning: 0.55, smoothing: 0.5,  streamline: 0.45, taperStart: 0,  taperEnd: 28 },
  felt:  { size: 5.5, thinning: 0.3,  smoothing: 0.55, streamline: 0.5,  taperStart: 0,  taperEnd: 14 },
  brush: { size: 8,   thinning: 0.8,  smoothing: 0.6,  streamline: 0.55, taperStart: 10, taperEnd: 60 },
};

export const INKS = {
  black: { label: "Black", rgb: [0.086, 0.098, 0.114], css: "#16191d" },
  blue:  { label: "Blue",  rgb: [0.114, 0.227, 0.541], css: "#1d3a8a" },
};

export function strokeOptions(settings, pen, last = true) {
  return {
    size: settings.size,
    thinning: settings.thinning,
    smoothing: settings.smoothing,
    streamline: settings.streamline,
    simulatePressure: !pen,
    start: { taper: settings.taperStart, cap: true },
    end: { taper: settings.taperEnd, cap: true },
    last,
  };
}

export function outlineOf(stroke, settings, last = true) {
  return getStroke(stroke.points, strokeOptions(settings, stroke.pen, last));
}

// Closed quadratic path through outline midpoints. Explicit command per segment
// so every SVG parser (including pdf-lib's) reads it the same way.
export function pathData(pts, dx = 0, dy = 0) {
  if (pts.length < 2) return "";
  const f = (n) => (Math.round(n * 100) / 100).toString();
  const n = pts.length;
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const m0 = mid(pts[0], pts[1]);
  let d = `M${f(m0[0] - dx)} ${f(m0[1] - dy)}`;
  for (let i = 1; i <= n; i++) {
    const a = pts[i % n], b = pts[(i + 1) % n];
    const m = mid(a, b);
    d += `Q${f(a[0] - dx)} ${f(a[1] - dy)} ${f(m[0] - dx)} ${f(m[1] - dy)}`;
  }
  return d + "Z";
}

// Final signature artwork: one path string in its own coordinate box (origin top-left).
export function buildSignature(strokes, settings, ink = "black") {
  const outlines = strokes.map((s) => outlineOf(s, settings)).filter((o) => o.length > 1);
  if (!outlines.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const o of outlines) for (const [x, y] of o) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  const path = outlines.map((o) => pathData(o, minX, minY)).join("");
  return { path, width: maxX - minX, height: maxY - minY, ink };
}
