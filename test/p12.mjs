// .p12 round trip: create → back up → read with OpenSSL; import our file and an OpenSSL-made one → sign → verify.
import { readFileSync, writeFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { createIdentity } from "../src/core/identity.js";
import { exportP12, importP12, lockKey, P12Error } from "../src/core/p12.js";
import { signPdf } from "../src/core/pdfsign.js";

const out = process.argv[2];
const id = await createIdentity({ name: "Åsa Backup", email: "asa@example.com" });
let t = Date.now();
const p12 = await exportP12({ ...id, password: "correct horse", friendlyName: "Åsa Backup" });
console.log("export ms", Date.now() - t);
writeFileSync(`${out}/ours.p12`, p12);
id.privateKey = await lockKey(id.privateKey);
try { await crypto.subtle.exportKey("pkcs8", id.privateKey); console.log("FAIL: still extractable"); } catch { console.log("locked: not extractable"); }

t = Date.now();
const back = await importP12(p12, "correct horse");
console.log("import ms", Date.now() - t, back.name, back.email, "same cert:", Buffer.compare(Buffer.from(back.certDer), Buffer.from(id.certDer)) === 0);
try { await importP12(p12, "wrong"); } catch (e) { console.log("wrong pw ->", e instanceof P12Error && e.code); }

async function signWith(ident, file) {
  const d = await PDFDocument.create(); d.addPage();
  writeFileSync(file, await signPdf(d, ident));
}
await signWith(back, `${out}/signed-ours.pdf`);

const ext = await importP12(readFileSync(`${out}/openssl.p12`), "pw1234");
console.log("openssl id:", ext.name, "| chain certs:", ext.chainDers.length,
  "| cert bytes preserved:", Buffer.compare(Buffer.from(ext.certDer), readFileSync(`${out}/leaf.der`)) === 0);
await signWith(ext, `${out}/signed-openssl.pdf`);
