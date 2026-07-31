import { create } from "zustand";
import {
  applyEditorCommand,
  type EditorCommand,
} from "@rescript/core/commands";
import { scheduleProjectAutosave } from "./autosave";
import {
  DEFAULT_SPEAKER_DIARIZATION_ENABLED,
  DEFAULT_TRANSCRIPTION_MODEL,
  type EditSnapshot,
  type EditorDocument,
  type EditorStatus,
  type JobProgress,
  type MediaExportResult,
  type PlaybackSource,
  type PreparedMedia,
  type ProjectManifest,
  type TranscriptionModel,
  type Word,
} from "@rescript/core";

type SaveStatus = "saved" | "dirty" | "saving" | "error";

interface EditorState {
  manifest: ProjectManifest | null;
  preparedMedia: PreparedMedia | null;
  playback: PlaybackSource | null;
  model: TranscriptionModel;
  speakerDiarizationEnabled: boolean;

  duration: number;
  words: Word[];
  manualCuts: ProjectManifest["manualCuts"];
  sceneBoundaries: ProjectManifest["sceneBoundaries"];
  showDeleted: boolean;
  nextManualCutId: number;
  nextBoundaryId: number;
  past: EditSnapshot[];
  future: EditSnapshot[];
  gestureActive: boolean;
  selectedClipIndex: number | null;

  status: EditorStatus;
  progress: JobProgress | null;
  error: string | null;
  currentTime: number;
  playing: boolean;
  mediaEl: HTMLMediaElement | null;
  activeJobId: string | null;
  cancelJob: (() => Promise<void>) | null;

  dirtyGeneration: number;
  savedGeneration: number;
  saveStatus: SaveStatus;
  saveError: string | null;

  exportOpen: boolean;
  exportResult: MediaExportResult | null;

  loadProject: (
    manifest: ProjectManifest,
    options?: { preparedMedia?: PreparedMedia | null; playback?: PlaybackSource | null }
  ) => void;
  acknowledgeSave: (manifest: ProjectManifest, generation: number) => void;
  setSaveState: (status: SaveStatus, error?: string | null) => void;
  setPreparedMedia: (prepared: PreparedMedia | null) => void;
  setPlayback: (playback: PlaybackSource | null) => void;
  setModel: (model: TranscriptionModel) => void;
  setSpeakerDiarizationEnabled: (enabled: boolean) => void;
  replaceTranscript: (words: readonly Word[], model: TranscriptionModel | "import") => void;
  deleteWords: (ids: readonly number[]) => void;
  restoreWords: (ids: readonly number[]) => void;
  correctWords: (ids: readonly number[], text: string) => void;
  assignSpeaker: (ids: readonly number[], speaker: number) => void;
  adjustWordBounds: (id: number, start: number, end: number) => void;
  splitAtPlayhead: () => boolean;
  removeSceneBoundary: (id: number) => void;
  deleteClip: (clipIndex: number) => boolean;
  trimClipEdge: (clipIndex: number, edge: "in" | "out", time: number) => void;
  setSelectedClipIndex: (index: number | null) => void;
  beginGesture: () => void;
  endGesture: () => void;
  undo: () => void;
  redo: () => void;
  toggleShowDeleted: () => void;

  setStatus: (status: EditorStatus) => void;
  setProgress: (progress: JobProgress | null) => void;
  setError: (message: string | null) => void;
  setCurrentTime: (time: number) => void;
  setPlaying: (playing: boolean) => void;
  setMediaEl: (element: HTMLMediaElement | null) => void;
  setActiveJob: (
    jobId: string | null,
    cancel?: (() => Promise<void>) | null
  ) => void;
  setExportOpen: (open: boolean) => void;
  setExportResult: (result: MediaExportResult | null) => void;
  reset: () => void;
}

function maxId(items: readonly { id: number }[]): number {
  return items.reduce((maximum, item) => Math.max(maximum, item.id), 0) + 1;
}

function snapshotOf(state: Pick<EditorState, "words" | "manualCuts" | "sceneBoundaries">): EditSnapshot {
  return {
    words: state.words,
    manualCuts: state.manualCuts,
    sceneBoundaries: state.sceneBoundaries,
  };
}

function snapshotsEqual(left: EditSnapshot, right: EditSnapshot): boolean {
  return (
    left.words === right.words &&
    left.manualCuts === right.manualCuts &&
    left.sceneBoundaries === right.sceneBoundaries
  );
}

function documentOf(state: EditorState): EditorDocument {
  return {
    duration: state.duration,
    words: state.words,
    manualCuts: state.manualCuts,
    sceneBoundaries: state.sceneBoundaries,
    nextManualCutId: state.nextManualCutId,
    nextBoundaryId: state.nextBoundaryId,
  };
}

function scheduleAutosave() {
  scheduleProjectAutosave();
}

function dirtyPatch(state: EditorState) {
  return {
    dirtyGeneration: state.dirtyGeneration + 1,
    saveStatus: "dirty" as const,
    saveError: null,
  };
}

const emptyState = {
  manifest: null,
  preparedMedia: null,
  playback: null,
  model: DEFAULT_TRANSCRIPTION_MODEL,
  speakerDiarizationEnabled: DEFAULT_SPEAKER_DIARIZATION_ENABLED,
  duration: 0,
  words: [] as Word[],
  manualCuts: [] as ProjectManifest["manualCuts"],
  sceneBoundaries: [] as ProjectManifest["sceneBoundaries"],
  showDeleted: true,
  nextManualCutId: 1,
  nextBoundaryId: 1,
  past: [] as EditSnapshot[],
  future: [] as EditSnapshot[],
  gestureActive: false,
  selectedClipIndex: null,
  status: "idle" as EditorStatus,
  progress: null,
  error: null,
  currentTime: 0,
  playing: false,
  mediaEl: null,
  activeJobId: null,
  cancelJob: null,
  dirtyGeneration: 0,
  savedGeneration: 0,
  saveStatus: "saved" as SaveStatus,
  saveError: null,
  exportOpen: false,
  exportResult: null,
};

export const useEditorStore = create<EditorState>((set, get) => {
  const commitCommand = (command: EditorCommand): boolean => {
    const state = get();
    if (state.status !== "ready") return false;
    const result = applyEditorCommand(documentOf(state), command);
    if (!result) return false;

    const history = state.gestureActive
      ? { future: [] as EditSnapshot[] }
      : {
          past: [...state.past, snapshotOf(state)],
          future: [] as EditSnapshot[],
        };
    set({
      ...history,
      words: result.document.words,
      manualCuts: result.document.manualCuts,
      sceneBoundaries: result.document.sceneBoundaries,
      nextManualCutId: result.document.nextManualCutId,
      nextBoundaryId: result.document.nextBoundaryId,
      ...(result.selectedClipIndex !== undefined
        ? { selectedClipIndex: result.selectedClipIndex }
        : {}),
      ...dirtyPatch(state),
    });
    if (!state.gestureActive) scheduleAutosave();
    return true;
  };

  return {
    ...emptyState,

    loadProject: (manifest, options) => {
      get().mediaEl?.pause();
      set({
        ...emptyState,
        manifest,
        preparedMedia: options?.preparedMedia ?? null,
        playback: options?.playback ?? null,
        model:
          manifest.model === "import"
            ? DEFAULT_TRANSCRIPTION_MODEL
            : manifest.model,
        speakerDiarizationEnabled: manifest.speakerDiarizationEnabled,
        duration: manifest.duration,
        words: [...manifest.words],
        manualCuts: [...manifest.manualCuts],
        sceneBoundaries: [...manifest.sceneBoundaries],
        showDeleted: manifest.showDeleted,
        nextManualCutId: maxId(manifest.manualCuts),
        nextBoundaryId: maxId(manifest.sceneBoundaries),
        status: "ready",
      });
    },

    acknowledgeSave: (manifest, generation) => {
      const state = get();
      if (state.manifest?.id !== manifest.id) return;
      const savedGeneration = Math.max(state.savedGeneration, generation);
      set({
        manifest,
        savedGeneration,
        saveStatus:
          state.dirtyGeneration > savedGeneration ? "dirty" : "saved",
        saveError: null,
      });
    },
    setSaveState: (saveStatus, saveError = null) => set({ saveStatus, saveError }),
    setPreparedMedia: (preparedMedia) => set({ preparedMedia }),
    setPlayback: (playback) => set({ playback }),
    setModel: (model) => set({ model }),
    setSpeakerDiarizationEnabled: (speakerDiarizationEnabled) => {
      const state = get();
      if (
        !state.manifest ||
        state.speakerDiarizationEnabled === speakerDiarizationEnabled
      ) {
        set({ speakerDiarizationEnabled });
        return;
      }
      set({
        speakerDiarizationEnabled,
        manifest: { ...state.manifest, speakerDiarizationEnabled },
        ...dirtyPatch(state),
      });
      scheduleAutosave();
    },
    replaceTranscript: (words, model) => {
      if (words.length === 0) return;
      const state = get();
      set({
        words: [...words],
        manualCuts: [],
        sceneBoundaries: [],
        nextManualCutId: 1,
        nextBoundaryId: 1,
        past: [...state.past, snapshotOf(state)],
        future: [],
        selectedClipIndex: null,
        model: model === "import" ? state.model : model,
        manifest: state.manifest
          ? { ...state.manifest, model }
          : state.manifest,
        ...dirtyPatch(state),
      });
      scheduleAutosave();
    },

    deleteWords: (ids) => void commitCommand({ _tag: "DeleteWords", ids }),
    restoreWords: (ids) => void commitCommand({ _tag: "RestoreWords", ids }),
    correctWords: (ids, text) =>
      void commitCommand({ _tag: "CorrectWords", ids, text }),
    assignSpeaker: (ids, speaker) =>
      void commitCommand({ _tag: "AssignSpeaker", ids, speaker }),
    adjustWordBounds: (id, start, end) =>
      void commitCommand({ _tag: "AdjustWordBounds", id, start, end }),
    splitAtPlayhead: () =>
      commitCommand({ _tag: "SplitAt", time: get().currentTime }),
    removeSceneBoundary: (id) =>
      void commitCommand({ _tag: "RemoveSceneBoundary", id }),
    deleteClip: (clipIndex) => commitCommand({ _tag: "DeleteClip", clipIndex }),
    trimClipEdge: (clipIndex, edge, time) =>
      void commitCommand({ _tag: "TrimClipEdge", clipIndex, edge, time }),
    setSelectedClipIndex: (selectedClipIndex) => set({ selectedClipIndex }),

    beginGesture: () => {
      const state = get();
      if (state.status !== "ready" || state.gestureActive) return;
      set({
        gestureActive: true,
        past: [...state.past, snapshotOf(state)],
        future: [],
      });
    },
    endGesture: () => {
      const state = get();
      if (!state.gestureActive) return;
      const previous = state.past[state.past.length - 1];
      if (previous && snapshotsEqual(previous, snapshotOf(state))) {
        set({ gestureActive: false, past: state.past.slice(0, -1) });
        return;
      }
      set({ gestureActive: false });
      scheduleAutosave();
    },
    undo: () => {
      const state = get();
      if (state.status !== "ready") return;
      const previous = state.past[state.past.length - 1];
      if (!previous) return;
      set({
        words: previous.words,
        manualCuts: previous.manualCuts,
        sceneBoundaries: previous.sceneBoundaries,
        past: state.past.slice(0, -1),
        future: [snapshotOf(state), ...state.future],
        selectedClipIndex: null,
        gestureActive: false,
        ...dirtyPatch(state),
      });
      scheduleAutosave();
    },
    redo: () => {
      const state = get();
      if (state.status !== "ready") return;
      const next = state.future[0];
      if (!next) return;
      set({
        words: next.words,
        manualCuts: next.manualCuts,
        sceneBoundaries: next.sceneBoundaries,
        past: [...state.past, snapshotOf(state)],
        future: state.future.slice(1),
        selectedClipIndex: null,
        gestureActive: false,
        ...dirtyPatch(state),
      });
      scheduleAutosave();
    },
    toggleShowDeleted: () => {
      const state = get();
      if (state.status !== "ready") return;
      set({ showDeleted: !state.showDeleted, ...dirtyPatch(state) });
      scheduleAutosave();
    },

    setStatus: (status) => set({ status }),
    setProgress: (progress) => set({ progress }),
    setError: (error) => set({ error }),
    setCurrentTime: (currentTime) => set({ currentTime }),
    setPlaying: (playing) => set({ playing }),
    setMediaEl: (mediaEl) => set({ mediaEl }),
    setActiveJob: (activeJobId, cancelJob = null) =>
      set({ activeJobId, cancelJob }),
    setExportOpen: (exportOpen) => set({ exportOpen }),
    setExportResult: (exportResult) => set({ exportResult }),
    reset: () => {
      get().mediaEl?.pause();
      set({ ...emptyState });
    },
  };
});

export function currentDocument(): EditorDocument {
  return documentOf(useEditorStore.getState());
}
