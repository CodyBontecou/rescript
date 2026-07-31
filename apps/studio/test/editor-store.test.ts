import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectManifest } from "@rescript/core";
import { useEditorStore } from "../src/editor/store";

vi.stubGlobal("window", {
  setTimeout: vi.fn(() => 1),
  clearTimeout: vi.fn(),
});

const manifest: ProjectManifest = {
  schemaVersion: 1,
  id: "11111111-1111-4111-8111-111111111111",
  revision: 0,
  name: "Test",
  media: {
    relativePath: "media/test.wav",
    name: "test.wav",
    mediaType: "audio/wav",
    mediaKind: "audio",
    byteLength: 100,
  },
  duration: 3,
  model: "base",
  speakerDiarizationEnabled: false,
  words: [
    { id: 1, text: "one", start: 0, end: 0.5, speaker: 0, deleted: false },
    { id: 2, text: "two", start: 0.6, end: 1.1, speaker: 0, deleted: false },
    { id: 3, text: "three", start: 1.2, end: 1.8, speaker: 1, deleted: false },
  ],
  manualCuts: [],
  sceneBoundaries: [],
  showDeleted: true,
  createdAt: 1,
  updatedAt: 1,
};

describe("Studio editor store", () => {
  beforeEach(() => {
    useEditorStore.getState().reset();
    useEditorStore.getState().loadProject(manifest);
  });

  it("uses lightweight defaults for a new editor", () => {
    useEditorStore.getState().reset();
    expect(useEditorStore.getState().model).toBe("parakeet-v2");
    expect(useEditorStore.getState().speakerDiarizationEnabled).toBe(false);
  });

  it("persists the per-project speaker diarization setting", () => {
    const store = useEditorStore.getState();
    expect(store.speakerDiarizationEnabled).toBe(false);
    store.setSpeakerDiarizationEnabled(true);
    const changed = useEditorStore.getState();
    expect(changed.speakerDiarizationEnabled).toBe(true);
    expect(changed.manifest?.speakerDiarizationEnabled).toBe(true);
    expect(changed.dirtyGeneration).toBe(1);
  });

  it("applies commands with undo and redo history", () => {
    const store = useEditorStore.getState();
    store.deleteWords([2]);
    expect(useEditorStore.getState().words[1].deleted).toBe(true);
    expect(useEditorStore.getState().dirtyGeneration).toBe(1);

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().words[1].deleted).toBe(false);
    useEditorStore.getState().redo();
    expect(useEditorStore.getState().words[1].deleted).toBe(true);
  });

  it("assigns speakers and coalesces drag gestures", () => {
    useEditorStore.getState().assignSpeaker([1, 2], 3);
    expect(useEditorStore.getState().words.slice(0, 2).map((word) => word.speaker)).toEqual([3, 3]);

    const historyBefore = useEditorStore.getState().past.length;
    useEditorStore.getState().beginGesture();
    useEditorStore.getState().adjustWordBounds(2, 0.55, 1.1);
    useEditorStore.getState().adjustWordBounds(2, 0.5, 1.1);
    useEditorStore.getState().endGesture();
    expect(useEditorStore.getState().past.length).toBe(historyBefore + 1);
  });

  it("preserves newer local edits when acknowledging an older save", () => {
    useEditorStore.getState().deleteWords([1]);
    const generation = useEditorStore.getState().dirtyGeneration;
    useEditorStore.getState().deleteWords([2]);
    useEditorStore.getState().acknowledgeSave(
      { ...manifest, revision: 1, words: [{ ...manifest.words[0], deleted: true }, ...manifest.words.slice(1)] },
      generation
    );
    const state = useEditorStore.getState();
    expect(state.manifest?.revision).toBe(1);
    expect(state.words[1].deleted).toBe(true);
    expect(state.saveStatus).toBe("dirty");
  });
});
