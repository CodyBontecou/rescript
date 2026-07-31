import { useMemo } from "react";
import {
  Check,
  Download,
  Infinity as InfinityIcon,
  RotateCcw,
  ShieldCheck,
  Square,
  X,
} from "lucide-react";
import { formatTime, getCutRanges, getEditedDuration } from "@rescript/core/edits";
import { useEditorStore } from "../editor/store";
import type { ExportEntitlementState } from "../export-entitlement";

type ExportDialogProps = {
  onStart: () => Promise<void>;
  entitlement: ExportEntitlementState;
  accessChecking: boolean;
  paywallOpen: boolean;
  purchaseBusy: boolean;
  purchaseError: string | null;
  purchaseMessage: string | null;
  onPurchase: () => void;
  onRestorePurchase: () => void;
  onRetryExportAccess: () => void;
  onDismiss: () => void;
};

export default function ExportDialog({
  onStart,
  entitlement,
  accessChecking,
  paywallOpen,
  purchaseBusy,
  purchaseError,
  purchaseMessage,
  onPurchase,
  onRestorePurchase,
  onRetryExportAccess,
  onDismiss,
}: ExportDialogProps) {
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
  const closeDisabled = exporting || purchaseBusy;
  const price = entitlement.displayPrice ?? "$9.99";

  const close = () => {
    if (closeDisabled) return;
    setOpen(false);
    onDismiss();
  };

  if (!open || !manifest) return null;

  return (
    <div className="export-backdrop" onClick={close}>
      <section
        className={`export-dialog${paywallOpen ? " export-dialog-paywall" : ""}`}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-dialog-title"
      >
        <div className="export-heading">
          <div>
            <p className="eyebrow">{paywallOpen ? "ONE-TIME PURCHASE" : "NATIVE EXPORT"}</p>
            <h2 id="export-dialog-title">
              {paywallOpen ? "Unlock unlimited exports" : `Export ${manifest.media.mediaKind}`}
            </h2>
          </div>
          <button
            type="button"
            onClick={close}
            disabled={closeDisabled}
            className="editor-icon-button"
            aria-label="Close export dialog"
          >
            <X size={17} />
          </button>
        </div>

        {paywallOpen ? (
          <div className="export-paywall">
            <div className="export-paywall-mark" aria-hidden="true">
              <InfinityIcon size={28} />
            </div>
            <p className="export-paywall-lede">
              Edit and transcribe for free. Unlock this export and every future export with one purchase.
            </p>
            <div className="export-paywall-benefits">
              <span><Check size={15} /> Unlimited video and audio exports</span>
              <span><Check size={15} /> No subscription or recurring charge</span>
              <span><ShieldCheck size={15} /> Purchase verified securely by Apple</span>
            </div>

            {purchaseError ? <p className="dialog-error" role="alert">{purchaseError}</p> : null}
            {purchaseMessage ? (
              <p className="dialog-info" aria-live="polite">{purchaseMessage}</p>
            ) : null}
            {!entitlement.canPurchase && !accessChecking ? (
              <p className="dialog-info">
                Unlimited Exports is not available from the App Store right now. You can retry or restore an existing purchase.
              </p>
            ) : null}

            <button
              type="button"
              onClick={onPurchase}
              disabled={purchaseBusy || accessChecking || !entitlement.canPurchase}
              className="dialog-primary-button export-purchase-button"
            >
              {purchaseBusy
                ? "Completing App Store purchase…"
                : accessChecking
                  ? "Checking App Store…"
                  : `Unlock for ${price}`}
            </button>
            <button
              type="button"
              onClick={onRestorePurchase}
              disabled={purchaseBusy || accessChecking}
              className="dialog-secondary-button"
            >
              <RotateCcw size={14} /> Restore Purchase
            </button>
            {!entitlement.canPurchase ? (
              <button
                type="button"
                onClick={onRetryExportAccess}
                disabled={purchaseBusy || accessChecking}
                className="export-paywall-link"
              >
                {accessChecking ? "Checking…" : "Retry App Store"}
              </button>
            ) : null}
            <small className="export-paywall-fineprint">
              Payment is charged to your Apple ID. The displayed App Store price is a one-time charge.
            </small>
          </div>
        ) : (
          <>
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
                <button
                  type="button"
                  onClick={() => void onStart()}
                  disabled={accessChecking}
                  className="dialog-secondary-button"
                >
                  {accessChecking ? "Checking access…" : "Export latest edits again"}
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
                  disabled={editedDuration <= 0.001 || accessChecking}
                  className="dialog-primary-button"
                >
                  <Download size={16} />
                  {accessChecking ? "Checking export access…" : "Choose destination and export"}
                </button>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
