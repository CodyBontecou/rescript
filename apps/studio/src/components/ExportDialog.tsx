import { useMemo } from "react";
import { Check, Download, Square, X } from "lucide-react";
import { formatTime, getCutRanges, getEditedDuration } from "@rescript/core/edits";
import { useEditorStore } from "../editor/store";

export default function ExportDialog({
  onStart,
}: {
  onStart: () => Promise<void>;
}) {
  const open = useEditorStore((state) => state.exportOpen);
  const setOpen = useEditorStore((state) => state.setExportOpen);
  const manifest = useEditorStore((state) => state.manifest);
  const words = useEditorStore((state) => state.words);
  const manualCuts = useEditorStore((state) => state.manualCuts);
  const duration = useEditorStore((state) => state.duration);
  const status = useEditorStore((state) => state.status);
  const progress = useEditorStore((state) => state.progress);
  const error = useEditorStore((state) => state.error);
  const result = useEditorStore((state) => state.exportResult);
  const cancelJob = useEditorStore((state) => state.cancelJob);

  const cuts = useMemo(
    () => getCutRanges(words, duration, manualCuts),
    [words, duration, manualCuts]
  );
  const editedDuration = useMemo(
    () => getEditedDuration(cuts, duration),
    [cuts, duration]
  );
  const exporting = status === "exporting";
  if (!open || !manifest) return null;

  return (
    <div
      className="export-backdrop"
      onClick={() => {
        if (!exporting) setOpen(false);
      }}
    >
      <section className="export-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="export-heading">
          <div>
            <p className="eyebrow">NATIVE EXPORT</p>
            <h2>Export {manifest.media.mediaKind}</h2>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            disabled={exporting}
            className="editor-icon-button"
            aria-label="Close export dialog"
          >
            <X size={17} />
          </button>
        </div>

        <div className="export-stats">
          <div><small>Original</small><strong>{formatTime(duration)}</strong></div>
          <div><small>Cuts</small><strong>{cuts.length}</strong></div>
          <div><small>Edited</small><strong>{formatTime(editedDuration)}</strong></div>
        </div>

        {error ? <p className="dialog-error">{error}</p> : null}

        {exporting ? (
          <div className="export-progress">
            <div>
              <strong>{progress?.message ?? "Rendering on device…"}</strong>
              <span>{Math.round((progress?.ratio ?? 0) * 100)}%</span>
            </div>
            <div className="progress-track">
              <span style={{ width: `${(progress?.ratio ?? 0) * 100}%` }} />
            </div>
            <button
              type="button"
              onClick={() => void cancelJob?.()}
              className="dialog-secondary-button"
            >
              <Square size={13} fill="currentColor" /> Cancel export
            </button>
          </div>
        ) : result ? (
          <div className="export-complete">
            <Check size={22} />
            <div>
              <strong>Export complete</strong>
              <p>{(result.byteLength / 1_000_000).toFixed(1)} MB written to the selected destination.</p>
            </div>
            <button type="button" onClick={() => void onStart()} className="dialog-secondary-button">
              Export latest edits again
            </button>
          </div>
        ) : (
          <>
            <p className="export-note">
              The source stays in native project storage. Only ordered keep ranges are sent to the media job.
            </p>
            <button
              type="button"
              onClick={() => void onStart()}
              disabled={editedDuration <= 0.001}
              className="dialog-primary-button"
            >
              <Download size={16} /> Choose destination and export
            </button>
          </>
        )}
      </section>
    </div>
  );
}
