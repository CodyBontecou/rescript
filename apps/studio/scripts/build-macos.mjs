#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.error("The macOS bundle can only be built on macOS.");
  process.exit(1);
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const studioDirectory = resolve(scriptDirectory, "..");
const tauriDirectory = join(studioDirectory, "src-tauri");
const extraArguments = process.argv.slice(2);
const debug = extraArguments.includes("--debug");
const profile = debug ? "debug" : "release";
const configuration = JSON.parse(
  readFileSync(join(tauriDirectory, "tauri.conf.json"), "utf8")
);
const productName = configuration.productName;
const version = configuration.version;

const stageTools = spawnSync(
  process.execPath,
  [join(scriptDirectory, "stage-native-tools.mjs"), ...(debug ? ["--optional"] : [])],
  { cwd: studioDirectory, env: process.env, stdio: "inherit" }
);
if (stageTools.status !== 0) process.exit(stageTools.status ?? 1);

const tauri = spawnSync(
  process.execPath,
  [
    join(scriptDirectory, "run-tauri.mjs"),
    "build",
    "--bundles",
    "app",
    ...extraArguments,
  ],
  { cwd: studioDirectory, env: process.env, stdio: "inherit" }
);
if (tauri.status !== 0) process.exit(tauri.status ?? 1);

const bundleDirectory = join(tauriDirectory, "target", profile, "bundle");
const app = join(bundleDirectory, "macos", `${productName}.app`);
const dmgDirectory = join(bundleDirectory, "dmg");
const staging = join(dmgDirectory, ".headless-stage");
const architecture = process.arch === "arm64" ? "aarch64" : process.arch;
const dmg = join(dmgDirectory, `${productName}_${version}_${architecture}.dmg`);

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
cpSync(app, join(staging, `${productName}.app`), { recursive: true });
symlinkSync("/Applications", join(staging, "Applications"));
mkdirSync(dmgDirectory, { recursive: true });
rmSync(dmg, { force: true });

const hdiutil = spawnSync(
  "hdiutil",
  [
    "create",
    "-volname",
    productName,
    "-srcfolder",
    staging,
    "-ov",
    "-format",
    "UDZO",
    dmg,
  ],
  { stdio: "inherit" }
);
rmSync(staging, { recursive: true, force: true });
if (hdiutil.status !== 0) process.exit(hdiutil.status ?? 1);

console.log(`Built macOS app: ${app}`);
console.log(`Built headless-safe DMG: ${dmg}`);
