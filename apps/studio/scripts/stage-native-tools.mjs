#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const optional = process.argv.includes("--optional");
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const destination = resolve(scriptDirectory, "../src-tauri/resources/bin");
const tools = [
  ["ffmpeg", "RESCRIPT_BUNDLE_FFMPEG"],
  ["ffprobe", "RESCRIPT_BUNDLE_FFPROBE"],
  ["whisper-cli", "RESCRIPT_BUNDLE_WHISPER_CLI"],
  ["fluidaudiocli", "RESCRIPT_BUNDLE_FLUIDAUDIO_CLI"],
];

function validateFluidAudioCli(source, key) {
  const result = spawnSync(source, ["transcribe", "--help"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
    input: "",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${key} must be a working fluidaudiocli binary from the pinned FluidAudio revision`
    );
  }
  const help = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const requiredFlags = [
    "--model-version",
    "--model-dir",
    "--output-json",
    "--language",
    "--no-mel-context",
  ];
  const missingFlags = requiredFlags.filter((flag) => !help.includes(flag));
  if (missingFlags.length > 0) {
    throw new Error(
      `${key} is not API-compatible with Rescript (missing ${missingFlags.join(", ")})`
    );
  }
}

mkdirSync(destination, { recursive: true });
const missing = [];
for (const [name, key] of tools) {
  const source = process.env[key];
  if (!source) {
    missing.push(key);
    continue;
  }
  const metadata = statSync(source);
  if (!metadata.isFile()) throw new Error(`${key} must point to a file`);
  if (name === "fluidaudiocli") validateFluidAudioCli(source, key);
  const target = join(destination, name);
  copyFileSync(source, target);
  chmodSync(target, 0o755);
  console.log(`Staged ${name}: ${source}`);
}

if (missing.length > 0) {
  const message = `Native tools not staged: ${missing.join(", ")}`;
  if (!optional) {
    console.error(message);
    console.error(
      "Release packaging requires redistributable FFmpeg, ffprobe, whisper-cli, and fluidaudiocli binaries."
    );
    process.exit(1);
  }
  console.warn(`${message}. Debug app will use configured/Homebrew/PATH tools.`);
}
