# Rescript — Build Plan

Rescript is a fully offline, open-source, transcript-based video editor: upload a
video, get a speaker-labelled transcript synced to the timeline, delete words to
cut the corresponding clip out of the video, and export the result — all in the
browser, with no server, no auth, and no API calls.

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ Next.js (App Router, client-only editor)                           │
│                                                                    │
│  ┌───────────────┐  ┌────────────────┐  ┌───────────────────────┐  │
│  │ TranscriptPanel│  │ MediaPreview  │  │ Timeline (canvas)     │  │
│  │ words / cuts   │  │ skip playback │  │ waveform + playhead   │  │
│  └───────┬───────┘  └───────┬────────┘  └──────────┬────────────┘  │
│          └───────────── zustand store ─────────────┘               │
│                     (words, cuts, playback, status)                │
│                                                                    │
│  ┌──────────────────────────┐   ┌───────────────────────────────┐  │
│  │ Web Worker                │   │ ffmpeg.wasm (multi-threaded)  │  │
│  │ parakeet.js / transformers│   │ - audio extraction (16k PCM)  │  │
│  │ - ASR (word timing)       │   │ - export: trim+concat+encode  │  │
│  │ - pyannote (diarization)  │   └───────────────────────────────┘  │
│  └──────────────────────────┘                                       │
└────────────────────────────────────────────────────────────────────┘
```

### Data model

The single source of truth is the word list:

```ts
interface Word {
  id: number;
  text: string;
  start: number;   // seconds, original media time
  end: number;
  speaker: number; // sequential speaker index
  deleted: boolean;
}
```

Everything else is derived:

- **Cut ranges** — runs of consecutive deleted words merged into time ranges
  (including the silence between adjacent deleted words).
- **Keep ranges** — the inverse of cut ranges over `[0, duration]`; drives both
  preview playback and export.
- **Edited duration / time mapping** — for the player clock and export summary.

### Pipeline (all local)

1. **Upload** — a single video file; object URL feeds the `<video>` preview
   immediately.
2. **Audio extraction** — ffmpeg.wasm decodes the audio track to mono 16 kHz
   `f32le` PCM (used by both ASR engines and to draw the waveform).
3. **Transcription** — a Web Worker runs Parakeet TDT 0.6B v2 via parakeet.js
   by default, with Whisper Base/Small via transformers.js still selectable.
   Both paths produce word timestamps and stream partial text/progress back to
   the UI. WebGPU is used when available, with a WASM fallback.
4. **Diarization** — the same worker runs
   `onnx-community/pyannote-segmentation-3.0` and assigns each word the speaker
   whose segment contains the word's midpoint (nearest segment as fallback).
   Diarization failure degrades gracefully to a single speaker.
5. **Editing** — selecting words and pressing ⌫ (or the floating Cut button)
   marks them deleted; preview playback skips cut ranges in real time; undo/redo
   snapshots the word list.
6. **Export** — ffmpeg.wasm builds a `trim`/`atrim` + `concat` filter graph from
   the keep ranges and re-encodes to MP4 (`libx264` + `aac`), so cuts land
   exactly on word boundaries rather than keyframes.

### Offline strategy

- **No server code at all** — the Next.js app is a static client bundle; there
  is no API route, no auth, no telemetry.
- **WASM binaries served same-origin** — `postinstall` copies `@ffmpeg/core-mt`
  and the matching transformers.js/parakeet.js ONNX Runtime files into
  `public/vendor/` (no CDN at runtime).
- **Models** — fetched from the Hugging Face Hub on *first* use only (Parakeet
  v2 is ~1.3 GB with WebGPU weights; Whisper Base/Small remain smaller options)
  and cached in browser storage; subsequent runs work fully disconnected.
- **COOP/COEP headers** enable `SharedArrayBuffer` for multi-threaded ffmpeg and
  ONNX inference.

## Milestones

1. ✅ Scaffold Next.js (App Router, TypeScript, Tailwind), COOP/COEP headers,
   local WASM asset pipeline.
2. ✅ Media ingest: upload screen, ffmpeg singleton, audio extraction.
3. ✅ Transcription worker: Parakeet/Whisper word timestamps + pyannote
   diarization, streamed progress/partial text.
4. ✅ Editor UI: transcript panel (left), video preview (right), timeline with
   waveform, ruler, word labels, playhead, zoom (bottom).
5. ✅ Editing core: word selection → cut/restore, undo/redo, playback that
   skips cuts, show/hide deleted words.
6. ✅ Export: keep-range concat render to MP4 with progress, download.
7. ✅ Flexible timeline editing: word-boundary drag, Split at playhead
   (scene boundaries), clip trim handles, manual cuts merged into export.

## Future work

- Language selection UI, more ASR variants, and local model import for
  air-gapped first runs.
- Smarter export: stream-copy for keyframe-aligned segments, WebCodecs-based
  rendering for speed.
- Multi-clip projects (reorder scenes), captions burn-in.
- Gap clips / insert silence between words.
