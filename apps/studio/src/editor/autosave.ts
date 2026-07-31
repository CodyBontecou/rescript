import { Effect } from "effect";
import { saveProject, withEditorDocument } from "@rescript/workflows";
import { TauriPlatformLive } from "@rescript/platform-tauri";
import { currentDocument, useEditorStore } from "./store";

let timer: number | null = null;
let activeSave: Promise<void> | null = null;

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  if (cause && typeof cause === "object") {
    const record = cause as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
  }
  return "Unable to save this project";
}

async function saveUntilCurrent(): Promise<void> {
  while (true) {
    const state = useEditorStore.getState();
    const manifest = state.manifest;
    if (!manifest || state.savedGeneration >= state.dirtyGeneration) {
      if (manifest && state.saveStatus !== "error") {
        state.setSaveState("saved");
      }
      return;
    }

    const projectId = manifest.id;
    const generation = state.dirtyGeneration;
    const snapshot = {
      ...withEditorDocument(manifest, currentDocument(), state.showDeleted),
      speakerDiarizationEnabled: state.speakerDiarizationEnabled,
    };
    state.setSaveState("saving");

    try {
      const saved = await Effect.runPromise(
        saveProject(snapshot).pipe(Effect.provide(TauriPlatformLive))
      );
      const latest = useEditorStore.getState();
      if (latest.manifest?.id !== projectId) return;
      latest.acknowledgeSave(saved, generation);
    } catch (cause) {
      const latest = useEditorStore.getState();
      if (latest.manifest?.id === projectId) {
        latest.setSaveState("error", messageOf(cause));
      }
      throw cause;
    }
  }
}

function ensureSave(): Promise<void> {
  if (activeSave) return activeSave;
  activeSave = saveUntilCurrent().finally(() => {
    activeSave = null;
    const state = useEditorStore.getState();
    if (
      state.manifest &&
      state.saveStatus !== "error" &&
      state.savedGeneration < state.dirtyGeneration
    ) {
      void ensureSave();
    }
  });
  return activeSave;
}

export function scheduleProjectAutosave(delayMs = 500): void {
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    void ensureSave().catch(() => {
      // The editor surfaces the typed save error and keeps local changes intact.
    });
  }, delayMs);
}

export function flushProjectAutosave(): Promise<void> {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  return ensureSave();
}

export function retryProjectAutosave(): Promise<void> {
  useEditorStore.getState().setSaveState("dirty");
  return flushProjectAutosave();
}
