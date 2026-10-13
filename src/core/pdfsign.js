// Digital signatures (adbe.pkcs7.detached) for pdf-lib documents.
import { PDFName, PDFNumber, PDFHexString, PDFString, PDFArray } from "pdf-lib";
import { cmsSign } from "./identity.js";

const SIG_BYTES = 16384; // room reserved for the CMS blob
const BR_PLACEHOLDER = "**********";

// Adds an unsigned signature field whose value is a placeholder. `widget` may carry
// { page, rect, ap } to make the field visible; otherwise it's a zero-size widget on page 1.
export function addSignatureField(doc, identity, { reason = "", widget = null, now = new Date() } = {}) {
  const ctx = doc.context;
  const page = widget?.page ?? doc.getPages()[0];
  const sigRef = makeSigValue(doc, identity, { reason, now });

  const acroForm = doc.catalog.getOrCreateAcroForm();
  const taken = new Set(acroForm.getAllFields().map(([f]) => f.getPartialName()));
  let n = 1; while (taken.has(`InkSignature${n}`)) n++;

  const w = {
    Type: "Annot", Subtype: "Widget", FT: "Sig",
    Rect: widget?.rect ?? [0, 0, 0, 0],
    F: 132, // print + locked
    T: PDFString.of(`InkSignature${n}`),
    V: sigRef, P: page.ref,
  };
  if (widget?.ap) w.AP = { N: widget.ap };
  const widgetRef = ctx.register(ctx.obj(w));
  page.node.addAnnot(widgetRef);
  acroForm.addField(widgetRef);
  acroForm.dict.set(PDFName.of("SigFlags"), PDFNumber.of(3));
  return widgetRef;
}

// Signs into an existing empty signature field (e.g. one placed by a signature request).
export function fillSignatureField(doc, identity, fieldName, ap, { reason = "", now = new Date() } = {}) {
  const field = doc.getForm().getFields().find((f) => f.getName() === fieldName);
  if (!field) throw new Error(`Signature field "${fieldName}" not found`);
  field.acroField.dict.set(PDFName.of("V"), makeSigValue(doc, identity, { reason, now }));
  const widget = field.acroField.getWidgets()[0];
  widget.dict.set(PDFName.of("AP"), doc.context.obj({ N: ap }));
  widget.dict.set(PDFName.of("F"), PDFNumber.of(132));
  doc.catalog.getOrCreateAcroForm().dict.set(PDFName.of("SigFlags"), PDFNumber.of(3));
}

function makeSigValue(doc, identity, { reason, now }) {
  const ctx = doc.context;
  const byteRange = PDFArray.withContext(ctx);
  byteRange.push(PDFNumber.of(0));
  for (let i = 0; i < 3; i++) byteRange.push(PDFName.of(BR_PLACEHOLDER));
  const sig = {
    Type: "Sig", Filter: "Adobe.PPKLite", SubFilter: "adbe.pkcs7.detached",
    ByteRange: byteRange,
    Contents: PDFHexString.of("0".repeat(SIG_BYTES * 2)),
    M: PDFString.fromDate(now),
    Name: PDFString.of(identity.name),
  };
  if (reason) sig.Reason = PDFString.of(reason);
  return ctx.register(ctx.obj(sig));
}

// Whole-file rewrite path (document had no signatures before).
export async function signPdf(doc, identity, { reason = "" } = {}) {
  const now = new Date();
  addSignatureField(doc, identity, { reason, now });
  const bytes = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
  return finalize(bytes, identity, now);
}

// Fills the placeholder: computes ByteRange, hashes, embeds the CMS. `from` limits the
// placeholder search to the appended part of an incremental update.
export async function finalize(bytes, identity, now, from = 0) {
  const text = new TextDecoder("latin1").decode(bytes);
  const zeros = "0".repeat(SIG_BYTES * 2);
  const cStart = text.indexOf(`<${zeros}>`, from);
  if (cStart < 0) throw new Error("Signature placeholder not found");
  const cEnd = cStart + zeros.length + 2;

  const ph = text.indexOf("/" + BR_PLACEHOLDER, from);
  const brStart = ph < 0 ? -1 : text.lastIndexOf("/ByteRange", ph);
  if (brStart < from) throw new Error("ByteRange placeholder not found");
  const brEnd = text.indexOf("]", brStart) + 1;
  const range = [0, cStart, cEnd, bytes.length - cEnd];
  const actual = `/ByteRange [${range.join(" ")}]`;
  const slot = brEnd - brStart;
  if (actual.length > slot) throw new Error("ByteRange does not fit");
  const out = new Uint8Array(bytes);
  writeAscii(out, brStart, actual.padEnd(slot, " "));

  const signed = new Uint8Array(range[1] + range[3]);
  signed.set(out.subarray(0, range[1]), 0);
  signed.set(out.subarray(range[2]), range[1]);
  const digest = await crypto.subtle.digest("SHA-256", signed);

  const cms = await cmsSign(identity, digest, now);
  if (cms.length > SIG_BYTES) throw new Error("Signature larger than reserved space");
  let hex = "";
  for (const b of cms) hex += b.toString(16).padStart(2, "0");
  writeAscii(out, cStart + 1, hex.toUpperCase());
  return out;
}

function writeAscii(buf, at, s) {
  for (let i = 0; i < s.length; i++) buf[at + i] = s.charCodeAt(i);
}
