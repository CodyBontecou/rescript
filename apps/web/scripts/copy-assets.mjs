/**
 * Copies WASM runtime assets from node_modules into public/ so the app can be
 * served fully offline (no CDN requests at runtime):
 *   - @ffmpeg/core-mt  -> public/vendor/ffmpeg/  (audio extraction + export)
 *   - onnxruntime-web  -> public/vendor/ort/     (transformers.js inference)
 * Runs automatically on `npm install` (postinstall).
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = join(webRoot, "../..");

const ffmpegSrc = join(workspaceRoot, "node_modules/@ffmpeg/core-mt/dist/esm");
const ffmpegDst = join(webRoot, "public/vendor/ffmpeg");
mkdirSync(ffmpegDst, { recursive: true });
for (const f of readdirSync(ffmpegSrc)) {
  cpSync(join(ffmpegSrc, f), join(ffmpegDst, f));
}

// The @ffmpeg/ffmpeg "class worker" contains a dynamic import() that bundlers
// cannot process; serve the package's own ESM build and point classWorkerURL
// at it instead (see lib/ffmpeg.ts).
const ffmpegClassSrc = join(workspaceRoot, "node_modules/@ffmpeg/ffmpeg/dist/esm");
const ffmpegClassDst = join(webRoot, "public/vendor/ffmpeg-class");
mkdirSync(ffmpegClassDst, { recursive: true });
for (const f of readdirSync(ffmpegClassSrc)) {
  if (f.endsWith(".js") || f.endsWith(".mjs")) {
    cpSync(join(ffmpegClassSrc, f), join(ffmpegClassDst, f));
  }
}

const ortSrc = join(workspaceRoot, "node_modules/onnxruntime-web/dist");
const ortDst = join(webRoot, "public/vendor/ort");
mkdirSync(ortDst, { recursive: true });
for (const f of readdirSync(ortSrc)) {
  if (/^ort-wasm-simd-threaded.*\.(wasm|mjs)$/.test(f)) {
    cpSync(join(ortSrc, f), join(ortDst, f));
  }
}

// parakeet.js currently pins a different onnxruntime-web release. Keep its
// matching WASM binaries at a separate URL; mixing ORT JavaScript and WASM
// versions fails during decoder session initialization.
const nestedParakeetOrt = join(
  workspaceRoot,
  "node_modules/parakeet.js/node_modules/onnxruntime-web/dist"
);
const parakeetOrtSrc = existsSync(nestedParakeetOrt) ? nestedParakeetOrt : ortSrc;
const parakeetOrtDst = join(webRoot, "public/vendor/parakeet-ort");
mkdirSync(parakeetOrtDst, { recursive: true });
for (const f of readdirSync(parakeetOrtSrc)) {
  if (/^ort-wasm-simd-threaded.*\.(wasm|mjs)$/.test(f)) {
    cpSync(join(parakeetOrtSrc, f), join(parakeetOrtDst, f));
  }
}

// coi-serviceworker provides COOP/COEP headers on static hosts (GitHub Pages)
// that can't send them, keeping cross-origin isolation for SharedArrayBuffer.
// A config prelude is prepended: always use COEP "credentialless" (needed for
// Google Analytics) and skip registration when real headers already isolated
// the page (local dev / self-hosting with a proper server).
const coiSrc = join(workspaceRoot, "node_modules/coi-serviceworker/coi-serviceworker.js");
const coiPrelude =
  'if (typeof window !== "undefined") {\n' +
  "  window.coi = {\n" +
  "    coepCredentialless: () => true,\n" +
  "    shouldRegister: () => !window.crossOriginIsolated,\n" +
  "  };\n" +
  "}\n";
writeFileSync(
  join(webRoot, "public/coi-serviceworker.js"),
  coiPrelude + readFileSync(coiSrc, "utf8")
);

console.log(
  "[copy-assets] ffmpeg core + transformers/parakeet ONNX WASM + coi-serviceworker copied to public/"
);
