# Rescript Tauri Rewrite

## Objective

Preserve the existing static web app while delivering a Tauri 2 Studio app for macOS and iOS first. React owns presentation; Effect owns platform-neutral workflows and service boundaries; native code owns media, PCM, models, files, and long-running jobs.

## Architecture

```text
React Studio UI
  ├─ Zustand editor view/history state
  ├─ @rescript/core
  │    schemas · edit math · editor commands · typed errors/services
  ├─ @rescript/workflows
  │    projects · optimistic save · playback · jobs · reconnect
  └─ @rescript/platform-tauri
       invoke/event adapters; opaque file and playback references
                         │
                    Tauri commands
                         │
  ┌──────────────────────┴────────────────────────────┐
  │ ProjectStore                                      │
  │ projects/<uuid>/manifest.json + media + derived   │
  │ atomic writes · backups · expected revisions      │
  ├───────────────────────────────────────────────────┤
  │ macOS: FFmpeg/ffprobe + whisper-cli + FluidAudio  │
  │ iOS: AVFoundation + WhisperKit/FluidAudio +       │
  │      SpeakerKit                                   │
  └───────────────────────────────────────────────────┘
```

Full source media and PCM stay native. IPC carries manifests, opaque references, 100 Hz waveform peaks, timed words, keep ranges, progress, and final results.

## Workspace

- `apps/web` — preserved Next.js browser client
- `apps/studio` — Vite/React Tauri client and responsive editor
- `packages/core` — domain schemas, commands, edit math, service contracts
- `packages/workflows` — Effect workflows and reconnectable jobs
- `packages/platform-web` — browser repositories, files, playback, preferences
- `packages/platform-tauri` — Tauri repositories, files, jobs, playback, models

## Completed milestones

1. **Workspace migration**
   - npm workspaces and shared TypeScript configuration
   - original web app moved intact to `apps/web`
   - deployment and asset paths updated

2. **Shared Effect domain**
   - versioned project, word, range, model, progress, and result schemas
   - platform-neutral editor commands and range math
   - project, file, media, transcription, model, playback, and preferences services
   - browser and native service layers

3. **Tauri Apple shell**
   - responsive macOS/iPhone app, native dialogs, icons, capabilities
   - rustup-aware Tauri command wrapper
   - generated iOS Xcode project and simulator builds

4. **Native projects and file authority**
   - UUID project directories and immutable copied source media
   - strict path/timing/order/ID validation
   - optimistic revisions, atomic temporary/backup saves, safe deletion
   - one-use opaque import/export tokens created only by native dialogs

5. **Native media pipeline**
   - desktop FFmpeg/ffprobe preparation and export
   - iOS AVFoundation preparation and export
   - project-local 16 kHz WAV, 100 Hz waveform, ordered keep-range rendering
   - progress, cancellation, journals, background leases, restart recovery
   - portrait-video transform preservation and rollback-safe replacement

6. **Native transcription and diarization**
   - desktop verified GGML Base/Small model management and `whisper-cli`
   - desktop Parakeet v2/v3 through the bundled FluidAudio CLI
   - iOS WhisperKit 1.0.0 plus pinned FluidAudio Core ML transcription and model management
   - iOS SpeakerKit/Pyannote speaker assignment
   - word timestamps, progress, cancellation, journals, and recovery

7. **Complete Studio editor**
   - cut/restore/correct words, speaker assignment, filler removal
   - undo/redo and serialized revision-safe autosave
   - playback cut skipping and active-word synchronization
   - reduced-waveform timeline, zoom, timing handles, split/join, clip cut/trim
   - native transcript import and export destination flow
   - responsive macOS/iPhone layouts and touch action sheet
   - durable job bookmarks and snapshot/listener race recovery

8. **Packaging and verification**
   - release packaging requires explicitly supplied redistributable native tools
   - headless-safe macOS DMG builder
   - complete arm64 iOS simulator bundle
   - shared TypeScript, Vitest, Rust test, formatting, lint, Studio Vite, macOS, and iOS verification commands

## Storage layout

```text
app-data/
  projects/<uuid>/
    manifest.json
    manifest.json.bak
    media/<immutable-source>
    derived/media/audio-16k.wav
    derived/media/waveform.json
  jobs/*.json
  transcription-jobs/*.json
  models/
```

A project manifest stores schema version, revision, media reference, duration, model choice, words, manual cuts, scene boundaries, deleted-word visibility, and timestamps.

## Offline and model behavior

- Source media and transcript content never require a network request.
- First-use model downloads come from pinned Hugging Face repository revisions.
- Downloaded files are cached under app-controlled storage.
- Subsequent preparation, transcription, editing, playback, and export work offline.
- Desktop release packages must stage redistributable FFmpeg, ffprobe, whisper-cli, and fluidaudiocli binaries; debug builds may use configured/Homebrew/PATH tools.

## Remaining future work

- Windows/Linux FFmpeg and transcription packaging
- Android media/transcription plugins
- Language selection and local air-gapped model import UI
- Multi-clip projects, clip reordering, inserted gaps/silence, caption burn-in
- Notarization, signing, App Store metadata, and release automation
