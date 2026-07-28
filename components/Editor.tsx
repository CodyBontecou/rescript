"use client";

import { useEffect, useRef } from "react";
import { useEditorStore } from "@/lib/store";
import { extractAudio, getFFmpeg } from "@/lib/ffmpeg";
import { useTranscriber } from "@/hooks/useTranscriber";
import TopBar from "./TopBar";
import UploadScreen from "./UploadScreen";
import TranscriptPanel from "./TranscriptPanel";
import MediaPreview from "./MediaPreview";
import Timeline from "./Timeline";
import ExportDialog from "./ExportDialog";

export default function Editor() {
  const status = useEditorStore((s) => s.status);
  const videoFile = useEditorStore((s) => s.videoFile);
  const skipTranscription = useEditorStore((s) => s.skipTranscription);
  const loadVideo = useEditorStore((s) => s.loadVideo);
  const { transcribe } = useTranscriber();

  // Processing pipeline: load ffmpeg -> extract audio -> (maybe) transcribe.
  // Restored projects already have words; they only need PCM for the waveform.
  const startedFor = useRef<File | null>(null);
  useEffect(() => {
    if (!videoFile || startedFor.current === videoFile) return;
    startedFor.current = videoFile;
    const restoreOnly = useEditorStore.getState().skipTranscription;
    (async () => {
      const s = useEditorStore.getState();
      try {
        s.setProgress({ message: "Loading media engine…", value: null });
        await getFFmpeg();
        s.setProgress({ message: "Extracting audio…", value: null });
        const audio = await extractAudio(videoFile);
        s.setAudio(audio);
        if (restoreOnly) {
          s.setStatus("ready");
          s.setProgress({ message: "", value: null });
        } else {
          transcribe(audio, audio.length / 16000);
        }
      } catch (err) {
        console.error("Processing pipeline failed:", err);
        s.setError(err instanceof Error ? err.message : "Failed to process this file.");
      }
    })();
  }, [videoFile, skipTranscription, transcribe]);

  // Global shortcuts: space = play/pause, ⌘Z / ⇧⌘Z = undo / redo, S = split.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
        return;
      const s = useEditorStore.getState();
      if (e.code === "Space" && s.videoEl && !s.exportOpen) {
        e.preventDefault();
        if (s.videoEl.paused) void s.videoEl.play();
        else s.videoEl.pause();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
      } else if (
        e.key.toLowerCase() === "s" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        s.status === "ready" &&
        !s.exportOpen
      ) {
        e.preventDefault();
        s.splitAtPlayhead();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Flush pending autosave when the tab hides or unloads.
  useEffect(() => {
    const flush = () => {
      void import("@/lib/autosave").then((m) => m.flushProjectAutosave());
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-zinc-50 text-zinc-900">
      {status === "idle" ? (
        <UploadScreen onFile={loadVideo} />
      ) : (
        <>
          <TopBar />
          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            <div className="order-1 flex h-[34vh] shrink-0 flex-col border-b border-zinc-200 lg:order-2 lg:h-auto lg:w-[44%] lg:min-w-[320px] lg:border-b-0 lg:border-l">
              <MediaPreview />
            </div>
            <div className="order-2 flex min-h-0 flex-1 lg:order-1">
              <TranscriptPanel />
            </div>
            {/* <SideRail /> — hidden until the tools it exposes are functional */}
          </div>
          <Timeline />
        </>
      )}
      <ExportDialog />
    </div>
  );
}
