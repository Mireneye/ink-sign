import * as pdfjsLib from "pdfjs-dist";
import { buildSignature, INKS } from "../core/ink.js";
import { stampPdf, hasExistingSignatures, drawSignatureOnCanvas } from "../core/stamp.js";
import { createIdentity, fingerprint } from "../core/identity.js";
import { signPdf } from "../core/pdfsign.js";
import { appendSigned } from "../core/incremental.js";
import { exportP12, importP12, lockKey, P12Error } from "../core/p12.js";
import { PDFDocument } from "pdf-lib";
import { SignaturePad } from "./pad.js";
import * as store from "./storage.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.mjs";

const $ = (id) => document.getElementById(id);
const state = {
  file: null,        // { name, type: "pdf" | "image", bytes, mime }
  pages: [],         // { el, w, h, render? } with w/h in points (pdf) or pixels (image)
  placements: [],    // { id, page, fx, fy, fw }
  selected: null,
  placing: false,
  zoom: 1,
  baseScale: 1,
  pdf: null,
  sigData: null,     // saved pad output
  sig: null,         // built artwork { path, width, height, ink }
  identity: null,
};

/* ---------- small UI helpers ---------- */
let toastTimer;
function toast(msg, error = false) {
  const t = $("toast");
  t.textContent = msg; t.classList.toggle("error", error); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), error ? 6000 : 2600);
}
function confirmBanner(text) {
  $("bannerText").textContent = text; $("banner").hidden = false;
  return new Promise((resolve) => {
    const done = (v) => { $("banner").hidden = true; $("bannerYes").onclick = $("bannerNo").onclick = null; resolve(v); };
    $("bannerYes").onclick = () => done(true);
    $("bannerNo").onclick = () => done(false);
  });
}
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
function signedName(name) {
  const i = name.lastIndexOf(".");
  return i > 0 ? `${name.slice(0, i)}-signed${name.slice(i)}` : `${name}-signed`;
}
function sigSvg(sig, extra = 'preserveAspectRatio="none"') {
  return `<svg ${extra} viewBox="0 0 ${sig.width.toFixed(2)} ${sig.height.toFixed(2)}" xmlns="http://www.w3.org/2000/svg"><path d="${sig.path}" fill="${INKS[sig.ink].css}"/></svg>`;
}

/* ---------- signature ---------- */
const pad = new SignaturePad({ onBrushChange: (b) => store.setBrush(b) });

function setSignature(data) {
  state.sigData = data;
  state.sig = data ? buildSignature(data.strokes, data.settings, data.ink) : null;
  const svg = $("sigSvg");
  if (state.sig) svg.outerHTML = sigSvg(state.sig, 'id="sigSvg"');
  else svg.setAttribute("hidden", "");
  $("sigEmpty").hidden = !!state.sig;
  $("drawBtn").textContent = state.sig ? "Redraw" : "Draw signature";
  updatePlacedArt();
  syncUi();
}

$("drawBtn").addEventListener("click", async () => {
  const result = await pad.open(state.sigData);
  if (!result) return;
  await store.setSignature(result);
  setSignature(result);
  toast("Signature saved");
});

/* ---------- opening files ---------- */
$("openBtn").addEventListener("click", () => $("fileInput").click());
$("openBtn2").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) openFile(f); e.target.value = ""; });

const viewer = $("viewer");
viewer.addEventListener("dragover", (e) => { e.preventDefault(); $("dropzone").classList.add("over"); });
viewer.addEventListener("dragleave", (e) => { if (!viewer.contains(e.relatedTarget)) $("dropzone").classList.remove("over"); });
viewer.addEventListener("drop", (e) => {
  e.preventDefault(); $("dropzone").classList.remove("over");
  const f = e.dataTransfer.files[0]; if (f) openFile(f);
});

async function openFile(file) {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  const isImg = /^image\/(png|jpeg|webp)$/.test(file.type);
  if (!isPdf && !isImg) { toast("That file type isn't supported yet. Open a PDF, PNG, JPEG or WebP.", true); return; }
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    resetDoc();
    state.file = { name: file.name, type: isPdf ? "pdf" : "image", bytes, mime: isPdf ? "application/pdf" : file.type };
    if (isPdf) {
      await openPdf(bytes);
      try {
        const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
        state.file.signed = hasExistingSignatures(doc);
      } catch { state.file.signed = false; }
      if (state.file.signed) toast("This PDF is already signed. Your signature will be added as a new revision, leaving earlier signatures valid.");
    } else await openImage(file);
    $("fileName").textContent = file.name;
    $("dropzone").hidden = true; $("pages").hidden = false;
    fitWidth();
  } catch (err) {
    console.error(err);
    resetDoc();
    toast(err?.name === "PasswordException" ? "This PDF is password-protected, so it can't be signed here." : `Couldn't open ${file.name}.`, true);
  }
  syncUi();
}

function resetDoc() {
  state.pdf?.destroy(); state.pdf = null;
  state.pages.forEach((p) => p.url && URL.revokeObjectURL(p.url));
  state.pages = []; state.placements = []; state.selected = null; state.file = null;
  $("pages").innerHTML = ""; $("pages").hidden = true; $("dropzone").hidden = false;
  $("fileName").textContent = "No file open";
  setPlacing(false);
}

async function openPdf(bytes) {
  const pdf = await pdfjsLib.getDocument({
    data: bytes.slice(), cMapUrl: "vendor/cmaps/", cMapPacked: true, standardFontDataUrl: "vendor/standard_fonts/",
    isEvalSupported: false,
  }).promise;
  state.pdf = pdf;
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    addPageEl({ w: vp.width, h: vp.height, pdfPage: page });
  }
}

async function openImage(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  await img.decode();
  const p = addPageEl({ w: img.naturalWidth, h: img.naturalHeight, url });
  img.alt = file.name;
  p.el.prepend(img);
}

function addPageEl(p) {
  const el = document.createElement("div");
  el.className = "page";
  el.dataset.index = state.pages.length;
  if (state.file.type === "pdf") {
    const n = document.createElement("span");
    n.className = "page-num"; n.textContent = state.pages.length + 1;
    el.appendChild(n);
  }
  p.el = el;
  $("pages").appendChild(el);
  state.pages.push(p);
  el.addEventListener("pointerdown", (e) => onPagePointer(e, p));
  return p;
}

/* ---------- zoom + lazy rendering ---------- */
function fitWidth() {
  const avail = viewer.clientWidth - 72;
  const maxW = Math.max(...state.pages.map((p) => p.w));
  state.baseScale = Math.min(avail / maxW, state.file.type === "pdf" ? 1.6 : 1);
  state.zoom = 1;
  layoutPages();
}
const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3];
$("zoomIn").addEventListener("click", () => stepZoom(1));
$("zoomOut").addEventListener("click", () => stepZoom(-1));
function stepZoom(d) {
  const i = ZOOMS.findIndex((z) => z >= state.zoom - 1e-6);
  state.zoom = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? 3 : i) + d))];
  layoutPages();
}

const observer = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) renderPage(state.pages[+e.target.dataset.index]);
}, { root: viewer, rootMargin: "600px 0px" });

function layoutPages() {
  const s = state.baseScale * state.zoom;
  for (const p of state.pages) {
    p.el.style.width = `${p.w * s}px`;
    p.el.style.height = `${p.h * s}px`;
    p.renderedScale = 0;
    observer.unobserve(p.el); observer.observe(p.el);
  }
  $("zoomLabel").textContent = `${Math.round(state.zoom * 100)}%`;
  syncUi();
}

async function renderPage(p) {
  if (!p?.pdfPage) return;
  const s = state.baseScale * state.zoom * (devicePixelRatio || 1);
  if (p.renderedScale === s || p.rendering) return;
  p.rendering = true;
  try {
    const vp = p.pdfPage.getViewport({ scale: s });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
    await p.pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    p.el.querySelector("canvas")?.remove();
    p.el.prepend(canvas);
    p.renderedScale = s;
  } catch (err) {
    if (err?.name !== "RenderingCancelledException") console.error(err);
  } finally {
    p.rendering = false;
    if (p.renderedScale !== state.baseScale * state.zoom * (devicePixelRatio || 1)) {
      const r = p.el.getBoundingClientRect(), v = viewer.getBoundingClientRect();
      if (r.bottom > v.top - 600 && r.top < v.bottom + 600) renderPage(p);
    }
  }
}
window.addEventListener("resize", () => { if (state.file) { const z = state.zoom; fitWidth(); state.zoom = z; layoutPages(); } });

/* ---------- placing and editing signatures ---------- */
function setPlacing(on) {
  state.placing = on && !!state.sig && !!state.file;
  viewer.classList.toggle("placing", state.placing);
  $("placeBtn").classList.toggle("active", state.placing);
  $("placeBtn").textContent = state.placing ? "Click on a page…" : "Place on page";
}
$("placeBtn").addEventListener("click", () => setPlacing(!state.placing));

function aspectOn(p) { return (state.sig.height / state.sig.width) * (p.w / p.h); } // fh = fw * this

function onPagePointer(e, p) {
  if (!state.placing || e.target.closest(".placed")) return;
  const r = p.el.getBoundingClientRect();
  const defaultW = state.file.type === "pdf" ? 150 : p.w * 0.25; // ~5.3 cm on a PDF page
  const fw = Math.min(0.9, defaultW / p.w);
  const fh = fw * aspectOn(p);
  const fx = clamp((e.clientX - r.left) / r.width - fw / 2, 0, 1 - fw);
  const fy = clamp((e.clientY - r.top) / r.height - fh / 2, 0, 1 - fh);
  const pl = { id: crypto.randomUUID(), page: +p.el.dataset.index, fx, fy, fw };
  state.placements.push(pl);
  addPlacedEl(pl);
  select(pl.id);
  setPlacing(false);
  syncUi();
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function addPlacedEl(pl) {
  const p = state.pages[pl.page];
  const el = document.createElement("div");
  el.className = "placed"; el.dataset.id = pl.id; el.tabIndex = 0;
  el.innerHTML = `${sigSvg(state.sig)}<span class="grip" title="Resize"></span><button type="button" class="del" title="Remove" aria-label="Remove signature">×</button>`;
  p.el.appendChild(el);
  positionPlaced(pl);

  el.querySelector(".del").addEventListener("click", (e) => { e.stopPropagation(); removePlacement(pl.id); });
  el.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".del")) return;
    e.preventDefault(); e.stopPropagation();
    select(pl.id);
    const resizing = !!e.target.closest(".grip");
    const pr = p.el.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, fx: pl.fx, fy: pl.fy, fw: pl.fw };
    el.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const dx = (ev.clientX - start.x) / pr.width, dy = (ev.clientY - start.y) / pr.height;
      if (resizing) {
        const a = aspectOn(p);
        const maxW = Math.min(1 - pl.fx, (1 - pl.fy) / a);
        pl.fw = clamp(start.fw + Math.max(dx, dy / a), 0.03, maxW);
      } else {
        const fh = pl.fw * aspectOn(p);
        pl.fx = clamp(start.fx + dx, 0, 1 - pl.fw);
        pl.fy = clamp(start.fy + dy, 0, 1 - fh);
      }
      positionPlaced(pl);
    };
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  });
}

function positionPlaced(pl) {
  const p = state.pages[pl.page];
  const el = p.el.querySelector(`.placed[data-id="${pl.id}"]`);
  if (!el) return;
  const fh = pl.fw * aspectOn(p);
  Object.assign(el.style, { left: `${pl.fx * 100}%`, top: `${pl.fy * 100}%`, width: `${pl.fw * 100}%`, height: `${fh * 100}%` });
}

function updatePlacedArt() {
  for (const pl of state.placements) {
    const el = document.querySelector(`.placed[data-id="${pl.id}"]`);
    if (!el || !state.sig) continue;
    el.querySelector("svg").outerHTML = sigSvg(state.sig);
    const p = state.pages[pl.page];
    pl.fw = Math.min(pl.fw, 1 - pl.fx, (1 - pl.fy) / aspectOn(p));
    positionPlaced(pl);
  }
}

function select(id) {
  state.selected = id;
  document.querySelectorAll(".placed").forEach((el) => el.classList.toggle("sel", el.dataset.id === id));
}
function removePlacement(id) {
  state.placements = state.placements.filter((p) => p.id !== id);
  document.querySelector(`.placed[data-id="${id}"]`)?.remove();
  if (state.selected === id) state.selected = null;
  syncUi();
}
$("clearPlaced").addEventListener("click", () => [...state.placements].forEach((p) => removePlacement(p.id)));
document.addEventListener("pointerdown", (e) => { if (!e.target.closest(".placed")) select(null); });
document.addEventListener("keydown", (e) => {
  if (document.querySelector("dialog[open]") || /INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return;
  if ((e.key === "Delete" || e.key === "Backspace") && state.selected) { e.preventDefault(); removePlacement(state.selected); }
  if (e.key === "Escape" && state.placing) setPlacing(false);
});

/* ---------- digital ID ---------- */
async function showIdentity() {
  const id = state.identity;
  $("idNone").hidden = !!id; $("idSome").hidden = !id;
  $("idDeleteConfirm").hidden = true;
  if (!id) return;
  $("idShowName").textContent = id.name;
  $("idShowEmail").textContent = id.email || "—";
  $("idShowExpires").textContent = new Date(id.expires).toLocaleDateString();
  $("idShowFp").textContent = await fingerprint(id.certDer);
  $("idShowSource").textContent = id.source === "imported"
    ? "Imported from a file"
    : id.backedUp ? `Created here, backup saved ${new Date(id.backedUp).toLocaleDateString()}` : "Created here";
}
$("idCreate").addEventListener("click", async () => {
  const name = $("idName").value.trim();
  if (!name) { toast("Enter the name that should appear on your signatures.", true); $("idName").focus(); return; }
  const btn = $("idCreate"); btn.disabled = true; btn.textContent = "Creating…";
  try {
    const fresh = await createIdentity({ name, email: $("idEmail").value.trim() });
    btn.textContent = "Create digital ID";
    const saved = await runBackup(fresh);
    if (!saved) { toast("No digital ID was created."); return; }
    fresh.privateKey = await lockKey(fresh.privateKey); // from here on the key can't leave the browser
    fresh.backedUp = new Date().toISOString();
    state.identity = fresh;
    await store.setIdentity(fresh);
    await showIdentity();
    toast("Digital ID ready. Keep the backup file somewhere safe.");
  } catch (err) {
    console.error(err); toast("Couldn't create the digital ID.", true);
  } finally { btn.disabled = false; btn.textContent = "Create digital ID"; syncUi(); }
});

// Walks the user through saving the .p12 backup. Resolves true once they confirm it's saved.
function runBackup(identity) {
  const dlg = $("backupDialog");
  const fileName = `${identity.name.replace(/[\\/:*?"<>|]+/g, "_")} digital ID.p12`;
  let p12 = null;
  $("bkStep1").hidden = false; $("bkStep2").hidden = true;
  $("bkPw").value = $("bkPw2").value = ""; $("bkShow").checked = false;
  $("bkPw").type = $("bkPw2").type = "password";
  $("bkError").hidden = true;
  dlg.showModal(); $("bkPw").focus();
  const err = (m) => { $("bkError").textContent = m; $("bkError").hidden = false; };

  return new Promise((resolve) => {
    const finish = (v) => { dlg.close(); cleanup(); resolve(v); };
    const onShow = () => { $("bkPw").type = $("bkPw2").type = $("bkShow").checked ? "text" : "password"; };
    const onSave = async (e) => {
      e.preventDefault();
      const pw = $("bkPw").value;
      if (pw.length < 8) return err("Use at least 8 characters.");
      if (pw !== $("bkPw2").value) return err("The two passwords don't match.");
      $("bkError").hidden = true;
      $("bkSave").disabled = true; $("bkSave").textContent = "Saving…";
      try {
        p12 = await exportP12({ ...identity, password: pw, friendlyName: identity.name });
        download(new Blob([p12], { type: "application/x-pkcs12" }), fileName);
        $("bkFileName").textContent = fileName;
        $("bkStep1").hidden = true; $("bkStep2").hidden = false; $("bkDone").focus();
      } catch (e2) { console.error(e2); err("The backup couldn't be created. Try again."); }
      finally { $("bkSave").disabled = false; $("bkSave").textContent = "Save backup file"; }
    };
    const onAgain = () => download(new Blob([p12], { type: "application/x-pkcs12" }), fileName);
    const onDone = () => finish(true);
    const onCancel = () => finish(false);
    const onEsc = (e) => { e.preventDefault(); if ($("bkStep2").hidden) finish(false); };
    $("bkShow").addEventListener("change", onShow);
    $("bkStep1").addEventListener("submit", onSave);
    $("bkAgain").addEventListener("click", onAgain);
    $("bkDone").addEventListener("click", onDone);
    $("bkCancel").addEventListener("click", onCancel);
    dlg.addEventListener("cancel", onEsc);
    function cleanup() {
      $("bkShow").removeEventListener("change", onShow);
      $("bkStep1").removeEventListener("submit", onSave);
      $("bkAgain").removeEventListener("click", onAgain);
      $("bkDone").removeEventListener("click", onDone);
      $("bkCancel").removeEventListener("click", onCancel);
      dlg.removeEventListener("cancel", onEsc);
      $("bkPw").value = $("bkPw2").value = "";
      p12 = null;
    }
  });
}

/* import */
function openImport() {
  $("imFile").value = ""; $("imPw").value = ""; $("imError").hidden = true;
  $("imReplace").hidden = !state.identity;
  $("importDialog").showModal();
}
$("idImportOpen").addEventListener("click", openImport);
$("idReplace").addEventListener("click", openImport);
$("imCancel").addEventListener("click", () => $("importDialog").close());
$("imForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = (m) => { $("imError").textContent = m; $("imError").hidden = false; };
  const file = $("imFile").files[0];
  if (!file) return err("Choose a .p12 or .pfx file.");
  const go = $("imGo"); go.disabled = true; go.textContent = "Importing…";
  try {
    const id = await importP12(new Uint8Array(await file.arrayBuffer()), $("imPw").value);
    state.identity = id;
    await store.setIdentity(id);
    await showIdentity();
    $("importDialog").close();
    toast(`Digital ID for ${id.name} imported`);
  } catch (e2) {
    if (!(e2 instanceof P12Error)) console.error(e2);
    err(e2 instanceof P12Error ? e2.message : "This file couldn't be imported.");
  } finally { go.disabled = false; go.textContent = "Import"; syncUi(); }
});
$("idExport").addEventListener("click", () => {
  const safe = state.identity.name.replace(/[^\w.-]+/g, "_");
  download(new Blob([state.identity.certDer], { type: "application/pkix-cert" }), `${safe}.cer`);
});
$("idDelete").addEventListener("click", () => ($("idDeleteConfirm").hidden = false));
$("idDeleteNo").addEventListener("click", () => ($("idDeleteConfirm").hidden = true));
$("idDeleteYes").addEventListener("click", async () => {
  await store.deleteIdentity(); state.identity = null; await showIdentity(); syncUi(); toast("Digital ID deleted");
});
$("cryptoOn").addEventListener("change", syncUi);

/* ---------- export ---------- */
function wantsCrypto() { return state.file?.type === "pdf" && !!state.identity && $("cryptoOn").checked; }

$("downloadBtn").addEventListener("click", async () => {
  const btn = $("downloadBtn"); btn.disabled = true; const label = btn.textContent; btn.textContent = "Saving…";
  try {
    if (state.file.type === "pdf") await exportPdf(); else await exportImage();
  } catch (err) {
    console.error(err);
    toast(err?.userMessage ?? (/encrypt/i.test(String(err)) ? "This PDF is encrypted, so it can't be modified." : "Saving failed. The file may be damaged or use an unsupported feature."), true);
  } finally { btn.textContent = label; syncUi(); }
});

async function exportPdf() {
  const placements = state.sig ? state.placements : [];
  if (state.file.signed) {
    // Already signed: append as a revision so earlier signatures stay valid.
    const out = await appendSigned(state.file.bytes, placements, state.sig, wantsCrypto() ? state.identity : null, { reason: $("reason").value.trim() });
    download(new Blob([out], { type: "application/pdf" }), signedName(state.file.name));
    toast("Saved as a new revision; earlier signatures are untouched");
    return;
  }
  const doc = await stampPdf(state.file.bytes, placements, state.sig ?? { path: "", width: 1, height: 1, ink: "black" });
  const bytes = wantsCrypto()
    ? await signPdf(doc, state.identity, { reason: $("reason").value.trim() })
    : await doc.save();
  download(new Blob([bytes], { type: "application/pdf" }), signedName(state.file.name));
  toast(wantsCrypto() ? "Saved with digital signature" : "Saved");
}

async function exportImage() {
  const p = state.pages[0];
  const bmp = await createImageBitmap(new Blob([state.file.bytes], { type: state.file.mime }));
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(bmp, 0, 0);
  for (const pl of state.placements) drawSignatureOnCanvas(ctx, state.sig, pl.fx * c.width, pl.fy * c.height, pl.fw * c.width);
  const mime = state.file.mime;
  const blob = await new Promise((r) => c.toBlob(r, mime, mime === "image/png" ? undefined : 0.95));
  download(blob, signedName(state.file.name));
  toast("Saved");
  void p;
}

/* ---------- state → controls ---------- */
function syncUi() {
  const has = !!state.file;
  $("zoomIn").disabled = !has || state.zoom >= ZOOMS.at(-1);
  $("zoomOut").disabled = !has || state.zoom <= ZOOMS[0];
  $("placeBtn").disabled = !has || !state.sig;
  const n = state.placements.length;
  $("placedRow").hidden = !n;
  $("placedCount").textContent = `${n} signature${n === 1 ? "" : "s"} placed`;
  $("downloadBtn").disabled = !has || !(n > 0 || wantsCrypto());
  $("placeHint").hidden = n > 0;
}

/* ---------- boot ---------- */
(async () => {
  pad.setBrush(await store.getBrush());
  const sig = await store.getSignature();
  if (sig) setSignature(sig);
  try { state.identity = (await store.getIdentity()) ?? null; } catch (err) { console.error(err); }
  await showIdentity();
  syncUi();
})();
