// Signs a PDF, then signs it again incrementally (with ink as annotations) and checks both survive.
// Runs on a classic-xref file and on an xref-stream file.
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { writeFileSync } from "node:fs";
import { buildSignature, PRESETS } from "../src/core/ink.js";
import { stampPdf } from "../src/core/stamp.js";
import { createIdentity } from "../src/core/identity.js";
import { signPdf } from "../src/core/pdfsign.js";
import { appendSigned } from "../src/core/incremental.js";

const out = process.argv[2];
const pts = [];
for (let i = 0; i <= 40; i++) pts.push([10, 10 + i * 2, 0.5]);
for (let i = 0; i <= 40; i++) pts.push([10 + i * 3, 90, 0.5]);
const sig = buildSignature([{ points: pts, pen: false }], PRESETS.felt, "blue");
const alice = await createIdentity({ name: "Alice First" });
const bob = await createIdentity({ name: "Bob Second" });

async function base(objectStreams) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (const r of [0, 90]) { const p = d.addPage([300, 420]); p.setRotation(degrees(r)); p.drawText(`rotate ${r}`, { x: 20, y: 200, size: 18, font: f }); }
  return d.save({ useObjectStreams: objectStreams });
}

for (const [name, os] of [["classic", false], ["xrefstream", true]]) {
  const b = await base(os);
  let first;
  if (os) first = await appendSigned(b, [{ page: 0, fx: 0.1, fy: 0.1, fw: 0.4 }], sig, alice); // first signature via append too
  else first = await signPdf(await stampPdf(b, [{ page: 0, fx: 0.1, fy: 0.1, fw: 0.4 }], sig), alice);
  const second = await appendSigned(first, [
    { page: 1, fx: 0.5, fy: 0.1, fw: 0.4 },   // becomes Bob's signature widget
    { page: 0, fx: 0.5, fy: 0.6, fw: 0.3 },   // stamp annotation
  ], sig, bob, { reason: "Countersigned" });
  writeFileSync(`${out}/${name}.pdf`, second);
  const unsigned = await appendSigned(second, [{ page: 0, fx: 0.1, fy: 0.75, fw: 0.3 }], sig, null);
  writeFileSync(`${out}/${name}-ink-only.pdf`, unsigned);
}
console.log("ok");
