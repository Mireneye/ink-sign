// PKCS#12 (.p12 / .pfx) backup and import for digital IDs.
// Written with 3DES + SHA-1 MAC: the variant every major reader (Acrobat, Windows, macOS, OpenSSL 3) accepts.
import forge from "node-forge";

const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
const ITERATIONS = 50000;

const toBin = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return s; };
const toU8 = (bin) => { const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };

export class P12Error extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// privateKey must still be extractable (only true right after creation).
export async function exportP12({ privateKey, certDer, chainDers = [], password, friendlyName }) {
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey));
  const key = forge.pki.privateKeyFromAsn1(forge.asn1.fromDer(toBin(pkcs8)));
  const certs = [certDer, ...chainDers].map((d) => forge.pki.certificateFromAsn1(forge.asn1.fromDer(toBin(d))));
  const asn1 = forge.pkcs12.toPkcs12Asn1(key, certs, password, {
    algorithm: "3des", count: ITERATIONS, friendlyName, generateLocalKeyId: true,
  });
  return toU8(forge.asn1.toDer(asn1).getBytes());
}

// Returns { privateKey (non-extractable), certDer, chainDers, name, email, expires }.
export async function importP12(bytes, password) {
  let p12;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(toBin(bytes)), password);
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (/password|MAC|decrypt/i.test(msg)) throw new P12Error("password", "That password doesn't open this file.");
    if (/RC2|unsupported|algorithm/i.test(msg)) throw new P12Error("format", "This file uses old encryption Ink Sign can't read. Re-export it from the program that made it, using AES or 3DES.");
    throw new P12Error("format", "This doesn't look like a .p12 or .pfx file.");
  }
  const bags = (type) => p12.getBags({ bagType: type })[type] ?? [];
  const keyBags = [...bags(forge.pki.oids.pkcs8ShroudedKeyBag), ...bags(forge.pki.oids.keyBag)];
  if (!keyBags.length) throw new P12Error("nokey", "This file has no private key, so it can't be used to sign.");
  const keyBag = keyBags.find((b) => b.key) ?? keyBags[0];
  if (!keyBag.key) throw new P12Error("keytype", "This ID uses a key type Ink Sign doesn't support yet (only RSA keys work for now).");
  const key = keyBag.key;

  const certs = bags(forge.pki.oids.certBag).map((b) => b.cert).filter(Boolean);
  const own = certs.find((c) => c.publicKey?.n && c.publicKey.n.equals(key.n));
  if (!own) throw new P12Error("nocert", "This file has a key but no matching certificate.");
  const chain = certs.filter((c) => c !== own);

  const der = (c) => toU8(forge.asn1.toDer(forge.pki.certificateToAsn1(c)).getBytes());
  const pkcs8 = toU8(forge.asn1.toDer(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(key))).getBytes());
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, RSA, false, ["sign"]);
  pkcs8.fill(0);

  const field = (sn) => {
    const v = own.subject.getField(sn)?.value;
    if (v == null) return undefined;
    try { return forge.util.decodeUtf8(v); } catch { return v; }
  };
  return {
    privateKey,
    certDer: der(own),
    chainDers: chain.map(der),
    name: field("CN") ?? field("O") ?? "Unnamed ID",
    email: field("E") ?? field("emailAddress") ?? "",
    expires: own.validity.notAfter.toISOString(),
    created: new Date().toISOString(),
    source: "imported",
  };
}

// Turns a freshly generated, still-extractable key into the non-extractable copy that is stored.
export async function lockKey(privateKey) {
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey));
  const locked = await crypto.subtle.importKey("pkcs8", pkcs8, RSA, false, ["sign"]);
  pkcs8.fill(0);
  return locked;
}
