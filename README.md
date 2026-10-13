# Ink Sign

Sign PDFs and images in your browser, with a hand-drawn signature and an optional digital signature.
Your documents never leave your computer: there is no server, no account, and the page's security
policy blocks every outside connection.

Runs as a website (GitHub Pages) and as a Brave/Chrome extension, built from the same source.

## Features
- **Hand-drawn signature** with a natural ink brush (presets, custom settings, undo/redo).
- **PDF, PNG, JPEG, WebP.** Click to place, drag to move, drag the corner to resize.
- **Digital signatures for PDFs** (`adbe.pkcs7.detached`, SHA-256, RSA-2048), so any later change is detectable.
- **Signs already-signed PDFs without breaking them.** The new signature is appended as a revision and the ink is
  added as annotations, so earlier signatures stay valid. Certified PDFs that forbid changes are refused.
- **Digital ID backup and import (.p12 / .pfx).** A new ID must be backed up to a password-protected file before use;
  after that the private key is stored non-extractable in the browser. The file restores the ID on any computer,
  browser or domain, and works in Adobe Acrobat. IDs from certificate authorities can be imported too (RSA keys).

## Use it
- **Web:** open the GitHub Pages site.
- **Extension (development):** `npm install && npm run build`, then in `brave://extensions` turn on Developer mode,
  **Load unpacked**, and pick `dist/extension`.

## Build
```
npm install
npm run build     # dist/extension and dist/web
```
Pushing to `main` builds both and deploys `dist/web` to GitHub Pages (see `.github/workflows/build.yml`).
The extension build is attached to each workflow run as an artifact.

## Tests
```
node test/run.mjs <outdir>          # stamping on rotated/cropped pages + signing
node test/incremental.mjs <outdir>  # signing already-signed PDFs (classic and xref-stream files)
node test/p12.mjs <outdir>          # .p12 export/import round trips (needs <outdir>/openssl.p12, see file)
python3 test/ui_test.py dist/extension <pdf> <outdir>   # end-to-end in Chromium (Playwright)
python3 test/ui_p12.py dist/extension <p12> <outdir>
```
Verify outputs with `pdfsig` (poppler) and `qpdf --check`.

## Limits
- Self-created IDs are self-signed: PDF readers show the signature as intact but the signer as unverified until the
  recipient trusts your exported certificate.
- No trusted timestamp (RFC 3161); the signing time comes from the signer's clock.
- Encrypted PDFs and DOCX are not supported yet. Only RSA keys can be imported.
- E-signatures are not valid for every kind of document in every country. This is not legal advice.

## Layout
- `src/core/` – signature artwork, stamping, digital IDs, PDF signing, incremental updates, PKCS#12
- `src/app/` – the signing UI (shared by web and extension)
- `src/manifest.json`, `src/background.js` – extension only
