// Local digital ID: an RSA key that never leaves the browser plus a self-signed certificate.
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";

let engineReady = false;
export function ensureEngine() {
  if (engineReady) return;
  pkijs.setEngine("webcrypto", new pkijs.CryptoEngine({ name: "webcrypto", crypto: globalThis.crypto }));
  engineReady = true;
}

const OID = {
  commonName: "2.5.4.3",
  email: "1.2.840.113549.1.9.1",
  keyUsage: "2.5.29.15",
  basicConstraints: "2.5.29.19",
};

export async function createIdentity({ name, email, years = 5 }) {
  ensureEngine();
  const keys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, // extractable only until the backup is written; see p12.js lockKey()
    ["sign", "verify"],
  );

  const cert = new pkijs.Certificate();
  cert.version = 2;
  const serial = crypto.getRandomValues(new Uint8Array(16));
  serial[0] &= 0x7f;
  cert.serialNumber = new asn1js.Integer({ valueHex: serial.buffer });

  const dn = [new pkijs.AttributeTypeAndValue({ type: OID.commonName, value: new asn1js.Utf8String({ value: name }) })];
  if (email) dn.push(new pkijs.AttributeTypeAndValue({ type: OID.email, value: new asn1js.IA5String({ value: email }) }));
  cert.subject.typesAndValues.push(...dn);
  cert.issuer.typesAndValues.push(...dn);

  const now = new Date();
  cert.notBefore.value = new Date(now.getTime() - 60_000);
  const until = new Date(now); until.setFullYear(until.getFullYear() + years);
  cert.notAfter.value = until;

  const ku = new asn1js.BitString({ valueHex: new Uint8Array([0xc0]).buffer, unusedBits: 6 }); // digitalSignature, nonRepudiation
  const bc = new pkijs.BasicConstraints({ cA: false });
  cert.extensions = [
    new pkijs.Extension({ extnID: OID.keyUsage, critical: true, extnValue: ku.toBER(false), parsedValue: ku }),
    new pkijs.Extension({ extnID: OID.basicConstraints, critical: true, extnValue: bc.toSchema().toBER(false), parsedValue: bc }),
  ];

  await cert.subjectPublicKeyInfo.importKey(keys.publicKey);
  // Sign by hand so sha256WithRSAEncryption carries explicit NULL parameters (RFC 4055).
  // PKI.js omits them; other tools add them on re-encode, which would change the fingerprint.
  const alg = () => new pkijs.AlgorithmIdentifier({ algorithmId: "1.2.840.113549.1.1.11", algorithmParams: new asn1js.Null() });
  cert.signature = alg();
  cert.signatureAlgorithm = alg();
  const tbs = cert.encodeTBS().toBER(false);
  cert.tbsView = new Uint8Array(tbs);
  const sigValue = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, tbs);
  cert.signatureValue = new asn1js.BitString({ valueHex: sigValue });

  return {
    name, email: email || "",
    created: now.toISOString(),
    expires: until.toISOString(),
    privateKey: keys.privateKey,
    certDer: new Uint8Array(cert.toSchema(true).toBER(false)),
    chainDers: [],
    source: "created",
  };
}

export function parseCert(certDer) {
  ensureEngine();
  const asn = asn1js.fromBER(certDer.buffer.slice(certDer.byteOffset, certDer.byteOffset + certDer.byteLength));
  return new pkijs.Certificate({ schema: asn.result });
}

export async function fingerprint(certDer) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", certDer));
  return [...h.slice(0, 10)].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":");
}

export function certToPem(certDer) {
  let bin = "";
  for (const b of certDer) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/.{64}/g, "$&\n");
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

// Detached CMS SignedData (adbe.pkcs7.detached) over a precomputed SHA-256 digest.
export async function cmsSign(identity, digest, signingTime = new Date()) {
  ensureEngine();
  const cert = parseCert(identity.certDer);
  const signedData = new pkijs.SignedData({
    version: 1,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: "1.2.840.113549.1.7.1" }),
    signerInfos: [
      new pkijs.SignerInfo({
        version: 1,
        sid: new pkijs.IssuerAndSerialNumber({ issuer: cert.issuer, serialNumber: cert.serialNumber }),
        signedAttrs: new pkijs.SignedAndUnsignedAttributes({
          type: 0,
          attributes: [
            new pkijs.Attribute({ type: "1.2.840.113549.1.9.3", values: [new asn1js.ObjectIdentifier({ value: "1.2.840.113549.1.7.1" })] }),
            new pkijs.Attribute({ type: "1.2.840.113549.1.9.5", values: [new asn1js.UTCTime({ valueDate: signingTime })] }),
            new pkijs.Attribute({ type: "1.2.840.113549.1.9.4", values: [new asn1js.OctetString({ valueHex: digest })] }),
          ],
        }),
      }),
    ],
    certificates: [cert, ...(identity.chainDers ?? []).map((d) => parseCert(d))],
  });
  await signedData.sign(identity.privateKey, 0, "SHA-256");
  const ci = new pkijs.ContentInfo({ contentType: "1.2.840.113549.1.7.2", content: signedData.toSchema(true) });
  return new Uint8Array(ci.toSchema().toBER(false));
}
