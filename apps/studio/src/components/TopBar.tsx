import type { TranscriptionModel } from "@rescript/core";
import {
  AudioLines,
  ChevronLeft,
  Download,
  Redo2,
  RotateCw,
  Square,
  Undo2,
} from "lucide-react";
import { useEditorStore } from "../editor/store";
import { retryProjectAutosave } from "../editor/autosave";

export default function TopBar({
  onHome,
  onExport,
  onTranscribe,
}: {
  onHome: () => void;
  onExport: () => void;
  onTranscribe: () => void;
}) {
  const manifest = useEditorStore((state) => state.manifest);
  const model = useEditorStore((state) => state.model);
  const setModel = useEditorStore((state) => state.setModel);
  const status = useEditorStore((state) => state.status);
  const progress = useEditorStore((state) => state.progress);
  const cancelJob = useEditorStore((state) => state.cancelJob);
  const saveStatus = useEditorStore((state) => state.saveStatus);
  const saveError = useEditorStore((state) => state.saveError);
  const canUndo = useEditorStore((state) => state.past.length > 0);
  const canRedo = useEditorStore((state) => state.future.length > 0);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);

  const busy =
    status === "preparing" || status === "transcribing" || status === "exporting";

  return (
    <header className="editor-topbar" data-tauri-drag-region>
      <button
        type="button"
        onClick={onHome}
        title="Projects"
        className="editor-icon-button"
      >
        <ChevronLeft size={18} />
      </button>
      <span className="editor-brand-mark">R</span>
      <div className="editor-title" data-tauri-drag-region>
        <strong>{manifest?.name ?? "Rescript"}</strong>
        <small>
          {saveStatus === "saving"
            ? "Saving…"
            : saveStatus === "dirty"
              ? "Unsaved edits"
              : saveStatus === "error"
                ? "Save failed"
                : "Saved locally"}
        </small>
      </div>

      <div className="editor-topbar-center">
        <select
          value={model}
          onChange={(event) =>
            setModel(event.target.value as TranscriptionModel)
          }
          disabled={busy}
          aria-label="Offline transcription model"
          className="editor-model-select"
        >
          <option value="parakeet-v2">Parakeet v2 · English · Default</option>
          <option value="parakeet-v3">Parakeet v3 · Multilingual</option>
          <option value="base">Whisper Base</option>
          <option value="small">Whisper Small</option>
        </select>
        <button
          type="button"
          onClick={onTranscribe}
          disabled={busy}
          className="editor-text-button"
          title="Replace the transcript with an on-device transcription"
        >
          <AudioLines size={15} />
          <span>Transcribe</span>
        </button>
      </div>

      <div className="editor-topbar-actions">
        {saveStatus === "error" ? (
          <button
            type="button"
            onClick={() => void retryProjectAutosave()}
            className="editor-icon-button save-error-button"
            title={saveError ?? "Retry save"}
          >
            <RotateCw size={16} />
          </button>
        ) : null}
        {busy && cancelJob ? (
          <button
            type="button"
            onClick={() => void cancelJob()}
            className="editor-text-button cancel-button"
            title="Cancel native job"
          >
            <Square size={13} fill="currentColor" />
            <span className="hide-compact">{progress?.message ?? "Cancel"}</span>
          </button>
        ) : null}
        <button
          type="button"
          onClick={undo}
          disabled={!canUndo || busy}
          title="Undo (⌘Z)"
          className="editor-icon-button"
        >
          <Undo2 size={17} />
        </button>
        <button
          type="button"
          onClick={redo}
          disabled={!canRedo || busy}
          title="Redo (⇧⌘Z)"
          className="editor-icon-button"
        >
          <Redo2 size={17} />
        </button>
        <button
          type="button"
          onClick={onExport}
          disabled={status !== "ready"}
          className="editor-export-button"
        >
          <Download size={15} />
          <span>Export</span>
        </button>
      </div>
    </header>
  );
}
