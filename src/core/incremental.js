// Signing PDFs that are already signed: the original bytes are kept untouched and the
// changes are appended as an incremental update, with the ink added as annotations
// (page content is never edited, so earlier signatures keep validating cleanly).
import {
  PDFDocument, PDFName, PDFDict, PDFArray, PDFNumber, PDFStream, PDFRef, PDFString,
} from "pdf-lib";
import { addSignatureField, fillSignatureField, finalize } from "./pdfsign.js";
import { buildAppearance, inkOps, fracBox, addRequestFields } from "./request.js";

// null = no certification signature; 1 = no changes allowed; 2 = signing/form fill only; 3 = also annotations.
export function docMdpLevel(doc) {
  const perms = doc.catalog.lookupMaybe(PDFName.of("Perms"), PDFDict);
  const sig = perms?.lookupMaybe(PDFName.of("DocMDP"), PDFDict);
  if (!sig) return null;
  const refs = sig.lookupMaybe(PDFName.of("Reference"), PDFArray);
  for (let i = 0; i < (refs?.size() ?? 0); i++) {
    const r = refs.lookup(i, PDFDict);
    const params = r.lookupMaybe(PDFName.of("TransformParams"), PDFDict);
    const p = params?.lookupMaybe(PDFName.of("P"), PDFNumber);
    if (r.lookupMaybe(PDFName.of("TransformMethod"), PDFName) === PDFName.of("DocMDP")) return p ? p.asNumber() : 2;
  }
  return 2;
}

export function canAppend(doc, placements, withId, requests = []) {
  if (doc.context.trailerInfo.Encrypt) return { ok: false, reason: "This PDF is encrypted, so it can't be modified." };
  const p = docMdpLevel(doc);
  if (p && requests.length) return { ok: false, reason: "This PDF is certified against changes, so new signature boxes can't be added to it." };
  if (p === 1) return { ok: false, reason: "This PDF is certified to allow no changes, so it can't be signed again." };
  if (p === 2) {
    if (!withId) return { ok: false, reason: "This PDF is certified to allow signing only. Create a digital ID to sign it." };
    if (placements.length > 1) return { ok: false, reason: "This PDF is certified to allow signing only. Place one signature, which becomes your signature field." };
  }
  return { ok: true };
}

// Ink appearance for a free placement: the box is exactly the signature's extent.
function inkAppearance(doc, page, pl, sig) {
  const b = fracBox(page, { ...pl, fh: 0 });
  const scale = b.bw / sig.width;
  b.bh = sig.height * scale;
  return buildAppearance(doc, page, b, (bw, bh) => inkOps(sig, 0, bh, scale));
}

// Ink appearance for a requested field: the box is the field, the ink sits where it was placed inside it.
function fieldAppearance(doc, page, pl, sig) {
  const fb = fracBox(page, pl.fieldBox);
  const ib = fracBox(page, { ...pl, fh: 0 });
  const scale = ib.bw / sig.width;
  return buildAppearance(doc, page, fb, (bw, bh) => inkOps(sig, ib.dx - fb.dx, bh - (ib.dy - fb.dy), scale));
}

function originalSize(orig) {
  const text = new TextDecoder("latin1").decode(orig);
  return Math.max(0, ...[...text.matchAll(/\/Size\s+(\d+)/g)].map((m) => +m[1]));
}

function snapshot(ctx) {
  const m = new Map();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) m.set(ref.tag, fingerprintOf(obj));
  return m;
}
function fingerprintOf(obj) {
  if (obj instanceof PDFStream) return `S${obj.dict.toString()}#${obj.getContentsSize()}`;
  return obj.toString();
}

// placements: { page, fx, fy, fw, field?, fieldBox? }; requests: new empty boxes to add for others.
export async function appendSigned(orig, placements, sig, identity, { reason = "", requests = [] } = {}) {
  const doc = await PDFDocument.load(orig, { updateMetadata: false });
  const check = canAppend(doc, placements.filter((p) => !p.field), !!identity, requests);
  if (!check.ok) throw Object.assign(new Error(check.reason), { userMessage: check.reason });

  // pdf-lib doesn't count object-stream and xref-stream numbers; never reuse them.
  doc.context.largestObjectNumber = Math.max(doc.context.largestObjectNumber, originalSize(orig) - 1);
  const before = snapshot(doc.context);
  const now = new Date();
  const pages = doc.getPages();
  // The digital signature goes into a requested field if one was signed, else the first placement.
  const carrier = identity ? (placements.find((p) => p.field) ?? placements[0] ?? null) : null;
  let sigWidget = null, filledField = false;

  for (const pl of placements) {
    const page = pages[pl.page];
    if (!page) continue;
    if (pl === carrier && pl.field) {
      const { ap } = fieldAppearance(doc, page, pl, sig);
      fillSignatureField(doc, identity, pl.field, ap, { reason, now });
      filledField = true;
      continue;
    }
    const { rect, ap } = inkAppearance(doc, page, pl, sig);
    if (pl === carrier) { sigWidget = { page, rect, ap }; continue; }
    const ref = doc.context.register(doc.context.obj({
      Type: "Annot", Subtype: "Stamp", Rect: rect, F: 132,
      AP: { N: ap }, P: page.ref, Contents: PDFString.of("Signature"),
    }));
    page.node.addAnnot(ref);
  }
  await addRequestFields(doc, requests);
  if (identity && !filledField) addSignatureField(doc, identity, { reason, widget: sigWidget, now });
  await doc.flush(); // writes embedded fonts into the context

  const bytes = writeUpdate(orig, doc, before);
  return identity ? finalize(bytes, identity, now, orig.length) : bytes;
}

// Serializes new and changed objects plus a classic xref section chained to the original.
function writeUpdate(orig, doc, before) {
  const ctx = doc.context;
  const tail = new TextDecoder("latin1").decode(orig.subarray(Math.max(0, orig.length - 2048)));
  const prev = +/startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail)?.[1];
  if (!Number.isFinite(prev)) throw new Error("Couldn't find the PDF's cross-reference table");
  const size = Math.max(ctx.largestObjectNumber + 1, originalSize(orig));

  const changed = ctx.enumerateIndirectObjects()
    .filter(([ref, obj]) => before.get(ref.tag) !== fingerprintOf(obj))
    .sort((a, b) => a[0].objectNumber - b[0].objectNumber);

  const enc = new TextEncoder();
  const chunks = [];
  let offset = orig.length;
  const push = (u8) => { chunks.push(u8); offset += u8.length; };
  const needsNl = orig[orig.length - 1] !== 0x0a && orig[orig.length - 1] !== 0x0d;
  if (needsNl) push(enc.encode("\n"));

  const xref = [];
  for (const [ref, obj] of changed) {
    xref.push([ref.objectNumber, ref.generationNumber, offset]);
    push(enc.encode(`${ref.objectNumber} ${ref.generationNumber} obj\n`));
    const buf = new Uint8Array(obj.sizeInBytes());
    obj.copyBytesInto(buf, 0);
    push(buf);
    push(enc.encode("\nendobj\n"));
  }

  const xrefAt = offset;
  let x = "xref\n";
  for (let i = 0; i < xref.length;) {
    let j = i;
    while (j + 1 < xref.length && xref[j + 1][0] === xref[j][0] + 1) j++;
    x += `${xref[i][0]} ${j - i + 1}\n`;
    for (let k = i; k <= j; k++) x += `${String(xref[k][2]).padStart(10, "0")} ${String(xref[k][1]).padStart(5, "0")} n\r\n`;
    i = j + 1;
  }
  const t = ctx.trailerInfo;
  const trailer = PDFDict.withContext(ctx);
  trailer.set(PDFName.of("Size"), PDFNumber.of(size));
  trailer.set(PDFName.of("Root"), t.Root);
  if (t.Info) trailer.set(PDFName.of("Info"), t.Info);
  if (t.ID) trailer.set(PDFName.of("ID"), t.ID);
  trailer.set(PDFName.of("Prev"), PDFNumber.of(prev));
  x += `trailer\n${trailer.toString()}\nstartxref\n${xrefAt}\n%%EOF\n`;
  push(enc.encode(x));

  const out = new Uint8Array(offset);
  out.set(orig, 0);
  let o = orig.length;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export { PDFRef };
