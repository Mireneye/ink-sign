// Builds two targets from the same source:
//   dist/extension  – load unpacked or upload to the Chrome Web Store
//   dist/web        – static site for GitHub Pages
// Everything ships locally: MV3 forbids remote code, and the web CSP blocks all outside connections.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
const pdfjs = "node_modules/pdfjs-dist";

for (const target of ["extension", "web"]) {
  const out = `dist/${target}`;
  mkdirSync(`${out}/vendor`, { recursive: true });
  await build({
    entryPoints: ["src/app/app.js"],
    bundle: true, format: "esm", target: "chrome116",
    outfile: `${out}/app.js`, minify: true, legalComments: "external", logLevel: "warning",
  });
  const html = readFileSync("src/app/app.html", "utf8");
  writeFileSync(`${out}/${target === "web" ? "index.html" : "app.html"}`, html);
  cpSync("src/app/app.css", `${out}/app.css`);
  cpSync("src/icons", `${out}/icons`, { recursive: true });
  cpSync(`${pdfjs}/build/pdf.worker.min.mjs`, `${out}/vendor/pdf.worker.min.mjs`);
  cpSync(`${pdfjs}/cmaps`, `${out}/vendor/cmaps`, { recursive: true });
  cpSync(`${pdfjs}/standard_fonts`, `${out}/vendor/standard_fonts`, { recursive: true });
  if (target === "extension") {
    cpSync("src/manifest.json", `${out}/manifest.json`);
    cpSync("src/background.js", `${out}/background.js`);
  } else {
    writeFileSync(`${out}/.nojekyll`, "");
  }
}
console.log("built dist/extension and dist/web");
