// Request flow: Alice signs and requests Bob (page 1) and Carol (rotated page 2); each fills their box.
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { writeFileSync } from "node:fs";
import { buildSignature, PRESETS } from "../src/core/ink.js";
import { stampPdf } from "../src/core/stamp.js";
import { createIdentity } from "../src/core/identity.js";
import { signPdf } from "../src/core/pdfsign.js";
import { appendSigned } from "../src/core/incremental.js";
import { addRequestFields, findOpenFields } from "../src/core/request.js";

const out = process.argv[2];
const pts = [];
for (let i = 0; i <= 40; i++) pts.push([10 + i * 3, 50 + 20 * Math.sin(i / 4), 0.5]);
const sig = buildSignature([{ points: pts, pen: false }], PRESETS.felt, "blue");
const [alice, bob, carol] = await Promise.all(["Alice", "Bob", "Carol Ä"].map((name) => createIdentity({ name })));

const d = await PDFDocument.create();
const f = await d.embedFont(StandardFonts.Helvetica);
for (const r of [0, 90]) { const p = d.addPage([300, 420]); p.setRotation(degrees(r)); p.drawText(`rotate ${r}`, { x: 20, y: 200, size: 16, font: f }); }
const base = await d.save();

// Alice: her own ink + digital signature + two requests, in one rewrite.
const doc = await stampPdf(base, [{ page: 0, fx: 0.1, fy: 0.08, fw: 0.35 }], sig);
await addRequestFields(doc, [
  { page: 0, fx: 0.1, fy: 0.7, fw: 0.5, fh: 0.12, label: "Bob" },
  { page: 1, fx: 0.4, fy: 0.6, fw: 0.45, fh: 0.18, label: "Carol Ä" },
]);
let bytes = await signPdf(doc, alice);
writeFileSync(`${out}/req-1-alice.pdf`, bytes);

// Each recipient fills their own box (fit like the UI does: 90% of the box, centred).
async function fill(bytes, who, id) {
  const open = findOpenFields(await PDFDocument.load(bytes));
  const fld = open.find((o) => o.label.startsWith(who));
  const pageSize = (await PDFDocument.load(bytes)).getPages()[fld.page];
  const rot = pageSize.getRotation().angle, cb = pageSize.getCropBox();
  const W = rot % 180 ? cb.height : cb.width, H = rot % 180 ? cb.width : cb.height;
  const aspect = (sig.height / sig.width) * (W / H);
  const fw = Math.min(fld.fw, fld.fh / aspect) * 0.9;
  const pl = { page: fld.page, fw, fx: fld.fx + (fld.fw - fw) / 2, fy: fld.fy + (fld.fh - fw * aspect) / 2,
    field: fld.name, fieldBox: { fx: fld.fx, fy: fld.fy, fw: fld.fw, fh: fld.fh } };
  console.log(who, "open fields before:", open.map((o) => o.label).join(", "));
  return appendSigned(bytes, [pl], sig, id);
}
bytes = await fill(bytes, "Bob", bob);
writeFileSync(`${out}/req-2-bob.pdf`, bytes);
bytes = await fill(bytes, "Carol", carol);
writeFileSync(`${out}/req-3-carol.pdf`, bytes);
console.log("open fields after:", findOpenFields(await PDFDocument.load(bytes)).length);
