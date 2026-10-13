// Bakes placed signatures into PDFs and images.
// A placement is stored in fractions of the page as displayed: { page, fx, fy, fw }.
import { PDFDocument, PDFSignature, PDFName, rgb, degrees } from "pdf-lib";
import { INKS } from "./ink.js";

// Map a box given in displayed-page points (origin top-left, y down) to PDF user space,
// accounting for the crop box origin and the page's /Rotate.
export function displayToPdf(box, rotation, dx, dy) {
  const r = ((rotation % 360) + 360) % 360;
  const { x: x0, y: y0, width: W, height: H } = box;
  const x1 = x0 + W, y1 = y0 + H;
  switch (r) {
    case 90: return { x: x0 + dy, y: y0 + dx, rotate: 90 };
    case 180: return { x: x1 - dx, y: y0 + dy, rotate: 180 };
    case 270: return { x: x1 - dy, y: y1 - dx, rotate: 270 };
    default: return { x: x0 + dx, y: y1 - dy, rotate: 0 };
  }
}

export function displaySize(box, rotation) {
  const r = ((rotation % 360) + 360) % 360;
  return r === 90 || r === 270 ? { w: box.height, h: box.width } : { w: box.width, h: box.height };
}

export async function stampPdf(bytes, placements, sig) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages();
  const color = rgb(...INKS[sig.ink].rgb);
  for (const p of placements) {
    const page = pages[p.page];
    if (!page) continue;
    const box = page.getCropBox();
    const rot = page.getRotation().angle;
    const { w, h } = displaySize(box, rot);
    const at = displayToPdf(box, rot, p.fx * w, p.fy * h);
    page.drawSvgPath(sig.path, {
      x: at.x, y: at.y,
      scale: (p.fw * w) / sig.width,
      rotate: degrees(at.rotate),
      color, borderWidth: 0,
    });
  }
  return doc;
}

// Returns true when the PDF already carries a filled-in digital signature,
// which a full rewrite would invalidate.
export function hasExistingSignatures(doc) {
  try {
    return doc.getForm().getFields().some((f) => f instanceof PDFSignature && f.acroField.dict.has(PDFName.of("V")));
  } catch { return false; }
}

export function drawSignatureOnCanvas(ctx, sig, x, y, w, inkCss) {
  const s = w / sig.width;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.fillStyle = inkCss ?? INKS[sig.ink].css;
  ctx.fill(new Path2D(sig.path));
  ctx.restore();
}
