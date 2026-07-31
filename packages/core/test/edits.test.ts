import { describe, expect, it } from "vitest";
import {
  applyEditorCommand,
  createEditorDocument,
} from "../src/commands";
import {
  applyWordBounds,
  canSplitAt,
  editedToOriginal,
  getClipSegments,
  getCutRanges,
  getKeepRanges,
  getWordCutRanges,
  trimClipEdgeResult,
} from "../src/edits";
import type { ManualCut, SceneBoundary, Word } from "../src/schema";

function word(
  id: number,
  text: string,
  start: number,
  end: number,
  deleted = false
): Word {
  return { id, text, start, end, speaker: 0, deleted };
}

describe("edit range math", () => {
  it("derives cuts from deleted words", () => {
    const cuts = getWordCutRanges(
      [
        word(1, "hello", 0, 0.5),
        word(2, "uh", 0.6, 0.8, true),
        word(3, "everyone", 1, 1.5),
      ],
      2
    );
    expect(cuts).toEqual([{ start: 0.6, end: 0.8 }]);
  });

  it("merges manual cuts with deleted-word cuts", () => {
    const words = [
      word(1, "a", 0, 1),
      word(2, "b", 1, 2, true),
      word(3, "c", 2, 3),
    ];
    const manual: ManualCut[] = [{ id: 1, start: 2.5, end: 2.7 }];
    expect(getCutRanges(words, 3, manual)).toHaveLength(2);
  });

  it("maps compact edited time back across removed ranges", () => {
    const cuts = [
      { start: 1, end: 2 },
      { start: 3, end: 4 },
    ];
    expect(editedToOriginal(0.5, cuts, 5)).toBeCloseTo(0.5);
    expect(editedToOriginal(1, cuts, 5)).toBeCloseTo(2);
    expect(editedToOriginal(2, cuts, 5)).toBeCloseTo(4);
    expect(editedToOriginal(3, cuts, 5)).toBeCloseTo(5);
    expect(editedToOriginal(0, [{ start: 0, end: 1 }], 5)).toBeCloseTo(1);
    expect(editedToOriginal(4, [{ start: 4, end: 5 }], 5)).toBeCloseTo(3.999);
  });

  it("adjusts overlapping word bounds and their neighbor", () => {
    const next = applyWordBounds(
      [
        word(1, "hello", 0, 0.55),
        word(2, "uh", 0.45, 0.7),
        word(3, "everyone", 0.8, 1.2),
      ],
      2,
      0.55,
      0.7,
      2
    );
    expect(next?.[1].start).toBeCloseTo(0.55);
    expect(next?.[0].end).toBeCloseTo(0.55);
  });

  it("subdivides keep ranges with scene boundaries", () => {
    const words = [word(1, "a", 0, 1), word(2, "b", 1, 2), word(3, "c", 2, 3)];
    const keeps = getKeepRanges(getCutRanges(words, 3), 3);
    const boundaries: SceneBoundary[] = [{ id: 1, time: 1.5 }];
    expect(getClipSegments(keeps, boundaries)).toMatchObject([
      { start: 0, end: 1.5 },
      { start: 1.5, end: 3 },
    ]);
  });

  it("rejects splitting inside cuts", () => {
    const cuts = getCutRanges(
      [word(1, "a", 0, 1, true), word(2, "b", 1, 2)],
      2
    );
    expect(canSplitAt(0.5, 2, cuts, [])).toBe(false);
    expect(canSplitAt(1.5, 2, cuts, [])).toBe(true);
  });

  it("turns a shrinking trim into a manual cut", () => {
    const result = trimClipEdgeResult(
      [word(1, "a", 0, 3)],
      [],
      { id: "c", start: 0, end: 3, index: 0 },
      "in",
      1,
      3,
      1
    );
    expect(result?.manualCuts).toEqual([{ id: 1, start: 0, end: 1 }]);
  });
});

describe("shared editor commands", () => {
  it("deletes a split clip and removes its adjacent boundaries", () => {
    const document = {
      ...createEditorDocument(3, [word(1, "test", 0, 3)]),
      sceneBoundaries: [
        { id: 7, time: 1 },
        { id: 8, time: 2 },
      ],
    };
    const result = applyEditorCommand(document, {
      _tag: "DeleteClip",
      clipIndex: 1,
    });
    expect(result?.document.manualCuts).toEqual([{ id: 1, start: 1, end: 2 }]);
    expect(result?.document.sceneBoundaries).toEqual([]);
  });

  it("assigns selected words to a non-negative speaker", () => {
    const document = createEditorDocument(2, [
      word(1, "hello", 0.2, 0.8),
      word(2, "world", 0.8, 1.4),
    ]);
    const result = applyEditorCommand(document, {
      _tag: "AssignSpeaker",
      ids: [2],
      speaker: 3,
    });
    expect(result?.document.words.map((item) => item.speaker)).toEqual([0, 3]);
    expect(
      applyEditorCommand(result!.document, {
        _tag: "AssignSpeaker",
        ids: [2],
        speaker: 3,
      })
    ).toBeNull();
    expect(
      applyEditorCommand(document, {
        _tag: "AssignSpeaker",
        ids: [1],
        speaker: -1,
      })
    ).toBeNull();
  });

  it("rejects corrections that span unselected hidden words", () => {
    const document = createEditorDocument(2, [
      word(1, "keep", 0.1, 0.4),
      word(2, "hidden", 0.4, 0.8, true),
      word(3, "keep", 0.8, 1.2),
    ]);
    expect(
      applyEditorCommand(document, {
        _tag: "CorrectWords",
        ids: [1, 3],
        text: "replacement",
      })
    ).toBeNull();
  });

  it("applies transcript corrections while retaining the timing span", () => {
    const document = createEditorDocument(2, [
      word(1, "helo", 0.2, 0.8),
      word(2, "world", 0.8, 1.4),
    ]);
    const result = applyEditorCommand(document, {
      _tag: "CorrectWords",
      ids: [1],
      text: "hello there",
    });
    expect(result?.document.words.map((item) => item.text)).toEqual([
      "hello",
      "there",
      "world",
    ]);
    expect(result?.document.words[0].start).toBe(0.2);
    expect(result?.document.words[1].end).toBe(0.8);
  });
});
