import { useEffect } from "react";
import { flushProjectAutosave } from "../editor/autosave";
import { useEditorStore } from "../editor/store";
import ExportDialog from "./ExportDialog";
import MediaPreview from "./MediaPreview";
import Timeline from "./Timeline";
import TopBar from "./TopBar";
import TranscriptPanel from "./TranscriptPanel";

const NON_TYPING_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (
    target.isContentEditable ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  ) {
    return true;
  }
  if (target.tagName !== "INPUT") return false;
  return !NON_TYPING_INPUT_TYPES.has(
    (target.getAttribute("type") ?? "text").toLowerCase()
  );
}

export default function EditorShell({
  onHome,
  onImportTranscript,
  onTranscribe,
  onExport,
}: {
  onHome: () => void;
  onImportTranscript: () => void;
  onTranscribe: () => void;
  onExport: () => Promise<void>;
}) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const state = useEditorStore.getState();
      if (event.code === "Space" && state.mediaEl && !state.exportOpen) {
        event.preventDefault();
        if (state.mediaEl.paused) void state.mediaEl.play();
        else state.mediaEl.pause();
      } else if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "z"
      ) {
        event.preventDefault();
        if (event.shiftKey) state.redo();
        else state.undo();
      } else if (
        event.key.toLowerCase() === "s" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        state.status === "ready" &&
        !state.exportOpen
      ) {
        event.preventDefault();
        state.splitAtPlayhead();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    const flush = () => {
      void flushProjectAutosave().catch(() => undefined);
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  return (
    <div className="editor-shell">
      <TopBar
        onHome={onHome}
        onExport={() => useEditorStore.getState().setExportOpen(true)}
        onTranscribe={onTranscribe}
      />
      <div className="editor-workspace">
        <div className="editor-media-pane"><MediaPreview /></div>
        <div className="editor-transcript-pane">
          <TranscriptPanel
            onImportTranscript={onImportTranscript}
            onTranscribe={onTranscribe}
          />
        </div>
      </div>
      <Timeline />
      <ExportDialog onStart={onExport} />
    </div>
  );
}
