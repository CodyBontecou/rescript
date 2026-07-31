import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  FileText,
  Pencil,
  Scissors,
  Users,
  WandSparkles,
  X,
} from "lucide-react";
import { useEditorStore } from "../editor/store";
import { findFillerWordIds } from "@rescript/core/fillers";
import { cutRangeAt, getCutRanges, getKeepRanges } from "@rescript/core/edits";
import type { SpeakerTurn, TimeRange, Word } from "@rescript/core";

export const SPEAKER_COLORS = [
  "#16a34a", // green
  "#2563eb", // blue
  "#9333ea", // purple
  "#ea580c", // orange
  "#0d9488", // teal
  "#db2777", // pink
];

export const speakerColor = (i: number) =>
  SPEAKER_COLORS[Math.max(0, i) % SPEAKER_COLORS.length];

function findActiveWordId(words: Word[], t: number): number {
  // Binary search for the last word starting at or before t.
  let lo = 0;
  let hi = words.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= t) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx >= 0 && t < words[idx].end + 0.15) return words[idx].id;
  return -1;
}

const WordSpan = memo(function WordSpan({
  word,
  active,
  focused,
  onActivate,
}: {
  word: Word;
  active: boolean;
  focused: boolean;
  onActivate: (word: Word, element: HTMLElement) => void;
}) {
  // The trailing space lives inside the span so that selection and deletion
  // highlights are continuous across words instead of breaking at each gap.
  return (
    <span
      role="button"
      tabIndex={0}
      data-wid={word.id}
      data-focused={focused ? "" : undefined}
      aria-label={`${word.text}. Included in video`}
      onClick={(event) => onActivate(word, event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onActivate(word, event.currentTarget);
      }}
      className={`py-0.5 cursor-pointer transition-colors duration-75 ${active
        ? "bg-neutral-200/80 text-zinc-900"
        : "text-zinc-800 hover:bg-neutral-50"
        }`}
    >
      {word.text}{" "}
    </span>
  );
});

interface SelectionInfo {
  source: "focus" | "range";
  ids: number[];
  canCorrect: boolean;
  top: number;
  left: number;
}

function selectionCanBeCorrected(
  words: Word[],
  ids: readonly number[],
  cuts: TimeRange[]
): boolean {
  if (ids.length === 0) return false;
  const selected = new Set(ids);
  const indices = words.flatMap((word, index) =>
    selected.has(word.id) ? [index] : []
  );
  if (
    indices.length !== selected.size ||
    !indices.every(
      (index, offset) => offset === 0 || index === indices[offset - 1] + 1
    )
  ) {
    return false;
  }

  const start = words[indices[0]].start;
  const end = words[indices[indices.length - 1]].end;
  return !cuts.some((cut) => cut.start < end && cut.end > start);
}

function toolbarLeft(rect: DOMRect, containerRect: DOMRect): number {
  const center = rect.left - containerRect.left + rect.width / 2;
  const halfWidth = Math.min(132, Math.max(0, containerRect.width / 2 - 8));
  return Math.min(Math.max(halfWidth, center), containerRect.width - halfWidth);
}

export default function TranscriptPanel({
  onImportTranscript,
  onTranscribe,
}: {
  onImportTranscript: () => void;
  onTranscribe: () => void;
}) {
  const words = useEditorStore((s) => s.words);
  const manualCuts = useEditorStore((s) => s.manualCuts);
  const duration = useEditorStore((s) => s.duration);
  const status = useEditorStore((s) => s.status);
  const progress = useEditorStore((s) => s.progress);
  const error = useEditorStore((s) => s.error);
  const deleteWords = useEditorStore((s) => s.deleteWords);
  const correctWords = useEditorStore((s) => s.correctWords);
  const assignSpeaker = useEditorStore((s) => s.assignSpeaker);
  const speakerDiarizationEnabled = useEditorStore(
    (s) => s.speakerDiarizationEnabled
  );
  const setSpeakerDiarizationEnabled = useEditorStore(
    (s) => s.setSpeakerDiarizationEnabled
  );
  const playing = useEditorStore((s) => s.playing);
  const activeWordId = useEditorStore((s) => findActiveWordId(s.words, s.currentTime));

  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const selectionRef = useRef<SelectionInfo | null>(null);
  const updateSelection = useCallback((next: SelectionInfo | null) => {
    selectionRef.current = next;
    setSelection(next);
  }, []);
  const [correcting, setCorrecting] = useState<{
    ids: number[];
    top: number;
    left: number;
    containerWidth: number;
  } | null>(null);
  const [correctText, setCorrectText] = useState("");
  // Mirrors `correcting` so the selectionchange handler (which has its own
  // dependency list) can freeze the highlight while the popover is open.
  const correctingRef = useRef(false);

  const cuts = useMemo(
    () => getCutRanges(words, duration, manualCuts),
    [duration, manualCuts, words]
  );
  const keeps = useMemo(() => getKeepRanges(cuts, duration), [cuts, duration]);
  const turns = useMemo<SpeakerTurn[]>(() => {
    const out: SpeakerTurn[] = [];
    for (const w of words) {
      const included =
        !w.deleted &&
        keeps.some(
          (keep) => Math.min(w.end, keep.end) - Math.max(w.start, keep.start) > 1e-4
        );
      if (!included) continue;
      const last = out[out.length - 1];
      if (last && last.speaker === w.speaker) last.words.push(w);
      else out.push({ speaker: w.speaker, words: [w] });
    }
    return out;
  }, [keeps, words]);
  const includedWordIds = useMemo(
    () => new Set(turns.flatMap((turn) => turn.words.map((word) => word.id))),
    [turns]
  );
  useEffect(() => {
    const current = selectionRef.current;
    if (!current || current.ids.every((id) => includedWordIds.has(id))) return;
    window.getSelection()?.removeAllRanges();
    updateSelection(null);
  }, [includedWordIds, updateSelection]);

  const fillerIds = useMemo(
    () => findFillerWordIds(words).filter((id) => includedWordIds.has(id)),
    [includedWordIds, words]
  );
  const speakerChoices = useMemo(() => {
    const highest = words.reduce((maximum, word) => Math.max(maximum, word.speaker), 0);
    return Array.from({ length: highest + 2 }, (_, speaker) => speaker);
  }, [words]);

  const seekOutsideCurrentCuts = useCallback(() => {
    const state = useEditorStore.getState();
    const nextCuts = getCutRanges(
      state.words,
      state.duration,
      state.manualCuts
    );
    const activeCut = cutRangeAt(state.currentTime, nextCuts);
    if (!activeCut) return;

    const nextKeeps = getKeepRanges(nextCuts, state.duration);
    const following = nextKeeps.find(
      (keep) => keep.start >= activeCut.end - 1e-4
    );
    const preceding = [...nextKeeps]
      .reverse()
      .find((keep) => keep.end <= activeCut.start + 1e-4);
    const target = following
      ? Math.min(following.end, following.start + 0.001)
      : preceding
        ? Math.max(preceding.start, preceding.end - 0.001)
        : null;
    if (target === null) return;
    if (state.mediaEl) state.mediaEl.currentTime = target;
    state.setCurrentTime(target);
  }, []);

  const removeFillers = useCallback(() => {
    deleteWords(fillerIds);
    seekOutsideCurrentCuts();
  }, [deleteWords, fillerIds, seekOutsideCurrentCuts]);

  const seekToWord = useCallback((word: Word) => {
    const { mediaEl, setCurrentTime } = useEditorStore.getState();
    if (mediaEl) mediaEl.currentTime = word.start + 0.001;
    setCurrentTime(word.start + 0.001);
  }, []);

  const activateWord = useCallback((word: Word, element: HTMLElement) => {
    seekToWord(word);

    // Preserve drag/long-press range selection. A plain tap (including on
    // iOS, where spans are not focused automatically) focuses one word and
    // exposes the edit toolbar.
    const nativeSelection = window.getSelection();
    if (nativeSelection && !nativeSelection.isCollapsed) return;

    nativeSelection?.removeAllRanges();
    element.focus({ preventScroll: true });
    const containerRect = containerRef.current?.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    if (!containerRect) return;
    updateSelection({
      source: "focus",
      ids: [word.id],
      canCorrect: selectionCanBeCorrected(words, [word.id], cuts),
      top: rect.bottom - containerRect.top + 6,
      left: toolbarLeft(rect, containerRect),
    });
  }, [cuts, seekToWord, updateSelection, words]);

  const selectTurn = useCallback((turn: SpeakerTurn, element: HTMLElement) => {
    const containerRect = containerRef.current?.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    if (!containerRect) return;
    window.getSelection()?.removeAllRanges();
    const ids = turn.words.map((word) => word.id);
    updateSelection({
      source: "focus",
      ids,
      canCorrect: selectionCanBeCorrected(words, ids, cuts),
      top: rect.bottom - containerRect.top + 6,
      left: toolbarLeft(rect, containerRect),
    });
  }, [cuts, updateSelection, words]);

  // Track text selection over word spans, position the floating toolbar, and
  // paint our own (dimmed, gap-free) highlight by marking the selected spans.
  // The native ::selection highlight is made transparent over the words, and
  // the marking is done imperatively so dragging doesn't re-render the panel.
  const markedRef = useRef<Set<HTMLElement>>(new Set());
  useEffect(() => {
    const clearMarks = () => {
      for (const el of markedRef.current) el.removeAttribute("data-sel");
      markedRef.current.clear();
    };
    const handler = () => {
      // Keep the highlight frozen on the words being corrected.
      if (correctingRef.current) return;
      const container = containerRef.current;
      const sel = window.getSelection();
      if (!container || !sel || sel.isCollapsed || sel.rangeCount === 0) {
        clearMarks();
        if (selectionRef.current?.source === "range") updateSelection(null);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) {
        clearMarks();
        if (selectionRef.current?.source === "range") updateSelection(null);
        return;
      }
      const ids: number[] = [];
      const marked = new Set<HTMLElement>();
      container.querySelectorAll<HTMLElement>("[data-wid]").forEach((el) => {
        if (range.intersectsNode(el)) {
          const id = Number(el.dataset.wid);
          ids.push(id);
          el.setAttribute("data-sel", "");
          marked.add(el);
        }
      });
      for (const el of markedRef.current) {
        if (!marked.has(el)) el.removeAttribute("data-sel");
      }
      markedRef.current = marked;
      if (ids.length === 0) {
        if (selectionRef.current?.source === "range") updateSelection(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      updateSelection({
        source: "range",
        ids,
        canCorrect: selectionCanBeCorrected(words, ids, cuts),
        top: rect.bottom - containerRect.top + 6,
        left: toolbarLeft(rect, containerRect),
      });
    };
    document.addEventListener("selectionchange", handler);
    return () => {
      clearMarks();
      document.removeEventListener("selectionchange", handler);
    };
  }, [cuts, updateSelection, words]);

  const cutSelection = useCallback(() => {
    if (!selection) return;
    deleteWords(selection.ids);

    // A word tap seeks into that word. Move the parked frame out of the
    // newly removed range so the preview immediately matches the edit.
    seekOutsideCurrentCuts();

    window.getSelection()?.removeAllRanges();
    updateSelection(null);
  }, [selection, deleteWords, seekOutsideCurrentCuts, updateSelection]);

  const closeSelection = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    updateSelection(null);
  }, [updateSelection]);

  const openCorrect = useCallback(() => {
    if (!selection) return;
    const idSet = new Set(selection.ids);
    const text = words
      .filter((w) => idSet.has(w.id))
      .map((w) => w.text)
      .join(" ");
    correctingRef.current = true;
    setCorrectText(text);
    setCorrecting({
      ids: selection.ids,
      top: selection.top,
      left: selection.left,
      containerWidth: containerRef.current?.clientWidth ?? 640,
    });
    updateSelection(null);
    window.getSelection()?.removeAllRanges();
  }, [selection, words, updateSelection]);

  const closeCorrect = useCallback(() => {
    correctingRef.current = false;
    for (const el of markedRef.current) el.removeAttribute("data-sel");
    markedRef.current.clear();
    setCorrecting(null);
  }, []);

  const applyCorrection = useCallback(() => {
    if (!correcting) return;
    correctWords(correcting.ids, correctText);
    closeCorrect();
  }, [correcting, correctText, correctWords, closeCorrect]);

  // Close the correction popover when clicking outside of it.
  const popoverRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!correcting) return;
    const handler = (e: MouseEvent) => {
      if (!popoverRef.current?.contains(e.target as Node)) closeCorrect();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [correcting, closeCorrect]);

  // Delete / Backspace cuts the selected words.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
        return;
      if (!selection || selection.ids.length === 0) return;
      e.preventDefault();
      cutSelection();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [selection, cutSelection]);

  // Keep the active word in view during playback.
  useEffect(() => {
    if (!playing || activeWordId < 0) return;
    const el = containerRef.current?.querySelector(`[data-wid="${activeWordId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeWordId, playing]);

  const focusedWordIds = useMemo(
    () => selection?.source === "focus" ? new Set(selection.ids) : null,
    [selection]
  );
  const busy = status === "preparing" || status === "transcribing";

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-white">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-zinc-100 px-3 sm:px-4">
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Transcript
        </span>
        <div className="ml-auto flex items-center gap-2">
          {status === "ready" && (
            <span className="hidden text-xs text-zinc-400 md:inline">
              select words and press ⌫ to cut
            </span>
          )}
          {status === "ready" && fillerIds.length > 0 && (
            <button
              onClick={removeFillers}
              title='Cut filler words ("um", "uh", …) from the video'
              className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-zinc-500 transition hover:bg-zinc-100"
            >
              <WandSparkles size={14} />
              <span className="hidden sm:inline">Remove fillers </span>({fillerIds.length})
            </button>
          )}
          {status === "ready" && (
            <button
              type="button"
              role="switch"
              aria-checked={speakerDiarizationEnabled}
              onClick={() =>
                setSpeakerDiarizationEnabled(!speakerDiarizationEnabled)
              }
              title={
                speakerDiarizationEnabled
                  ? "Speaker detection is on for the next transcription"
                  : "Speaker detection is off; transcriptions use one speaker"
              }
              className={`flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs transition ${
                speakerDiarizationEnabled
                  ? "bg-violet-50 text-violet-700 hover:bg-violet-100"
                  : "text-zinc-500 hover:bg-zinc-100"
              }`}
            >
              <Users size={14} />
              <span className="hidden sm:inline">
                Speakers {speakerDiarizationEnabled ? "on" : "off"}
              </span>
            </button>
          )}
          {status === "ready" && (
            <button
              onClick={onTranscribe}
              title="Replace transcript with on-device transcription"
              className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-zinc-500 transition hover:bg-zinc-100"
            >
              <AudioLines size={14} />
              <span className="hidden sm:inline">Transcribe</span>
            </button>
          )}
          {status === "ready" && (
            <button
              onClick={onImportTranscript}
              title="Replace transcript from SRT, VTT, or JSON"
              className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-zinc-500 transition hover:bg-zinc-100"
            >
              <FileText size={14} />
              <span className="hidden sm:inline">Import</span>
            </button>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto">
        <div ref={containerRef} className="relative mx-auto max-w-2xl px-4 py-6 sm:px-8 sm:py-8">
          {busy && (
            <div className="flex flex-col items-start gap-4">
              <div className="w-full bg-zinc-50 p-2">
                <div className="flex items-center gap-2">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-500 border-t-transparent" />
                  <p className="text-sm font-medium text-zinc-700">
                    {progress?.message ?? "Working on device…"}
                  </p>
                  {progress?.ratio != null && (
                    <>
                      <div className="ml-auto h-1 w-[100px] overflow-hidden rounded-full bg-zinc-200">
                        <div
                          className="h-full rounded-full bg-neutral-500 transition-[width] duration-300"
                          style={{ width: `${progress.ratio * 100}%` }}
                        />
                      </div>
                      <span className="text-xs tabular-nums text-zinc-400">
                        {Math.round(progress.ratio * 100)}%
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-600">
              {error}
            </div>
          )}

          {status === "ready" && words.length === 0 && (
            <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-zinc-200 bg-zinc-50 p-6 text-center">
              <p className="text-sm font-medium text-zinc-700">This project has no transcript yet.</p>
              <div className="flex flex-wrap justify-center gap-2">
                <button onClick={onTranscribe} className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white">
                  Transcribe locally
                </button>
                <button onClick={onImportTranscript} className="rounded-full border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700">
                  Import transcript
                </button>
              </div>
            </div>
          )}

          {status === "ready" && words.length > 0 && turns.length === 0 && (
            <div className="flex min-h-48 items-center justify-center rounded-2xl border border-dashed border-zinc-200 bg-zinc-50 p-6 text-center">
              <p className="text-sm text-zinc-500">
                No words remain in this edit. Undo to restore them.
              </p>
            </div>
          )}

          {status === "ready" && turns.length > 0 && (
            <div className="transcript-words selection:bg-transparent">
              {turns.map((turn, i) => {
                return (
                  <div key={i} className="mb-7">
                    <button
                      type="button"
                      className="mb-1.5 rounded px-1 text-[13px] font-semibold transition hover:bg-zinc-100"
                      style={{ color: speakerColor(turn.speaker) }}
                      onClick={(event) => selectTurn(turn, event.currentTarget)}
                      title="Select this speaker turn"
                    >
                      Speaker {turn.speaker + 1}
                    </button>
                    <p className="select-text text-[15px] leading-8">
                      {turn.words.map((w) => (
                        <WordSpan
                          key={w.id}
                          word={w}
                          active={w.id === activeWordId}
                          focused={focusedWordIds?.has(w.id) ?? false}
                          onActivate={activateWord}
                        />
                      ))}
                    </p>
                  </div>
                );
              })}
            </div>
          )}

          {selection && !correcting && (
            <div
              className="selection-toolbar absolute z-20 flex max-w-[calc(100%-16px)] -translate-x-1/2 items-center gap-0.5 overflow-x-auto rounded-xl border border-zinc-200 bg-white p-1 shadow-lg shadow-zinc-900/10"
              style={{ top: selection.top, left: selection.left }}
              onMouseDown={(e) => e.preventDefault()}
            >
              <button
                onClick={cutSelection}
                title="Cut the selected words and their video section"
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-zinc-700 transition hover:bg-zinc-100"
              >
                <Scissors size={13} />
                Cut
              </button>
              {selection.canCorrect && (
                <button
                  onClick={openCorrect}
                  className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-zinc-700 transition hover:bg-zinc-100"
                >
                  <Pencil size={13} />
                  Correct
                </button>
              )}
              <select
                aria-label="Assign selected words to speaker"
                defaultValue=""
                onChange={(event) => {
                  const speaker = Number(event.target.value);
                  if (Number.isInteger(speaker)) assignSpeaker(selection.ids, speaker);
                  window.getSelection()?.removeAllRanges();
                  updateSelection(null);
                }}
                className="h-8 rounded-lg border-0 bg-zinc-100 px-2 text-xs font-medium text-zinc-700"
              >
                <option value="" disabled>Speaker…</option>
                {speakerChoices.map((speaker) => (
                  <option key={speaker} value={speaker}>Speaker {speaker + 1}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={closeSelection}
                title="Close word actions"
                aria-label="Close word actions"
                className="ml-0.5 flex h-5 w-5 shrink-0 self-start items-center justify-center rounded-md text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700"
              >
                <X size={11} />
              </button>
            </div>
          )}

          {correcting && (
            <div
              ref={popoverRef}
              className="absolute z-20 w-80 max-w-[calc(100%-16px)] -translate-x-1/2 rounded-2xl border border-zinc-200 bg-white p-3 shadow-xl shadow-zinc-900/10"
              style={{
                top: Math.max(4, correcting.top),
                left: Math.min(
                  Math.max(168, correcting.left),
                  correcting.containerWidth - 168
                ),
              }}
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[13px] font-semibold text-zinc-800">Correct</span>
                <button
                  onClick={closeCorrect}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700"
                >
                  <X size={13} />
                </button>
              </div>
              <input
                autoFocus
                value={correctText}
                onChange={(e) => setCorrectText(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyCorrection();
                  else if (e.key === "Escape") closeCorrect();
                }}
                className="w-full rounded-lg border border-zinc-300 bg-zinc-50 px-2.5 py-1.5 text-sm text-zinc-800 outline-none focus:border-zinc-500 focus:bg-white"
              />
              <div className="mt-2.5 flex justify-end">
                <button
                  onClick={applyCorrection}
                  disabled={correctText.trim().length === 0}
                  className="flex h-8 items-center rounded-full bg-zinc-900 px-4 text-[13px] font-medium text-white transition hover:bg-zinc-700 disabled:opacity-40"
                >
                  Correct
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
