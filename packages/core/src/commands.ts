import {
  addManualCut,
  applyWordBounds,
  canSplitAt,
  getClipSegments,
  getCutRanges,
  getKeepRanges,
  trimClipEdgeResult,
} from "./edits";
import type { EditorDocument, Word } from "./schema";

export type EditorCommand =
  | { readonly _tag: "DeleteWords"; readonly ids: readonly number[] }
  | { readonly _tag: "RestoreWords"; readonly ids: readonly number[] }
  | { readonly _tag: "AssignSpeaker"; readonly ids: readonly number[]; readonly speaker: number }
  | { readonly _tag: "CorrectWords"; readonly ids: readonly number[]; readonly text: string }
  | {
      readonly _tag: "AdjustWordBounds";
      readonly id: number;
      readonly start: number;
      readonly end: number;
    }
  | { readonly _tag: "SplitAt"; readonly time: number }
  | { readonly _tag: "RemoveSceneBoundary"; readonly id: number }
  | { readonly _tag: "DeleteClip"; readonly clipIndex: number }
  | {
      readonly _tag: "TrimClipEdge";
      readonly clipIndex: number;
      readonly edge: "in" | "out";
      readonly time: number;
    };

export interface EditorCommandResult {
  document: EditorDocument;
  /** Suggested timeline selection after applying the command. */
  selectedClipIndex?: number | null;
}

export function createEditorDocument(
  duration = 0,
  words: Word[] = []
): EditorDocument {
  return {
    duration,
    words,
    manualCuts: [],
    sceneBoundaries: [],
    nextManualCutId: 1,
    nextBoundaryId: 1,
  };
}

/**
 * Apply one persistent editing command without touching UI or platform state.
 * A null result means the command was invalid for the current document or was
 * a no-op. This function is the shared command boundary used by every shell.
 */
export function applyEditorCommand(
  document: EditorDocument,
  command: EditorCommand
): EditorCommandResult | null {
  switch (command._tag) {
    case "DeleteWords":
      return setDeleted(document, command.ids, true);
    case "RestoreWords":
      return setDeleted(document, command.ids, false);
    case "AssignSpeaker":
      return assignSpeaker(document, command.ids, command.speaker);
    case "CorrectWords":
      return correctWords(document, command.ids, command.text);
    case "AdjustWordBounds": {
      const words = applyWordBounds(
        document.words,
        command.id,
        command.start,
        command.end,
        document.duration
      );
      return words ? { document: { ...document, words } } : null;
    }
    case "SplitAt": {
      const cuts = getCutRanges(
        document.words,
        document.duration,
        document.manualCuts
      );
      if (
        !canSplitAt(
          command.time,
          document.duration,
          cuts,
          document.sceneBoundaries
        )
      ) {
        return null;
      }
      const id = document.nextBoundaryId;
      return {
        document: {
          ...document,
          sceneBoundaries: [
            ...document.sceneBoundaries,
            { id, time: command.time },
          ].sort((a, b) => a.time - b.time),
          nextBoundaryId: id + 1,
        },
      };
    }
    case "RemoveSceneBoundary": {
      if (!document.sceneBoundaries.some((boundary) => boundary.id === command.id)) {
        return null;
      }
      return {
        document: {
          ...document,
          sceneBoundaries: document.sceneBoundaries.filter(
            (boundary) => boundary.id !== command.id
          ),
        },
        selectedClipIndex: null,
      };
    }
    case "DeleteClip":
      return deleteClip(document, command.clipIndex);
    case "TrimClipEdge":
      return trimClip(
        document,
        command.clipIndex,
        command.edge,
        command.time
      );
  }
}

function setDeleted(
  document: EditorDocument,
  ids: readonly number[],
  deleted: boolean
): EditorCommandResult | null {
  if (ids.length === 0) return null;
  const idSet = new Set(ids);
  let changed = false;
  const words = document.words.map((word) => {
    if (idSet.has(word.id) && word.deleted !== deleted) {
      changed = true;
      return { ...word, deleted };
    }
    return word;
  });
  return changed ? { document: { ...document, words } } : null;
}

function assignSpeaker(
  document: EditorDocument,
  ids: readonly number[],
  speaker: number
): EditorCommandResult | null {
  if (ids.length === 0 || !Number.isInteger(speaker) || speaker < 0) return null;
  const idSet = new Set(ids);
  let changed = false;
  const words = document.words.map((word) => {
    if (idSet.has(word.id) && word.speaker !== speaker) {
      changed = true;
      return { ...word, speaker };
    }
    return word;
  });
  return changed ? { document: { ...document, words } } : null;
}

function correctWords(
  document: EditorDocument,
  ids: readonly number[],
  text: string
): EditorCommandResult | null {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (ids.length === 0 || tokens.length === 0) return null;

  const idSet = new Set(ids);
  const indices = document.words.reduce<number[]>((acc, word, index) => {
    if (idSet.has(word.id)) acc.push(index);
    return acc;
  }, []);
  if (indices.length === 0) return null;
  if (indices.some((index, offset) => offset > 0 && index !== indices[offset - 1] + 1)) {
    return null;
  }

  const from = indices[0];
  const to = indices[indices.length - 1];
  const selected = document.words.slice(from, to + 1);
  if (selected.map((word) => word.text).join(" ") === tokens.join(" ")) {
    return null;
  }

  const spanStart = selected[0].start;
  const spanEnd = selected[selected.length - 1].end;
  const span = Math.max(0.02, spanEnd - spanStart);
  const totalChars = tokens.reduce((total, token) => total + token.length, 0);
  let nextId = document.words.reduce((max, word) => Math.max(max, word.id), 0) + 1;
  let cursor = spanStart;
  const deleted = selected.every((word) => word.deleted);
  const replacement = tokens.map((token): Word => {
    const tokenDuration = (span * token.length) / totalChars;
    const word: Word = {
      id: nextId++,
      text: token,
      start: cursor,
      end: Math.min(spanEnd, cursor + tokenDuration),
      speaker: selected[0].speaker,
      deleted,
    };
    cursor = word.end;
    return word;
  });
  replacement[replacement.length - 1].end = spanEnd;

  return {
    document: {
      ...document,
      words: [
        ...document.words.slice(0, from),
        ...replacement,
        ...document.words.slice(to + 1),
      ],
    },
  };
}

function deleteClip(
  document: EditorDocument,
  clipIndex: number
): EditorCommandResult | null {
  const cuts = getCutRanges(
    document.words,
    document.duration,
    document.manualCuts
  );
  const clips = getClipSegments(
    getKeepRanges(cuts, document.duration),
    document.sceneBoundaries
  );
  const clip = clips.find((candidate) => candidate.index === clipIndex);
  if (!clip || clips.length <= 1) return null;

  const result = addManualCut(
    document.manualCuts,
    clip.start,
    clip.end,
    document.nextManualCutId
  );
  const atClipEdge = (time: number) =>
    Math.abs(time - clip.start) < 1e-4 || Math.abs(time - clip.end) < 1e-4;

  return {
    document: {
      ...document,
      manualCuts: result.cuts,
      sceneBoundaries: document.sceneBoundaries.filter(
        (boundary) => !atClipEdge(boundary.time)
      ),
      nextManualCutId: result.nextId,
    },
    selectedClipIndex: null,
  };
}

function trimClip(
  document: EditorDocument,
  clipIndex: number,
  edge: "in" | "out",
  time: number
): EditorCommandResult | null {
  const cuts = getCutRanges(
    document.words,
    document.duration,
    document.manualCuts
  );
  const clips = getClipSegments(
    getKeepRanges(cuts, document.duration),
    document.sceneBoundaries
  );
  const clip = clips[clipIndex];
  if (!clip) return null;

  const result = trimClipEdgeResult(
    document.words,
    document.manualCuts,
    clip,
    edge,
    time,
    document.duration,
    document.nextManualCutId
  );
  if (!result) return null;

  return {
    document: {
      ...document,
      words: result.words,
      manualCuts: result.manualCuts,
      nextManualCutId: result.nextCutId,
    },
    selectedClipIndex: clipIndex,
  };
}
