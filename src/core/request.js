// Signature requests: empty, labelled signature fields that tell a recipient where to sign,
// and the shared appearance-stream helper used for anything drawn as an annotation.
import {
  PDFName, PDFString, PDFSignature, StandardFonts,
  pushGraphicsState, popGraphicsState, drawRectangle, drawText, drawSvgPath, rgb, degrees,
} from "pdf-lib";
import { INKS } from "./ink.js";
import { displaySize, displayToPdf } from "./stamp.js";

// Inverse of displayToPdf: PDF user-space point → displayed-page points (origin top-left).
export function pdfToDisplay(box, rotation, x, y) {
  const r = ((rotation % 360) + 360) % 360;
  const x0 = box.x, y0 = box.y, x1 = box.x + box.width, y1 = box.y + box.height;
  switch (r) {
    case 90: return { dx: y - y0, dy: x - x0 };
    case 180: return { dx: x1 - x, dy: y - y0 };
    case 270: return { dx: y1 - y, dy: x1 - x };
    default: return { dx: x - x0, dy: y1 - y };
  }
}

// Builds a form XObject for a box given in displayed-page points and returns it with the
// annotation Rect. `ops(bw, bh)` draws in an upright, unrotated space of size bw×bh.
export function buildAppearance(doc, page, { dx, dy, bw, bh }, ops, resources) {
  const box = page.getCropBox();
  const rot = page.getRotation().angle;
  const corners = [[dx, dy], [dx + bw, dy], [dx, dy + bh], [dx + bw, dy + bh]].map(([a, b]) => displayToPdf(box, rot, a, b));
  const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
  const rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const t = (displayToPdf(box, rot, 0, 0).rotate * Math.PI) / 180;
  const c = Math.round(Math.cos(t)), s = Math.round(Math.sin(t));
  const dict = { BBox: [0, 0, bw, bh], Matrix: [c, s, -s, c, 0, 0] };
  if (resources) dict.Resources = resources;
  const form = doc.context.formXObject([pushGraphicsState(), ...ops(bw, bh), popGraphicsState()], dict);
  return { rect, ap: doc.context.register(form) };
}

export function inkOps(sig, x, yTop, scale) {
  return drawSvgPath(sig.path, { x, y: yTop, scale, color: rgb(...INKS[sig.ink].rgb), borderColor: undefined, borderWidth: 0 });
}

// Fractions of the displayed page → displayed-page points.
export function fracBox(page, f) {
  const { w, h } = displaySize(page.getCropBox(), page.getRotation().angle);
  return { dx: f.fx * w, dy: f.fy * h, bw: f.fw * w, bh: f.fh * h };
}

const safeName = (s) => s.replace(/[.\\/()<>[\]{}%#]+/g, " ").trim().slice(0, 60) || "Signer";

// Adds one empty signature field per request: { page, fx, fy, fw, fh, label }.
export async function addRequestFields(doc, requests) {
  if (!requests.length) return;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const acroForm = doc.catalog.getOrCreateAcroForm();
  const taken = new Set(acroForm.getAllFields().map(([f]) => f.getPartialName()));
  const pages = doc.getPages();
  for (const rq of requests) {
    const page = pages[rq.page];
    if (!page) continue;
    let name = `Sign here - ${safeName(rq.label)}`, n = 2;
    while (taken.has(name)) name = `Sign here - ${safeName(rq.label)} ${n++}`;
    taken.add(name);

    const text = encodable(font, `Sign here: ${rq.label}`);
    const { rect, ap } = buildAppearance(doc, page, fracBox(page, rq), (bw, bh) => {
      const size = Math.max(5, Math.min(11, bh * 0.26));
      return [
        ...drawRectangle({ x: 0, y: 0, width: bw, height: bh, color: rgb(1, 0.97, 0.82), borderColor: rgb(0.85, 0.62, 0.1), borderWidth: 0.8, rotate: degrees(0), xSkew: degrees(0), ySkew: degrees(0) }),
        ...drawText(font.encodeText(text), { font: "F1", size, x: Math.min(6, bw * 0.05), y: size * 0.6, color: rgb(0.45, 0.32, 0.04), rotate: degrees(0), xSkew: degrees(0), ySkew: degrees(0) }),
      ];
    }, doc.context.obj({ Font: { F1: font.ref } }));

    const ref = doc.context.register(doc.context.obj({
      Type: "Annot", Subtype: "Widget", FT: "Sig",
      T: PDFString.of(name), TU: PDFString.of(`Signature requested from ${rq.label}`),
      Rect: rect, F: 4, P: page.ref, AP: { N: ap },
    }));
    page.node.addAnnot(ref);
    acroForm.addField(ref);
  }
}

function encodable(font, s) {
  try { font.encodeText(s); return s; } catch { return s.normalize("NFKD").replace(/[^\x20-\x7e]/g, ""); }
}

// Empty signature fields in a document, in displayed-page fractions.
export function findOpenFields(doc) {
  const out = [];
  let fields;
  try { fields = doc.getForm().getFields(); } catch { return out; }
  const pages = doc.getPages();
  for (const f of fields) {
    if (!(f instanceof PDFSignature) || f.acroField.dict.has(PDFName.of("V"))) continue;
    const tu = f.acroField.dict.lookupMaybe(PDFName.of("TU"), PDFString)?.decodeText?.();
    const label = tu?.replace(/^Signature requested from\s*/i, "") || f.getName().replace(/^Sign here - /, "");
    for (const w of f.acroField.getWidgets()) {
      const r = w.getRectangle();
      if (!r.width || !r.height) continue;
      const pRef = w.P();
      let pageIndex = pages.findIndex((p) => p.ref === pRef);
      if (pageIndex < 0) {
        const wRef = doc.context.getObjectRef(w.dict);
        pageIndex = pages.findIndex((p) => p.node.Annots()?.asArray().some((a) => a === wRef));
      }
      if (pageIndex < 0) continue;
      const page = pages[pageIndex];
      const box = page.getCropBox(), rot = page.getRotation().angle;
      const { w: W, h: H } = displaySize(box, rot);
      const pts = [[r.x, r.y], [r.x + r.width, r.y], [r.x, r.y + r.height], [r.x + r.width, r.y + r.height]].map(([x, y]) => pdfToDisplay(box, rot, x, y));
      const dxs = pts.map((p) => p.dx), dys = pts.map((p) => p.dy);
      out.push({
        name: f.getName(), label, page: pageIndex,
        fx: Math.min(...dxs) / W, fy: Math.min(...dys) / H,
        fw: (Math.max(...dxs) - Math.min(...dxs)) / W, fh: (Math.max(...dys) - Math.min(...dys)) / H,
      });
    }
  }
  return out;
}
