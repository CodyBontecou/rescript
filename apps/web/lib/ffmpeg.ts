"use client";

import type { FFmpeg } from "@ffmpeg/ffmpeg";
import type { TimeRange } from "./types";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const CORE_BASE = `${BASE_PATH}/vendor/ffmpeg`;
const INPUT_NAME = "input_video";

let ffmpegPromise: Promise<FFmpeg> | null = null;
let writtenFor: File | null = null;

/** Lazily load a singleton multi-threaded ffmpeg.wasm instance. */
export async function getFFmpeg(): Promise<FFmpeg> {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const [{ FFmpeg }, { toBlobURL }] = await Promise.all([
        import("@ffmpeg/ffmpeg"),
        import("@ffmpeg/util"),
      ]);
      // Multi-threaded ffmpeg.wasm needs SharedArrayBuffer, i.e. a
      // cross-origin-isolated page (real COOP/COEP headers, or the COI service
      // worker after its reload). Without it the core throws a bare
      // "SharedArrayBuffer is not defined" from deep inside the worker.
      if (!self.crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
        throw new Error(
          "The media engine isn't ready yet — reload the page and try again."
        );
      }
      const ffmpeg = new FFmpeg();
      await ffmpeg.load({
        coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
        workerURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.worker.js`, "text/javascript"),
        // Served same-origin (copied on postinstall): the bundled class worker
        // contains a dynamic import() that Next's bundler cannot handle.
        classWorkerURL: new URL(`${BASE_PATH}/vendor/ffmpeg-class/worker.js`, location.href)
          .href,
      });
      return ffmpeg;
    })();
    ffmpegPromise.catch(() => {
      ffmpegPromise = null;
    });
  }
  return ffmpegPromise;
}

async function ensureInput(ffmpeg: FFmpeg, file: File): Promise<string> {
  if (writtenFor !== file) {
    const { fetchFile } = await import("@ffmpeg/util");
    await ffmpeg.writeFile(INPUT_NAME, await fetchFile(file));
    writtenFor = file;
  }
  return INPUT_NAME;
}

/**
 * Extract the audio track as mono 16 kHz float PCM — the exact format
 * Whisper expects, and what we render the timeline waveform from.
 * Works for both video and audio-only files.
 */
export async function extractAudio(file: File): Promise<Float32Array> {
  const ffmpeg = await getFFmpeg();
  const input = await ensureInput(ffmpeg, file);
  const out = "audio.pcm";
  const code = await ffmpeg.exec([
    "-i", input,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-f", "f32le",
    "-y", out,
  ]);
  if (code !== 0) {
    throw new Error("Could not extract audio from this file.");
  }
  const data = (await ffmpeg.readFile(out)) as Uint8Array;
  await ffmpeg.deleteFile(out);
  if (data.byteLength < 4) {
    throw new Error("This file appears to have no audio track.");
  }
  // Copy into a fresh buffer so byteOffset/alignment is clean.
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return new Float32Array(buf as ArrayBuffer);
}

/**
 * Render the edited video: keep only `keepRanges` of the original media and
 * concatenate them. Re-encodes so cuts land exactly on word boundaries
 * rather than keyframes.
 */
export async function exportVideo(
  file: File,
  keepRanges: TimeRange[],
  editedDuration: number,
  onProgress: (ratio: number) => void
): Promise<Blob> {
  if (keepRanges.length === 0) {
    throw new Error("Everything has been deleted — nothing to export.");
  }
  const ffmpeg = await getFFmpeg();
  const input = await ensureInput(ffmpeg, file);
  const out = "output.mp4";

  const parts: string[] = [];
  const labels: string[] = [];
  keepRanges.forEach((r, i) => {
    const s = r.start.toFixed(3);
    const e = r.end.toFixed(3);
    parts.push(`[0:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS[v${i}]`);
    parts.push(`[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[a${i}]`);
    labels.push(`[v${i}][a${i}]`);
  });
  const filter =
    parts.join(";") +
    `;${labels.join("")}concat=n=${keepRanges.length}:v=1:a=1[outv][outa]`;

  const progressHandler = ({ time }: { progress: number; time: number }) => {
    // `time` is the output timestamp in microseconds.
    const ratio = Math.min(1, time / 1e6 / Math.max(0.001, editedDuration));
    onProgress(Math.max(0, ratio));
  };
  ffmpeg.on("progress", progressHandler);
  try {
    const code = await ffmpeg.exec([
      "-i", input,
      "-filter_complex", filter,
      "-map", "[outv]",
      "-map", "[outa]",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "22",
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      "-y", out,
    ]);
    if (code !== 0) throw new Error("Export failed while rendering the video.");
    const data = (await ffmpeg.readFile(out)) as Uint8Array;
    await ffmpeg.deleteFile(out);
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    return new Blob([buf as ArrayBuffer], { type: "video/mp4" });
  } finally {
    ffmpeg.off("progress", progressHandler);
  }
}

/**
 * Render an edited audio-only file: keep only `keepRanges` and concatenate
 * them into an M4A (AAC) container.
 */
export async function exportAudio(
  file: File,
  keepRanges: TimeRange[],
  editedDuration: number,
  onProgress: (ratio: number) => void
): Promise<Blob> {
  if (keepRanges.length === 0) {
    throw new Error("Everything has been deleted — nothing to export.");
  }
  const ffmpeg = await getFFmpeg();
  const input = await ensureInput(ffmpeg, file);
  const out = "output.m4a";

  const parts: string[] = [];
  const labels: string[] = [];
  keepRanges.forEach((r, i) => {
    const s = r.start.toFixed(3);
    const e = r.end.toFixed(3);
    parts.push(`[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[a${i}]`);
    labels.push(`[a${i}]`);
  });
  const filter =
    parts.join(";") +
    `;${labels.join("")}concat=n=${keepRanges.length}:v=0:a=1[outa]`;

  const progressHandler = ({ time }: { progress: number; time: number }) => {
    const ratio = Math.min(1, time / 1e6 / Math.max(0.001, editedDuration));
    onProgress(Math.max(0, ratio));
  };
  ffmpeg.on("progress", progressHandler);
  try {
    const code = await ffmpeg.exec([
      "-i", input,
      "-filter_complex", filter,
      "-map", "[outa]",
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      "-y", out,
    ]);
    if (code !== 0) throw new Error("Export failed while rendering the audio.");
    const data = (await ffmpeg.readFile(out)) as Uint8Array;
    await ffmpeg.deleteFile(out);
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    return new Blob([buf as ArrayBuffer], { type: "audio/mp4" });
  } finally {
    ffmpeg.off("progress", progressHandler);
  }
}
