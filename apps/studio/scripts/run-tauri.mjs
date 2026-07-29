import { delimiter, dirname } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Prefer rustup's toolchain over a system/Homebrew Rust. Mobile standard
 * libraries are installed by rustup and must match the rustc used by Tauri.
 */
function rustupBinDirectory() {
  const result = spawnSync("rustup", ["which", "cargo"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const cargo = result.stdout.trim();
  return cargo ? dirname(cargo) : null;
}

const rustupBin = rustupBinDirectory();
const env = { ...process.env };
if (rustupBin) env.PATH = `${rustupBin}${delimiter}${env.PATH ?? ""}`;

const result = spawnSync("tauri", process.argv.slice(2), {
  env,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
