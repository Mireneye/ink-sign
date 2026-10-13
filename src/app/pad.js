// Signature pad dialog: drawing, brush presets, undo/redo.
import { PRESETS, INKS, outlineOf, pathData } from "../core/ink.js";

const SLIDERS = [
  { key: "size", label: "Size", min: 1, max: 20, step: 0.1, fmt: (v) => v.toFixed(1) + " px" },
  { key: "thinning", label: "Thinning", min: -1, max: 1, step: 0.01, fmt: (v) => v.toFixed(2) },
  { key: "smoothing", label: "Smoothing", min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2) },
  { key: "streamline", label: "Streamline", min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2) },
  { key: "taperStart", label: "Taper start", min: 0, max: 120, step: 1, fmt: (v) => v + " px" },
  { key: "taperEnd", label: "Taper end", min: 0, max: 200, step: 1, fmt: (v) => v + " px" },
];

export class SignaturePad {
  constructor({ onBrushChange }) {
    this.dialog = document.getElementById("padDialog");
    this.canvas = document.getElementById("pad");
    this.ctx = this.canvas.getContext("2d");
    this.onBrushChange = onBrushChange;
    this.brush = { preset: "pen", custom: null, ink: "black" };
    this.settings = { ...PRESETS.pen };
    this.strokes = []; this.history = []; this.future = []; this.current = null;
    this.inputs = {}; this.outputs = {};
    this.buildSliders();
    this.wire();
  }

  setBrush(b) {
    if (!b) return;
    this.brush = { preset: "pen", custom: null, ink: "black", ...b };
    if (this.brush.preset === "custom" && !this.brush.custom) this.brush.preset = "pen";
    this.settings = { ...(this.brush.preset === "custom" ? this.brush.custom : PRESETS[this.brush.preset]) };
  }

  buildSliders() {
    const box = document.getElementById("sliders");
    for (const s of SLIDERS) {
      const d = document.createElement("div");
      d.className = "ctl";
      d.innerHTML = `<label for="s-${s.key}">${s.label}</label><output id="o-${s.key}"></output>
        <input type="range" id="s-${s.key}" min="${s.min}" max="${s.max}" step="${s.step}">`;
      box.appendChild(d);
      this.inputs[s.key] = d.querySelector("input");
      this.outputs[s.key] = d.querySelector("output");
      this.inputs[s.key].addEventListener("input", (e) => {
        this.settings[s.key] = parseFloat(e.target.value);
        this.brush.custom = { ...this.settings };
        this.brush.preset = "custom";
        this.syncControls(); this.render(); this.onBrushChange(this.brush);
      });
    }
  }

  syncControls() {
    for (const s of SLIDERS) {
      this.inputs[s.key].value = this.settings[s.key];
      this.outputs[s.key].textContent = s.fmt(this.settings[s.key]);
    }
    document.querySelector(`input[name="preset"][value="${this.brush.preset}"]`).checked = true;
    document.querySelector(`input[name="ink"][value="${this.brush.ink}"]`).checked = true;
    document.getElementById("padUndo").disabled = !this.history.length;
    document.getElementById("padRedo").disabled = !this.future.length;
    document.getElementById("padClear").disabled = !this.strokes.length;
    document.getElementById("padSave").disabled = !this.strokes.length;
  }

  wire() {
    document.querySelectorAll('input[name="preset"]').forEach((r) => r.addEventListener("change", (e) => {
      this.brush.preset = e.target.value;
      if (this.brush.preset === "custom") { this.brush.custom ??= { ...this.settings }; this.settings = { ...this.brush.custom }; }
      else this.settings = { ...PRESETS[this.brush.preset] };
      this.syncControls(); this.render(); this.onBrushChange(this.brush);
    }));
    document.querySelectorAll('input[name="ink"]').forEach((r) => r.addEventListener("change", (e) => {
      this.brush.ink = e.target.value; this.render(); this.onBrushChange(this.brush);
    }));

    const c = this.canvas;
    const pt = (e) => {
      const r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top, e.pointerType === "pen" ? (e.pressure || 0.5) : 0.5];
    };
    c.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      c.setPointerCapture(e.pointerId);
      this.current = { points: [pt(e)], pen: e.pointerType === "pen" };
      this.render();
    });
    c.addEventListener("pointermove", (e) => {
      if (!this.current) return;
      for (const ev of e.getCoalescedEvents?.() ?? [e]) this.current.points.push(pt(ev));
      this.render();
    });
    const end = () => {
      if (!this.current) return;
      this.strokes.push(this.current);
      this.history.push({ add: this.current }); this.future = [];
      this.current = null; this.render(); this.syncControls();
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);

    document.getElementById("padUndo").addEventListener("click", () => this.undo());
    document.getElementById("padRedo").addEventListener("click", () => this.redo());
    document.getElementById("padClear").addEventListener("click", () => {
      if (!this.strokes.length) return;
      this.history.push({ cleared: this.strokes }); this.future = []; this.strokes = [];
      this.render(); this.syncControls();
    });
    this.dialog.addEventListener("keydown", (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || this.current) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); this.undo(); }
      else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); this.redo(); }
    });
    document.getElementById("padCancel").addEventListener("click", () => this.finish(null));
    document.getElementById("padSave").addEventListener("click", () => {
      const w = this.canvas.getBoundingClientRect().width;
      this.finish({ strokes: this.strokes, padWidth: w, settings: { ...this.settings }, ink: this.brush.ink });
    });
    this.dialog.addEventListener("cancel", (e) => { e.preventDefault(); this.finish(null); });
    new ResizeObserver(() => this.dialog.open && this.resize()).observe(this.canvas);
  }

  undo() {
    const a = this.history.pop(); if (!a) return;
    if (a.add) this.strokes.pop(); else this.strokes = a.cleared;
    this.future.push(a); this.render(); this.syncControls();
  }
  redo() {
    const a = this.future.pop(); if (!a) return;
    if (a.add) this.strokes.push(a.add); else this.strokes = [];
    this.history.push(a); this.render(); this.syncControls();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    if (this.lastWidth && r.width && r.width !== this.lastWidth) {
      const k = r.width / this.lastWidth;
      const all = new Set(this.strokes);
      for (const h of [...this.history, ...this.future]) (h.add ? [h.add] : h.cleared).forEach((s) => all.add(s));
      for (const s of all) s.points = s.points.map(([x, y, p]) => [x * k, y * k, p]);
    }
    this.lastWidth = r.width;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  }

  render() {
    const { ctx } = this;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = INKS[this.brush.ink].css;
    for (const s of this.strokes) ctx.fill(new Path2D(pathData(outlineOf(s, this.settings))));
    if (this.current) ctx.fill(new Path2D(pathData(outlineOf(this.current, this.settings, false))));
  }

  open(existing) {
    this.history = []; this.future = []; this.current = null; this.lastWidth = 0;
    this.strokes = [];
    this.dialog.showModal();
    const w = this.canvas.getBoundingClientRect().width;
    if (existing?.strokes?.length && existing.padWidth) {
      const k = w / existing.padWidth;
      this.strokes = existing.strokes.map((s) => ({ pen: s.pen, points: s.points.map(([x, y, p]) => [x * k, y * k, p]) }));
    }
    this.syncControls();
    this.resize();
    return new Promise((resolve) => { this.resolve = resolve; });
  }

  finish(result) {
    this.dialog.close();
    this.resolve?.(result);
    this.resolve = null;
  }
}
