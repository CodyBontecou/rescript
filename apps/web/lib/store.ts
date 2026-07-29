"use client";

import { create } from "zustand";
import type {
  EditSnapshot,
  EditorStatus,
  ManualCut,
  ProgressInfo,
  SceneBoundary,
  Word,
} from "./types";
import {
  applyEditorCommand,
  type EditorCommand,
} from "@rescript/core/commands";
import type { EditorDocument } from "@rescript/core";
import {
  DEFAULT_TRANSCRIPTION_MODEL,
  isModelChoice,
  isTranscriptionModel,
  loadModelPreference,
  saveModelPreference,
} from "./models";
import type { ModelChoice } from "./models";
import { detectMediaKind, type MediaKind } from "./media";
import {
  deleteProject,
  fileFromProject,
  getProject,
  type ProjectMeta,
} from "./projects";

interface PendingTranscript {
  name: string;
  words: Word[];
}

interface EditorState {
  // Media
  videoFile: File | null;
  mediaUrl: string | null;
  /** Whether the loaded file is video or audio-only. */
  mediaKind: MediaKind | null;
  duration: number;
  /** Mono 16 kHz PCM of the media's audio track (used for waveform + ASR). */
  audio: Float32Array | null;
  /** Transcript source selected on the upload screen (local ASR or import). */
  model: ModelChoice;
  /**
   * Caption file parsed on the upload screen when source is "import".
   * Cleared when switching back to a transcription model or after media loads.
   */
  pendingTranscript: PendingTranscript | null;
  /** IndexedDB project id when this session is persisted; null for a fresh upload mid-pipeline. */
  projectId: string | null;
  /**
   * When true, Editor extracts audio for the waveform but skips transcription
   * (restored projects / imported transcripts already have words).
   */
  skipTranscription: boolean;

  // Pipeline status
  status: EditorStatus;
  progress: ProgressInfo;
  /** Streaming partial transcript text while transcribing. */
  partialText: string;
  error: string | null;

  // Transcript / edits
  words: Word[];
  manualCuts: ManualCut[];
  sceneBoundaries: SceneBoundary[];
  showDeleted: boolean;
  past: EditSnapshot[];
  future: EditSnapshot[];
  /** Selected timeline clip index, or null. */
  selectedClipIndex: number | null;
  nextManualCutId: number;
  nextBoundaryId: number;
  /**
   * When true, subsequent edit mutations coalesce into the undo entry
   * created by `beginGesture` (one undo step per drag).
   */
  gestureActive: boolean;

  // Playback (mirrored from the <video>/<audio> element for UI rendering)
  currentTime: number;
  playing: boolean;
  videoEl: HTMLMediaElement | null;

  // Export
  exportUrl: string | null;
  exportOpen: boolean;

  // Actions
  /** Load media for editing. Pass `words` to skip local ASR and use that transcript. */
  loadVideo: (file: File, options?: { words?: Word[] }) => void;
  /** Restore a saved project from IndexedDB (no re-transcription). */
  openProject: (id: string) => Promise<void>;
  /** Delete a saved project; if it is the active one, resets to the home screen. */
  removeProject: (id: string) => Promise<void>;
  setModel: (m: ModelChoice) => void;
  setPendingTranscript: (t: PendingTranscript | null) => void;
  setDuration: (d: number) => void;
  setAudio: (a: Float32Array) => void;
  setStatus: (s: EditorStatus) => void;
  setProgress: (p: ProgressInfo) => void;
  setPartialText: (t: string) => void;
  setError: (message: string) => void;
  setWords: (words: Word[]) => void;
  /**
   * Replace the current transcript with an imported one (keeps media).
   * Used when the user brings their own SRT/VTT/JSON instead of Whisper.
   */
  importWords: (words: Word[]) => void;
  deleteWords: (ids: number[]) => void;
  restoreWords: (ids: number[]) => void;
  /** Replace the selected (contiguous) words with corrected text. */
  correctWords: (ids: number[], text: string) => void;
  /** Nudge a word's start/end on the timeline (may steal time from neighbors). */
  adjustWordBounds: (id: number, start: number, end: number) => void;
  /** Insert a scene boundary at the playhead (Descript-style split). */
  splitAtPlayhead: () => boolean;
  /** Remove a scene boundary by id (join adjacent clips). */
  removeSceneBoundary: (id: number) => void;
  /** Cut a timeline clip and connect the kept clips on either side. */
  deleteClip: (clipIndex: number) => boolean;
  /** Trim the in or out edge of a clip segment by index. */
  trimClipEdge: (
    clipIndex: number,
    edge: "in" | "out",
    time: number
  ) => void;
  setSelectedClipIndex: (index: number | null) => void;
  /** Start a drag gesture so subsequent edits share one undo entry. */
  beginGesture: () => void;
  /** End the current drag gesture. */
  endGesture: () => void;
  undo: () => void;
  redo: () => void;
  toggleShowDeleted: () => void;
  setCurrentTime: (t: number) => void;
  setPlaying: (p: boolean) => void;
  setVideoEl: (el: HTMLMediaElement | null) => void;
  setExportUrl: (url: string | null) => void;
  setExportOpen: (open: boolean) => void;
  reset: () => void;
}

function bumpAutosave() {
  // Dynamic import avoids a circular dependency with lib/autosave.ts.
  void import("./autosave").then((m) => m.scheduleProjectAutosave());
}

function snapshotOf(s: {
  words: Word[];
  manualCuts: ManualCut[];
  sceneBoundaries: SceneBoundary[];
}): EditSnapshot {
  return {
    words: s.words,
    manualCuts: s.manualCuts,
    sceneBoundaries: s.sceneBoundaries,
  };
}

function snapshotsEqual(a: EditSnapshot, b: EditSnapshot): boolean {
  return (
    a.words === b.words &&
    a.manualCuts === b.manualCuts &&
    a.sceneBoundaries === b.sceneBoundaries
  );
}

function maxId(items: Array<{ id: number }>, fallback = 1): number {
  return items.reduce((m, x) => Math.max(m, x.id), fallback - 1) + 1;
}

function pushEdit(
  get: () => EditorState,
  set: (
    partial:
      | Partial<EditorState>
      | ((s: EditorState) => Partial<EditorState>)
  ) => void,
  next: Partial<
    Pick<
      EditorState,
      | "words"
      | "manualCuts"
      | "sceneBoundaries"
      | "selectedClipIndex"
      | "nextManualCutId"
      | "nextBoundaryId"
    >
  >
) {
  const s = get();
  if (s.gestureActive) {
    // Coalesce into the snapshot already pushed by beginGesture.
    set({ future: [], ...next });
  } else {
    set({
      past: [...s.past, snapshotOf(s)],
      future: [],
      ...next,
    });
  }
  bumpAutosave();
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

/** Run a platform-neutral command and project its persistent result into the view store. */
function runEditorCommand(
  get: () => EditorState,
  set: (
    partial:
      | Partial<EditorState>
      | ((s: EditorState) => Partial<EditorState>)
  ) => void,
  command: EditorCommand
): boolean {
  const result = applyEditorCommand(documentOf(get()), command);
  if (!result) return false;
  const { document } = result;
  const next: Partial<
    Pick<
      EditorState,
      | "words"
      | "manualCuts"
      | "sceneBoundaries"
      | "selectedClipIndex"
      | "nextManualCutId"
      | "nextBoundaryId"
    >
  > = {
    words: document.words,
    manualCuts: document.manualCuts,
    sceneBoundaries: document.sceneBoundaries,
    nextManualCutId: document.nextManualCutId,
    nextBoundaryId: document.nextBoundaryId,
  };
  if (result.selectedClipIndex !== undefined) {
    next.selectedClipIndex = result.selectedClipIndex;
  }
  pushEdit(get, set, next);
  return true;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  videoFile: null,
  mediaUrl: null,
  mediaKind: null,
  duration: 0,
  audio: null,
  model: DEFAULT_TRANSCRIPTION_MODEL,
  pendingTranscript: null,
  projectId: null,
  skipTranscription: false,

  status: "idle",
  progress: { message: "", value: null },
  partialText: "",
  error: null,

  words: [],
  manualCuts: [],
  sceneBoundaries: [],
  showDeleted: true,
  past: [],
  future: [],
  selectedClipIndex: null,
  nextManualCutId: 1,
  nextBoundaryId: 1,
  gestureActive: false,

  currentTime: 0,
  playing: false,
  videoEl: null,

  exportUrl: null,
  exportOpen: false,

  loadVideo: (file, options) => {
    const kind = detectMediaKind(file);
    if (!kind) return;
    const imported = options?.words;
    if (imported && imported.length === 0) return;
    const prev = get().mediaUrl;
    if (prev) URL.revokeObjectURL(prev);
    const current = get().model;
    set({
      videoFile: file,
      mediaUrl: URL.createObjectURL(file),
      mediaKind: kind,
      projectId: null,
      skipTranscription: Boolean(imported),
      model:
        imported
          ? "import"
          : isTranscriptionModel(current)
            ? current
            : DEFAULT_TRANSCRIPTION_MODEL,
      pendingTranscript: null,
      status: "preparing",
      progress: {
        message: imported ? "Loading media…" : "Loading media engine…",
        value: null,
      },
      words: imported ? imported : [],
      manualCuts: [],
      sceneBoundaries: [],
      past: [],
      future: [],
      selectedClipIndex: null,
      nextManualCutId: 1,
      nextBoundaryId: 1,
      gestureActive: false,
      partialText: "",
      error: null,
      currentTime: 0,
      exportUrl: null,
      audio: null,
      duration: 0,
    });
  },

  openProject: async (id) => {
    const record = await getProject(id);
    if (!record) throw new Error("That project is no longer saved.");
    const file = fileFromProject(record);
    const prev = get().mediaUrl;
    if (prev) URL.revokeObjectURL(prev);
    const manualCuts = record.manualCuts ?? [];
    const sceneBoundaries = record.sceneBoundaries ?? [];
    set({
      videoFile: file,
      mediaUrl: URL.createObjectURL(file),
      mediaKind: record.mediaKind,
      duration: record.duration,
      model: isModelChoice(record.model)
        ? record.model
        : DEFAULT_TRANSCRIPTION_MODEL,
      projectId: record.id,
      skipTranscription: true,
      pendingTranscript: null,
      status: "preparing",
      progress: { message: "Loading media engine…", value: null },
      words: record.words,
      manualCuts,
      sceneBoundaries,
      showDeleted: record.showDeleted,
      past: [],
      future: [],
      selectedClipIndex: null,
      nextManualCutId: maxId(manualCuts, 1),
      nextBoundaryId: maxId(sceneBoundaries, 1),
      partialText: "",
      error: null,
      currentTime: 0,
      playing: false,
      exportUrl: null,
      exportOpen: false,
      audio: null,
    });
  },

  removeProject: async (id) => {
    await deleteProject(id);
    if (get().projectId === id) {
      get().reset();
    }
  },

  setModel: (model) => {
    if (isTranscriptionModel(model)) {
      saveModelPreference(model);
      set({ model, pendingTranscript: null });
    } else {
      set({ model });
    }
  },
  setPendingTranscript: (pendingTranscript) => set({ pendingTranscript }),
  setDuration: (duration) => {
    set({ duration });
    if (get().status === "ready") bumpAutosave();
  },
  setAudio: (audio) => set({ audio }),
  setStatus: (status) => {
    set({ status });
    if (status === "ready") bumpAutosave();
  },
  setProgress: (progress) => set({ progress }),
  setPartialText: (partialText) => set({ partialText }),
  setError: (message) => set({ status: "error", error: message }),
  setWords: (words) => {
    set({
      words,
      manualCuts: [],
      sceneBoundaries: [],
      past: [],
      future: [],
      selectedClipIndex: null,
    });
    if (get().status === "ready") bumpAutosave();
  },
  importWords: (words) => {
    if (words.length === 0) return;
    const { status } = get();
    if (
      status !== "ready" &&
      status !== "error" &&
      status !== "transcribing"
    ) {
      return;
    }
    // Stop local transcription if it was still running.
    void import("@/hooks/useTranscriber").then((m) => m.cancelTranscription());
    set({
      words,
      manualCuts: [],
      sceneBoundaries: [],
      past: [],
      future: [],
      selectedClipIndex: null,
      partialText: "",
      error: null,
      status: "ready",
      progress: { message: "", value: null },
      skipTranscription: true,
      model: "import",
    });
    bumpAutosave();
  },

  deleteWords: (ids) => {
    runEditorCommand(get, set, { _tag: "DeleteWords", ids });
  },
  restoreWords: (ids) => {
    runEditorCommand(get, set, { _tag: "RestoreWords", ids });
  },
  correctWords: (ids, text) => {
    runEditorCommand(get, set, { _tag: "CorrectWords", ids, text });
  },

  adjustWordBounds: (id, start, end) => {
    runEditorCommand(get, set, {
      _tag: "AdjustWordBounds",
      id,
      start,
      end,
    });
  },

  splitAtPlayhead: () =>
    runEditorCommand(get, set, {
      _tag: "SplitAt",
      time: get().currentTime,
    }),

  removeSceneBoundary: (id) => {
    runEditorCommand(get, set, { _tag: "RemoveSceneBoundary", id });
  },

  deleteClip: (clipIndex) =>
    runEditorCommand(get, set, { _tag: "DeleteClip", clipIndex }),

  trimClipEdge: (clipIndex, edge, time) => {
    runEditorCommand(get, set, {
      _tag: "TrimClipEdge",
      clipIndex,
      edge,
      time,
    });
  },

  setSelectedClipIndex: (selectedClipIndex) => set({ selectedClipIndex }),

  beginGesture: () => {
    const s = get();
    if (s.gestureActive) return;
    set({
      gestureActive: true,
      past: [...s.past, snapshotOf(s)],
      future: [],
    });
  },
  endGesture: () => {
    const s = get();
    if (!s.gestureActive) return;
    const last = s.past[s.past.length - 1];
    if (last && snapshotsEqual(last, snapshotOf(s))) {
      // No net change — drop the empty undo entry.
      set({ gestureActive: false, past: s.past.slice(0, -1) });
    } else {
      set({ gestureActive: false });
      bumpAutosave();
    }
  },

  undo: () => {
    const { past, future, words, manualCuts, sceneBoundaries } = get();
    if (past.length === 0) return;
    const prev = past[past.length - 1];
    set({
      words: prev.words,
      manualCuts: prev.manualCuts,
      sceneBoundaries: prev.sceneBoundaries,
      past: past.slice(0, -1),
      future: [{ words, manualCuts, sceneBoundaries }, ...future],
      selectedClipIndex: null,
      gestureActive: false,
    });
    bumpAutosave();
  },
  redo: () => {
    const { past, future, words, manualCuts, sceneBoundaries } = get();
    if (future.length === 0) return;
    const next = future[0];
    set({
      words: next.words,
      manualCuts: next.manualCuts,
      sceneBoundaries: next.sceneBoundaries,
      future: future.slice(1),
      past: [...past, { words, manualCuts, sceneBoundaries }],
      selectedClipIndex: null,
      gestureActive: false,
    });
    bumpAutosave();
  },
  toggleShowDeleted: () => {
    set((s) => ({ showDeleted: !s.showDeleted }));
    bumpAutosave();
  },

  setCurrentTime: (currentTime) => set({ currentTime }),
  setPlaying: (playing) => set({ playing }),
  setVideoEl: (videoEl) => set({ videoEl }),
  setExportUrl: (exportUrl) => set({ exportUrl }),
  setExportOpen: (exportOpen) => set({ exportOpen }),

  reset: () => {
    const { mediaUrl, exportUrl } = get();
    if (mediaUrl) URL.revokeObjectURL(mediaUrl);
    if (exportUrl) URL.revokeObjectURL(exportUrl);
    set({
      videoFile: null,
      mediaUrl: null,
      mediaKind: null,
      duration: 0,
      audio: null,
      model: loadModelPreference(),
      pendingTranscript: null,
      projectId: null,
      skipTranscription: false,
      status: "idle",
      progress: { message: "", value: null },
      partialText: "",
      error: null,
      words: [],
      manualCuts: [],
      sceneBoundaries: [],
      past: [],
      future: [],
      selectedClipIndex: null,
      nextManualCutId: 1,
      nextBoundaryId: 1,
      gestureActive: false,
      currentTime: 0,
      playing: false,
      exportUrl: null,
      exportOpen: false,
    });
  },
}));

/** Apply the stored model choice after mount (avoids SSR/localStorage mismatch). */
export function hydrateModelPreference() {
  const stored = loadModelPreference();
  if (stored !== useEditorStore.getState().model) {
    useEditorStore.setState({ model: stored });
  }
}

export type { ProjectMeta };
