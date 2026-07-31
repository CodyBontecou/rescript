<p align="center">
  <img src="./screenshots/logo.png" alt="Rescript logo" width="96" />
</p>

# Rescript

**Edit audio and video like text, privately and on-device.**

Rescript is an open-source transcript-based media editor. Delete words to cut the matching media, correct text, assign speakers, split and trim clips on the timeline, preview the edit, and export the final cut.

This repository now contains two clients:

- **Rescript Studio** — a Tauri 2 desktop/mobile app targeting macOS and iOS first.
- **Rescript Web** — the original static Next.js app, still available at [wassgha.github.io/rescript](https://wassgha.github.io/rescript/).

## Studio features

- File-backed, versioned native projects with atomic saves and optimistic revisions
- Word cut/restore/correction, speaker assignment, filler removal, undo/redo
- Scene splits, explicit joins, clip deletion, edge trims, word timing handles, zoom
- Playback synchronized to the transcript and automatically skipping cut ranges
- Native media preparation and export with progress, cancellation, journals, and recovery
- Native offline transcription with Parakeet v2 (the default), Parakeet v3, and Whisper Base/Small
- Optional per-project speaker diarization with Pyannote (browser) and Argmax SpeakerKit/Pyannote (iOS)
- Responsive macOS and iPhone editor using the same React and Effect workflows
- Reduced waveform and word data over IPC; source media and PCM remain native

## Workspace

```text
apps/
  studio/              Vite + React + Tauri 2 app
  web/                 Original Next.js browser app
packages/
  core/                Schemas, edit math, commands, Effect service contracts
  workflows/           Project, autosave, playback, job, and reconnect workflows
  platform-tauri/      Native Tauri service adapters
  platform-web/        Browser IndexedDB/file/playback adapters
```

## Development

Requirements:

- Node.js 22 or newer and npm
- Rust stable through `rustup`
- macOS 14+ Studio: FFmpeg, ffprobe, `whisper-cli`, and a `fluidaudiocli` build from the pinned FluidAudio revision for local development
- iOS 17+ Studio: Xcode, an installed iOS simulator runtime, and Cocoa/Swift tooling used by Tauri

```bash
npm install
npm test
npm run typecheck
npm run build:studio
npm run dev:web
```

### Run Studio on macOS

```bash
# Optional development overrides
export RESCRIPT_FFMPEG=/path/to/ffmpeg
export RESCRIPT_FFPROBE=/path/to/ffprobe
export RESCRIPT_WHISPER_CLI=/path/to/whisper-cli
export RESCRIPT_FLUIDAUDIO_CLI=/path/to/fluidaudiocli
# Optional parent or exact v2 model directory
export RESCRIPT_PARAKEET_MODEL_DIR=/path/to/WhisperModels

npm run dev:studio
```

Without tool overrides, desktop development also checks `resources/bin`, Homebrew locations, and `PATH`. Parakeet model lookup checks Rescript's app cache, `RESCRIPT_PARAKEET_MODEL_DIR`, FluidAudio's standard cache, and Vox.md's `group.bontecou.Voxboard/WhisperModels` cache in that order. Shared caches are loaded in place and never removed by Rescript.

Build the matching Parakeet sidecar from the same FluidAudio revision used by iOS:

```bash
git clone https://github.com/FluidInference/FluidAudio.git /tmp/FluidAudio
git -C /tmp/FluidAudio checkout 88d6d8166880dee1ac7c32c80f8e10cd782f8ca8
swift build --package-path /tmp/FluidAudio -c release --product fluidaudiocli
export RESCRIPT_FLUIDAUDIO_CLI=/tmp/FluidAudio/.build/release/fluidaudiocli
```

### Build macOS packages

Release builds intentionally require redistributable native binaries so a broken external-tool-dependent package is not produced:

```bash
export RESCRIPT_BUNDLE_FFMPEG=/path/to/redistributable/ffmpeg
export RESCRIPT_BUNDLE_FFPROBE=/path/to/redistributable/ffprobe
export RESCRIPT_BUNDLE_WHISPER_CLI=/path/to/redistributable/whisper-cli
export RESCRIPT_BUNDLE_FLUIDAUDIO_CLI=/path/to/redistributable/fluidaudiocli
npm run build:macos
```

`build:macos` stages those tools, builds `Rescript.app`, and creates a headless-safe DMG with `hdiutil`. A local debug package may use external tools:

```bash
npm run tauri:build:macos --workspace @rescript/studio -- --debug
```

### Build iOS

```bash
# One-time generated Apple project setup
npm run tauri:ios:init --workspace @rescript/studio

# arm64 simulator bundle
npm run tauri --workspace @rescript/studio -- ios build --debug --target aarch64-sim --ci
```

The simulator app is written to:

```text
apps/studio/src-tauri/gen/apple/build/arm64-sim/Rescript.app
```

### Unlimited Exports purchase

Editing and transcription remain free. On iOS, export is unlocked by the StoreKit 2 non-consumable product `tech.isolated.rescript.unlimited_exports`. The paywall uses StoreKit's localized price, restores purchases through `AppStore.sync()`, and automatically continues the requested export after a verified purchase. Native AV export also checks the verified entitlement so the renderer cannot bypass the gate. Desktop builds remain unlocked.

`apps/studio/src-tauri/gen/apple/Rescript.storekit` supplies a local $9.99 test product to the shared debug scheme. Before shipping, create the matching non-consumable in App Store Connect, set its base price to USD 9.99, add localization and review metadata, and include it with the app version submitted for review.

## Native processing

### macOS

- FFmpeg/ffprobe decode project media into a project-local mono 16 kHz WAV and 100 Hz peak waveform.
- `fluidaudiocli` runs the default Parakeet v2 model (and optional v3) through FluidAudio/Core ML on Apple silicon, reusing compatible FluidAudio or Vox.md caches when present; `whisper-cli` remains available for verified GGML Base/Small models.
- FFmpeg exports ordered keep ranges to M4A or MP4.

### iOS

- AVFoundation prepares media and exports keep ranges without full media crossing IPC.
- [WhisperKit](https://github.com/argmaxinc/argmax-oss-swift) 1.0.0 handles Whisper; pinned [FluidAudio](https://github.com/FluidInference/FluidAudio) handles Parakeet v2/v3. Both produce word timestamps.
- SpeakerKit performs Pyannote diarization and assigns speaker IDs when **Identify speakers** is enabled for the project. Speaker attribution is best-effort and skipped for prepared WAVs over 120 MiB to control mobile memory use.

Missing transcription and speaker models download on first use, are cached under app-controlled storage, and can be used offline afterward. On macOS, compatible pre-existing Parakeet caches can be reused read-only. Media and transcript content are never uploaded.

## Project and security model

Projects live under the app data directory as `projects/<uuid>/` and contain an immutable copied source, derived native assets, and a schema-versioned `manifest.json`. New projects leave speaker diarization off by default; it can be enabled before import or changed per project before retranscribing. Existing projects retain the previous enabled behavior.

- Saves use expected revisions, temporary files, backups, and atomic replacement.
- Timings and IDs are finite, ordered, unique, and constrained to media duration.
- Import/export dialogs grant opaque, one-use native file tokens; renderer-provided arbitrary paths are rejected.
- Long-running jobs persist journals. A restarted app reconnects to completed jobs or reports interrupted jobs instead of pretending they are still running.
- The webview receives project references, reduced waveform peaks, words, results, and progress—not source bytes or PCM.

## Web app

The browser app remains a static, offline-capable Next.js client using Parakeet.js (v2 is the default), transformers.js for optional Whisper models, optional per-project pyannote ONNX diarization, IndexedDB, and ffmpeg.wasm.

```bash
npm run dev:web
npm run build:web
npm run lint --workspace @rescript/web
```

A Chromium-based browser is recommended because the web pipeline uses `SharedArrayBuffer`, WebGPU when available, and a WASM fallback.

## Platform status

| Platform | Status |
| --- | --- |
| macOS | Studio editor and native jobs implemented |
| iOS | Studio editor, AVFoundation, WhisperKit, and SpeakerKit implemented |
| Web | Existing static app preserved |
| Windows / Linux / Android | Service boundaries prepared; native engines and packaging remain future work |

## License

MIT

---

Originally built by [@wassgha](https://x.com/wassgha).
