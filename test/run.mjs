// Node test: stamp a signature on pages with every /Rotate, sign, then verify externally.
import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";
import { writeFileSync } from "node:fs";
import { buildSignature, PRESETS } from "../src/core/ink.js";
import { stampPdf } from "../src/core/stamp.js";
import { createIdentity, certToPem } from "../src/core/identity.js";
import { signPdf } from "../src/core/pdfsign.js";

const out = process.argv[2];

// A squiggle shaped like an "L" so orientation is obvious in renders.
const pts = [];
for (let i = 0; i <= 40; i++) pts.push([10, 10 + i * 2, 0.5]);
for (let i = 0; i <= 40; i++) pts.push([10 + i * 3, 90, 0.5]);
const sig = buildSignature([{ points: pts, pen: false }], PRESETS.felt, "blue");

const src = await PDFDocument.create();
const font = await src.embedFont(StandardFonts.Helvetica);
for (const r of [0, 90, 180, 270]) {
  const p = src.addPage([300, 420]);
  p.setRotation(degrees(r));
  p.drawText(`rotate ${r}`, { x: 20, y: 200, size: 18, font, color: rgb(0, 0, 0) });
}
// one page with an offset crop box
const c = src.addPage([400, 400]);
c.setCropBox(50, 50, 300, 300);
c.drawText("cropped", { x: 120, y: 200, size: 18, font });

const bytes = await src.save();
const placements = [0, 1, 2, 3, 4].map((page) => ({ page, fx: 0.1, fy: 0.1, fw: 0.4 }));
const stamped = await stampPdf(bytes, placements, sig);
writeFileSync(`${out}/stamped.pdf`, await stamped.save());

const id = await createIdentity({ name: "Test Signer", email: "test@example.com" });
writeFileSync(`${out}/cert.pem`, certToPem(id.certDer));
const doc2 = await stampPdf(bytes, placements, sig);
const signed = await signPdf(doc2, id, { reason: "Approved" });
writeFileSync(`${out}/signed.pdf`, signed);
console.log("sig", Math.round(sig.width), Math.round(sig.height), "signed bytes", signed.length);
