import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  LocateFixed,
  Maximize2,
  Scissors,
  Trash2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useEditorStore } from "../editor/store";
import {
  canSplitAt,
  cutRangeAt,
  editedToOriginal,
  formatTime,
  getClipSegments,
  getCutRanges,
  getEditedDuration,
  getKeepRanges,
  originalToEdited,
  SPLIT_EPSILON,
} from "@rescript/core/edits";
import type { TimeRange, Word } from "@rescript/core";

const RULER_H = 18;
const WORDBAR_H = 28;
const TICK_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
/** Pixels-per-second below which word chips hide (too dense). */
const WORD_VIS_PPS = 22;
/** Pixels-per-second above which edge handles appear on words. */
const HANDLE_VIS_PPS = 40;
const MIN_ZOOM = 1;
const MAX_ZOOM = 256;
const TRACKPAD_ZOOM_SENSITIVITY = 0.01;
const DRAG_EDGE_SIZE = 48;

type DragKind =
  | { type: "seek" }
  | { type: "pan"; startClientX: number; startScrollLeft: number }
  | { type: "word"; wordId: number; edge: "start" | "end"; origStart: number; origEnd: number }
  | {
      type: "trim";
      clipIndex: number;
      edge: "in" | "out";
      origStart: number;
      origEnd: number;
      sourceCuts: TimeRange[];
      sourceEditedDuration: number;
      sourcePps: number;
      startClientX: number;
      startEditedTime: number;
      autoScrollOffset: number;
    };

type WebKitGestureEvent = Event & {
  clientX?: number;
  scale?: number;
};

function isPanGesture(event: ReactPointerEvent): boolean {
  return event.button === 1 || (event.button === 0 && event.shiftKey);
}

function isUnmodifiedPrimaryGesture(event: ReactPointerEvent): boolean {
  return (
    event.button === 0 &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  );
}

export default function Timeline() {
  const preparedMedia = useEditorStore((s) => s.preparedMedia);
  const words = useEditorStore((s) => s.words);
  const manualCuts = useEditorStore((s) => s.manualCuts);
  const sceneBoundaries = useEditorStore((s) => s.sceneBoundaries);
  const duration = useEditorStore((s) => s.duration);
  const currentTime = useEditorStore((s) => s.currentTime);
  const playing = useEditorStore((s) => s.playing);
  const selectedClipIndex = useEditorStore((s) => s.selectedClipIndex);
  const status = useEditorStore((s) => s.status);

  const cuts = useMemo(
    () => getCutRanges(words, duration, manualCuts),
    [words, duration, manualCuts]
  );
  const keeps = useMemo(() => getKeepRanges(cuts, duration), [cuts, duration]);
  const editedDuration = useMemo(
    () => getEditedDuration(cuts, duration),
    [cuts, duration]
  );
  const clips = useMemo(
    () => getClipSegments(keeps, sceneBoundaries),
    [keeps, sceneBoundaries]
  );
  const splitOk = useMemo(
    () => canSplitAt(currentTime, duration, cuts, sceneBoundaries),
    [currentTime, duration, cuts, sceneBoundaries]
  );
  const visibleSceneBoundaries = useMemo(
    () =>
      sceneBoundaries.filter((boundary) =>
        keeps.some(
          (keep) =>
            boundary.time > keep.start + SPLIT_EPSILON &&
            boundary.time < keep.end - SPLIT_EPSILON
        )
      ),
    [keeps, sceneBoundaries]
  );

  const outerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<DragKind | null>(null);
  const zoomViewRef = useRef({ zoom: 1, scrollLeft: 0 });
  const pendingZoomScrollRef = useRef<number | null>(null);
  const gestureRef = useRef<{ startZoom: number; clientX?: number } | null>(null);
  const previousTimeRef = useRef(currentTime);
  const dragPointerXRef = useRef<number | null>(null);
  const autoScrollFrameRef = useRef<number | null>(null);
  const touchTapRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    target: { type: "clip" } | { type: "boundary"; id: number };
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [panning, setPanning] = useState(false);
  const [splitFlash, setSplitFlash] = useState(false);
  const [gesturePps, setGesturePps] = useState<number | null>(null);

  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [hoveredWordId, setHoveredWordId] = useState<number | null>(null);
  const [hoveredClipIndex, setHoveredClipIndex] = useState<number | null>(null);
  const [selectedBoundaryId, setSelectedBoundaryId] = useState<number | null>(null);

  const fitPps = editedDuration > 0 && width > 0 ? width / editedDuration : 50;
  const pps = gesturePps ?? fitPps * zoom;
  const totalWidth = Math.max(width, editedDuration * pps);
  const ready = status === "ready" && duration > 0;

  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setWidth(el.clientWidth);
      setHeight(el.clientHeight);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const zoomTo = useCallback(
    (requestedZoom: number, clientX?: number) => {
      const el = scrollRef.current;
      if (!el || editedDuration <= 0 || fitPps <= 0) return;

      const rect = el.getBoundingClientRect();
      const viewportX =
        typeof clientX === "number" && Number.isFinite(clientX)
          ? Math.min(Math.max(0, clientX - rect.left), rect.width)
          : rect.width / 2;
      const view = zoomViewRef.current;
      const anchorTime = Math.min(
        editedDuration,
        Math.max(0, (view.scrollLeft + viewportX) / (fitPps * view.zoom))
      );
      const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, requestedZoom));
      if (nextZoom === view.zoom) return;

      const maxScrollLeft = Math.max(
        0,
        editedDuration * fitPps * nextZoom - el.clientWidth
      );
      const nextScrollLeft = Math.min(
        maxScrollLeft,
        Math.max(0, anchorTime * fitPps * nextZoom - viewportX)
      );

      zoomViewRef.current = { zoom: nextZoom, scrollLeft: nextScrollLeft };
      pendingZoomScrollRef.current = nextScrollLeft;
      setZoom(nextZoom);
      setScrollLeft(nextScrollLeft);
    },
    [editedDuration, fitPps]
  );

  const zoomBy = useCallback(
    (factor: number, clientX?: number) => {
      zoomTo(zoomViewRef.current.zoom * factor, clientX);
    },
    [zoomTo]
  );

  // Apply the focal-point-preserving scroll before the newly zoomed frame paints.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const pendingScrollLeft = pendingZoomScrollRef.current;
    if (!el || pendingScrollLeft === null) return;
    el.scrollLeft = pendingScrollLeft;
    pendingZoomScrollRef.current = null;
  }, [zoom, totalWidth]);

  // macOS trackpad pinch is exposed as ctrl+wheel in Chromium/Firefox and
  // proprietary gesture events in Safari. Cancel the browser zoom only while
  // the pointer is over the timeline and use that gesture for timeline zoom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !ready) return;

    const onWheel = (event: WheelEvent) => {
      const modeMultiplier =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? el.clientWidth
            : 1;

      if (event.ctrlKey) {
        event.preventDefault();
        if (gestureRef.current) return;
        const delta = event.deltaY * modeMultiplier;
        const exponent = Math.min(
          1,
          Math.max(-1, -delta * TRACKPAD_ZOOM_SENSITIVITY)
        );
        zoomBy(Math.exp(exponent), event.clientX);
        return;
      }

      // A vertical mouse wheel should move along this horizontal-only surface.
      // Trackpad horizontal deltas are handled here too so behavior is uniform.
      const rawDelta =
        Math.abs(event.deltaX) > Math.abs(event.deltaY)
          ? event.deltaX
          : event.deltaY;
      if (rawDelta === 0) return;
      const previousScrollLeft = el.scrollLeft;
      el.scrollLeft += rawDelta * modeMultiplier;
      if (el.scrollLeft !== previousScrollLeft) event.preventDefault();
    };

    const onGestureStart = (event: Event) => {
      event.preventDefault();
      const gesture = event as WebKitGestureEvent;
      gestureRef.current = {
        startZoom: zoomViewRef.current.zoom,
        clientX: gesture.clientX,
      };
    };

    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const start = gestureRef.current;
      const scale = (event as WebKitGestureEvent).scale;
      if (!start || typeof scale !== "number" || !Number.isFinite(scale)) return;
      zoomTo(start.startZoom * scale, start.clientX);
    };

    const onGestureEnd = (event: Event) => {
      event.preventDefault();
      gestureRef.current = null;
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart, { passive: false });
    el.addEventListener("gesturechange", onGestureChange, { passive: false });
    el.addEventListener("gestureend", onGestureEnd, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", onGestureEnd);
      gestureRef.current = null;
    };
  }, [ready, zoomBy, zoomTo]);

  // Draw the compact edited ruler, waveform, and clip tint for the visible window.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0 || height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const trackTop = RULER_H + WORDBAR_H;
    const trackH = height - trackTop;
    const midY = trackTop + trackH / 2;

    // Soft track wash
    ctx.fillStyle = "#fafafa";
    ctx.fillRect(0, trackTop, width, trackH);

    // Ruler
    ctx.fillStyle = "#a1a1aa";
    ctx.font = "9px ui-sans-serif, system-ui";
    ctx.textBaseline = "top";
    const step = TICK_STEPS.find((s) => s * pps >= 70) ?? TICK_STEPS[TICK_STEPS.length - 1];
    const firstTick = Math.floor(scrollLeft / pps / step) * step;
    for (let t = firstTick; t <= (scrollLeft + width) / pps + step; t += step) {
      const x = t * pps - scrollLeft;
      ctx.fillStyle = "#e4e4e7";
      ctx.fillRect(x, RULER_H - 6, 1, 6);
      ctx.fillStyle = "#a1a1aa";
      ctx.fillText(formatTime(t), x + 4, 3);
    }
    ctx.strokeStyle = "#f0f0f2";
    ctx.beginPath();
    ctx.moveTo(0, RULER_H - 0.5);
    ctx.lineTo(width, RULER_H - 0.5);
    ctx.stroke();

    // Wordbar lane background
    ctx.fillStyle = "#f4f4f5";
    ctx.fillRect(0, RULER_H, width, WORDBAR_H);
    ctx.strokeStyle = "#ececef";
    ctx.beginPath();
    ctx.moveTo(0, RULER_H + WORDBAR_H - 0.5);
    ctx.lineTo(width, RULER_H + WORDBAR_H - 0.5);
    ctx.stroke();

    if (
      !preparedMedia ||
      preparedMedia.waveform.length === 0 ||
      duration === 0 ||
      keeps.length === 0
    ) return;

    // Clip selection / hover washes on waveform
    for (const clip of clips) {
      const x0 = originalToEdited(clip.start, cuts) * pps - scrollLeft;
      const x1 = originalToEdited(clip.end, cuts) * pps - scrollLeft;
      if (x1 < 0 || x0 > width) continue;
      const selected = clip.index === selectedClipIndex;
      const hovered = clip.index === hoveredClipIndex && !selected;
      if (selected) {
        ctx.fillStyle = "rgba(99, 102, 241, 0.10)";
        ctx.fillRect(x0, trackTop, x1 - x0, trackH);
      } else if (hovered) {
        ctx.fillStyle = "rgba(99, 102, 241, 0.05)";
        ctx.fillRect(x0, trackTop, x1 - x0, trackH);
      }
    }

    // Waveform. Sample original media through the inverse edit map so removed
    // ranges occupy no space instead of lingering as red timeline tombstones.
    const bucketsPerPx = preparedMedia.waveformSamplesPerSecond / pps;
    let keepIndex = 0;
    let editedKeepStart = 0;
    for (let x = 0; x < width; x++) {
      const editedTime = (scrollLeft + x) / pps;
      if (editedTime > editedDuration) break;
      while (keepIndex < keeps.length - 1) {
        const keepLength = keeps[keepIndex].end - keeps[keepIndex].start;
        if (editedTime < editedKeepStart + keepLength) break;
        editedKeepStart += keepLength;
        keepIndex++;
      }
      const keep = keeps[keepIndex];
      const sourceTime = Math.min(
        keep.end,
        keep.start + Math.max(0, editedTime - editedKeepStart)
      );
      const i0 = Math.floor(sourceTime * preparedMedia.waveformSamplesPerSecond);
      const i1 = Math.min(
        preparedMedia.waveform.length,
        Math.max(i0 + 1, Math.ceil(i0 + bucketsPerPx))
      );
      let peak = 0;
      for (let index = i0; index < i1; index++) {
        peak = Math.max(peak, preparedMedia.waveform[index] ?? 0);
      }
      ctx.fillStyle = "#818cf8";
      const h = Math.max(1, peak * trackH * 0.86);
      ctx.fillRect(x, midY - h / 2, 1, h);
    }
  }, [
    preparedMedia,
    cuts,
    clips,
    duration,
    editedDuration,
    keeps,
    pps,
    scrollLeft,
    width,
    height,
    selectedClipIndex,
    hoveredClipIndex,
  ]);

  const scrollToTime = useCallback(
    (time: number, behavior: ScrollBehavior = "auto") => {
      const el = scrollRef.current;
      if (!el) return;
      const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
      const nextScrollLeft = Math.min(
        maxScrollLeft,
        Math.max(
          0,
          originalToEdited(time, cuts) * pps - el.clientWidth / 2
        )
      );
      el.scrollTo({ left: nextScrollLeft, behavior });
    },
    [cuts, pps]
  );

  // Keep the playhead visible while playing.
  useEffect(() => {
    if (!playing) return;
    const el = scrollRef.current;
    if (!el) return;
    const px = originalToEdited(currentTime, cuts) * pps;
    if (px < el.scrollLeft + 24 || px > el.scrollLeft + width - 96) {
      el.scrollLeft = Math.max(0, px - 96);
    }
  }, [currentTime, cuts, playing, pps, width]);

  // Paused seeks from the transcript or transport should never strand the
  // playhead outside the visible timeline window.
  useEffect(() => {
    const previousTime = previousTimeRef.current;
    previousTimeRef.current = currentTime;
    if (
      playing ||
      dragRef.current?.type === "seek" ||
      Math.abs(previousTime - currentTime) < 0.001
    ) {
      return;
    }
    const el = scrollRef.current;
    if (!el) return;
    const px = originalToEdited(currentTime, cuts) * pps;
    if (px < el.scrollLeft + 24 || px > el.scrollLeft + el.clientWidth - 24) {
      scrollToTime(currentTime);
    }
  }, [currentTime, cuts, playing, pps, scrollToTime]);

  const timeFromClientX = useCallback(
    (clientX: number) => {
      const el = scrollRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      const editedTime = Math.min(
        Math.max(0, (clientX - rect.left + el.scrollLeft) / pps),
        editedDuration
      );
      return editedToOriginal(editedTime, cuts, duration);
    },
    [cuts, duration, editedDuration, pps]
  );

  const seekTo = useCallback((t: number) => {
    const { mediaEl, setCurrentTime } = useEditorStore.getState();
    if (mediaEl) mediaEl.currentTime = t;
    setCurrentTime(t);
  }, []);

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
    if (target !== null) seekTo(target);
  }, [seekTo]);

  const focusTimeline = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    scrollRef.current?.focus({ preventScroll: true });
  }, []);

  const stopAutoScroll = useCallback(() => {
    dragPointerXRef.current = null;
    if (autoScrollFrameRef.current !== null) {
      cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = null;
    }
  }, []);

  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    stopAutoScroll();
    if (drag.type === "word" || drag.type === "trim") {
      useEditorStore.getState().endGesture();
    }
    if (drag.type === "trim") setGesturePps(null);
    dragRef.current = null;
    setDragging(false);
    setPanning(false);
  }, [stopAutoScroll]);

  useEffect(() => {
    const onUp = () => endDrag();
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      stopAutoScroll();
    };
  }, [endDrag, stopAutoScroll]);

  const updateDraggedValue = useCallback(
    (clientX: number) => {
      const drag = dragRef.current;
      if (!drag || drag.type === "pan") return;
      const store = useEditorStore.getState();

      if (drag.type === "seek") {
        seekTo(timeFromClientX(clientX));
      } else if (drag.type === "word") {
        const t = timeFromClientX(clientX);
        if (drag.edge === "start") {
          store.adjustWordBounds(drag.wordId, t, drag.origEnd);
        } else {
          store.adjustWordBounds(drag.wordId, drag.origStart, t);
        }
      } else {
        const editedTime = Math.min(
          drag.sourceEditedDuration,
          Math.max(
            0,
            drag.startEditedTime +
              (clientX - drag.startClientX + drag.autoScrollOffset) /
                drag.sourcePps
          )
        );
        const sourceTime = editedToOriginal(
          editedTime,
          drag.sourceCuts,
          duration
        );
        // Keep this gesture within the section that was selected at pointer
        // down. Crossing a compact cut seam would otherwise change clip
        // topology while a stale clip index is still being dragged.
        const t = Math.min(
          drag.origEnd,
          Math.max(drag.origStart, sourceTime)
        );
        store.trimClipEdge(drag.clipIndex, drag.edge, t);
        seekOutsideCurrentCuts();
      }
    },
    [duration, seekOutsideCurrentCuts, seekTo, timeFromClientX]
  );

  const scheduleAutoScroll = useCallback(
    (clientX: number) => {
      dragPointerXRef.current = clientX;
      if (autoScrollFrameRef.current !== null) return;

      const tick = () => {
        autoScrollFrameRef.current = null;
        const pointerX = dragPointerXRef.current;
        const drag = dragRef.current;
        const el = scrollRef.current;
        if (pointerX === null || !drag || drag.type === "pan" || !el) return;

        const rect = el.getBoundingClientRect();
        const edgeSize = Math.min(DRAG_EDGE_SIZE, rect.width / 4);
        let delta = 0;
        if (pointerX < rect.left + edgeSize) {
          const strength = Math.min(
            1,
            (rect.left + edgeSize - pointerX) / edgeSize
          );
          delta = -(4 + 24 * strength);
        } else if (pointerX > rect.right - edgeSize) {
          const strength = Math.min(
            1,
            (pointerX - (rect.right - edgeSize)) / edgeSize
          );
          delta = 4 + 24 * strength;
        }
        if (delta === 0) return;

        const previousScrollLeft = el.scrollLeft;
        el.scrollLeft += delta;
        if (el.scrollLeft === previousScrollLeft) return;
        if (drag.type === "trim") {
          drag.autoScrollOffset += el.scrollLeft - previousScrollLeft;
        }
        updateDraggedValue(pointerX);
        autoScrollFrameRef.current = requestAnimationFrame(tick);
      };

      autoScrollFrameRef.current = requestAnimationFrame(tick);
    },
    [updateDraggedValue]
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const touchTap = touchTapRef.current;
      if (
        touchTap?.pointerId === e.pointerId &&
        (Math.abs(e.clientX - touchTap.startClientX) > 8 ||
          Math.abs(e.clientY - touchTap.startClientY) > 8)
      ) {
        touchTapRef.current = null;
      }

      const drag = dragRef.current;
      if (!drag) {
        // Hover clip under cursor (waveform area)
        const t = timeFromClientX(e.clientX);
        const clip = clips.find((c) => t >= c.start && t < c.end);
        setHoveredClipIndex(clip?.index ?? null);
        return;
      }
      if (drag.type === "pan") {
        const el = scrollRef.current;
        if (el) {
          el.scrollLeft =
            drag.startScrollLeft - (e.clientX - drag.startClientX);
        }
        return;
      }

      updateDraggedValue(e.clientX);
      scheduleAutoScroll(e.clientX);
    },
    [clips, scheduleAutoScroll, timeFromClientX, updateDraggedValue]
  );

  const startPanDrag = useCallback(
    (e: ReactPointerEvent) => {
      const el = scrollRef.current;
      if (!el) return;
      e.stopPropagation();
      e.preventDefault();
      focusTimeline();
      stopAutoScroll();
      dragRef.current = {
        type: "pan",
        startClientX: e.clientX,
        startScrollLeft: el.scrollLeft,
      };
      setDragging(true);
      setPanning(true);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [focusTimeline, stopAutoScroll]
  );

  const onPanPointerDownCapture = useCallback(
    (e: ReactPointerEvent) => {
      if (isPanGesture(e)) startPanDrag(e);
    },
    [startPanDrag]
  );

  const selectClipAt = useCallback(
    (clientX: number) => {
      focusTimeline();
      const t = timeFromClientX(clientX);
      const clip = clips.find((candidate) => t >= candidate.start && t < candidate.end);
      useEditorStore.getState().setSelectedClipIndex(clip?.index ?? null);
      setSelectedBoundaryId(null);
      seekTo(t);
    },
    [clips, focusTimeline, seekTo, timeFromClientX]
  );

  const onBackgroundPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      // Ignore if pressing interactive chrome (handles / chips own their gesture).
      const target = e.target as HTMLElement;
      if (target.closest("[data-tl-interactive]")) return;

      if (e.pointerType === "touch") {
        // Let the browser keep native horizontal scrolling. A short tap selects
        // the clip on pointer-up; a pan clears this candidate in onPointerMove.
        touchTapRef.current = {
          pointerId: e.pointerId,
          startClientX: e.clientX,
          startClientY: e.clientY,
          target: { type: "clip" },
        };
        return;
      }
      if (!isUnmodifiedPrimaryGesture(e)) return;

      selectClipAt(e.clientX);
      dragRef.current = { type: "seek" };
      setDragging(true);
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [selectClipAt]
  );

  const onBackgroundPointerUp = useCallback(
    (e: ReactPointerEvent) => {
      const touchTap = touchTapRef.current;
      if (touchTap?.pointerId !== e.pointerId) return;
      touchTapRef.current = null;
      if (touchTap.target.type === "boundary") {
        focusTimeline();
        useEditorStore.getState().setSelectedClipIndex(null);
        setSelectedBoundaryId(touchTap.target.id);
      } else {
        selectClipAt(e.clientX);
      }
    },
    [focusTimeline, selectClipAt]
  );

  const onBackgroundPointerCancel = useCallback((e: ReactPointerEvent) => {
    if (touchTapRef.current?.pointerId === e.pointerId) {
      touchTapRef.current = null;
    }
  }, []);

  const startSeekDrag = useCallback(
    (e: ReactPointerEvent) => {
      if (isPanGesture(e)) {
        startPanDrag(e);
        return;
      }
      if (!isUnmodifiedPrimaryGesture(e)) return;
      e.stopPropagation();
      e.preventDefault();
      focusTimeline();
      dragRef.current = { type: "seek" };
      setDragging(true);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      seekTo(timeFromClientX(e.clientX));
    },
    [focusTimeline, seekTo, startPanDrag, timeFromClientX]
  );

  const onPlayheadKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 1 : 0.1;
      const editedCurrentTime = originalToEdited(currentTime, cuts);
      let nextEditedTime: number;
      if (e.key === "Home") {
        nextEditedTime = 0;
      } else if (e.key === "End") {
        nextEditedTime = editedDuration;
      } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        nextEditedTime = editedCurrentTime - step;
      } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        nextEditedTime = editedCurrentTime + step;
      } else {
        return;
      }
      nextEditedTime = Math.min(editedDuration, Math.max(0, nextEditedTime));
      const nextTime = editedToOriginal(nextEditedTime, cuts, duration);
      e.preventDefault();
      e.stopPropagation();
      seekTo(nextTime);
      scrollToTime(nextTime);
    },
    [currentTime, cuts, duration, editedDuration, scrollToTime, seekTo]
  );

  const startWordDrag = useCallback(
    (e: ReactPointerEvent, word: Word, edge: "start" | "end") => {
      if (
        e.pointerType === "touch" ||
        !isUnmodifiedPrimaryGesture(e)
      ) {
        return;
      }
      e.stopPropagation();
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      useEditorStore.getState().beginGesture();
      dragRef.current = {
        type: "word",
        wordId: word.id,
        edge,
        origStart: word.start,
        origEnd: word.end,
      };
      setDragging(true);
    },
    []
  );

  const startTrimDrag = useCallback(
    (e: ReactPointerEvent, clipIndex: number, edge: "in" | "out") => {
      if (
        e.pointerType === "touch" ||
        !isUnmodifiedPrimaryGesture(e)
      ) {
        return;
      }
      e.stopPropagation();
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      focusTimeline();
      const store = useEditorStore.getState();
      const clip = clips.find((candidate) => candidate.index === clipIndex);
      const el = scrollRef.current;
      if (!clip || !el) return;
      store.setSelectedClipIndex(clipIndex);
      store.beginGesture();
      const rect = el.getBoundingClientRect();
      dragRef.current = {
        type: "trim",
        clipIndex,
        edge,
        origStart: clip.start,
        origEnd: clip.end,
        sourceCuts: cuts.map((cut) => ({ ...cut })),
        sourceEditedDuration: editedDuration,
        sourcePps: pps,
        startClientX: e.clientX,
        startEditedTime: Math.min(
          editedDuration,
          Math.max(0, (e.clientX - rect.left + el.scrollLeft) / pps)
        ),
        autoScrollOffset: 0,
      };
      setGesturePps(pps);
      setDragging(true);
    },
    [clips, cuts, editedDuration, focusTimeline, pps]
  );

  const doSplit = useCallback(() => {
    const ok = useEditorStore.getState().splitAtPlayhead();
    if (!ok) return;
    setSplitFlash(true);
    window.setTimeout(() => setSplitFlash(false), 420);
  }, []);

  const deleteSelectedClip = useCallback(() => {
    if (selectedClipIndex === null) return false;
    const deletedClip = clips.find((clip) => clip.index === selectedClipIndex);
    if (!deletedClip) return false;

    const store = useEditorStore.getState();
    if (!store.deleteClip(selectedClipIndex)) return false;

    // Keep the preview parked on retained media after the selected section
    // collapses out of the edited timeline.
    seekOutsideCurrentCuts();
    setHoveredClipIndex(null);
    return true;
  }, [clips, seekOutsideCurrentCuts, selectedClipIndex]);

  const onTimelineKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!deleteSelectedClip()) return;
      e.preventDefault();
      e.stopPropagation();
    },
    [deleteSelectedClip]
  );

  // Compute compact word geometry only when edits change, then cheaply filter
  // that list as the mobile timeline scrolls.
  const wordSegments = useMemo(() => {
    let keepIndex = 0;
    return words.flatMap((word) => {
      if (word.deleted) return [];
      while (
        keepIndex < keeps.length &&
        keeps[keepIndex].end <= word.start + 1e-4
      ) {
        keepIndex++;
      }

      let visibleStart = 0;
      let visibleEnd = 0;
      let longestOverlap = 0;
      for (
        let index = keepIndex;
        index < keeps.length && keeps[index].start < word.end - 1e-4;
        index++
      ) {
        const start = Math.max(word.start, keeps[index].start);
        const end = Math.min(word.end, keeps[index].end);
        const overlap = end - start;
        if (overlap > longestOverlap) {
          longestOverlap = overlap;
          visibleStart = start;
          visibleEnd = end;
        }
      }
      if (longestOverlap <= 1e-4) return [];
      return [{
        word,
        visibleStart,
        displayStart: originalToEdited(visibleStart, cuts),
        displayEnd: originalToEdited(visibleEnd, cuts),
      }];
    });
  }, [cuts, keeps, words]);

  const visibleWords = useMemo(() => {
    if (pps < WORD_VIS_PPS) return [];
    const t0 = scrollLeft / pps - 1;
    const t1 = (scrollLeft + width) / pps + 1;
    return wordSegments.filter(
      (segment) => segment.displayEnd >= t0 && segment.displayStart <= t1
    );
  }, [pps, scrollLeft, width, wordSegments]);

  const playheadX = originalToEdited(currentTime, cuts) * pps - scrollLeft;
  const showHandles = pps >= HANDLE_VIS_PPS;

  return (
    <footer className="timeline-dock flex h-32 shrink-0 flex-col border-t border-zinc-200 bg-white sm:h-52">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-zinc-100 px-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Timeline
        </span>
        <span className="text-xs tabular-nums text-zinc-400">
          {formatTime(originalToEdited(currentTime, cuts))}
        </span>

        <div className="mx-auto flex items-center gap-1">
          {selectedBoundaryId !== null && (
            <button
              type="button"
              onClick={() => {
                useEditorStore.getState().removeSceneBoundary(selectedBoundaryId);
                setSelectedBoundaryId(null);
              }}
              className="flex h-8 items-center rounded-full bg-amber-50 px-3 text-xs font-semibold text-amber-700 transition hover:bg-amber-100"
              title="Join the clips on either side of this split"
            >
              Join split
            </button>
          )}
          {selectedClipIndex !== null && clips.length > 1 && (
            <button
              type="button"
              data-timeline-action
              onClick={deleteSelectedClip}
              className="flex h-8 items-center gap-1.5 rounded-full bg-zinc-900 px-2.5 text-xs font-semibold text-white shadow-sm transition hover:bg-zinc-700 active:scale-[0.97]"
              title="Delete the selected split section"
              aria-label="Delete selected timeline section"
            >
              <Trash2 size={13} />
              <span className="hidden sm:inline">Delete section</span>
            </button>
          )}
          <button
            type="button"
            disabled={!ready || !splitOk}
            onClick={doSplit}
            title={
              splitOk
                ? "Split clip at playhead (S)"
                : "Move the playhead onto a kept region to split"
            }
            className={`group relative hidden h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-all duration-200 sm:flex ${
              ready && splitOk
                ? "bg-zinc-900 text-white shadow-sm shadow-zinc-900/10 hover:bg-zinc-800 active:scale-[0.97]"
                : "cursor-not-allowed bg-zinc-100 text-zinc-400"
            } ${splitFlash ? "tl-split-flash" : ""}`}
          >
            <Scissors
              size={13}
              className={`transition-transform duration-300 ${
                splitFlash ? "rotate-[-18deg] scale-110" : "group-hover:rotate-[-8deg]"
              }`}
            />
            Split
            <kbd
              className={`ml-0.5 rounded px-1 py-px text-[10px] font-normal ${
                ready && splitOk
                  ? "bg-white/15 text-zinc-200"
                  : "bg-zinc-200/80 text-zinc-400"
              }`}
            >
              S
            </kbd>
          </button>
        </div>

        <div className="flex items-center gap-0.5">
          <button
            type="button"
            disabled={!ready || !splitOk}
            onClick={doSplit}
            title={
              splitOk
                ? "Split clip at playhead (S)"
                : "Move the playhead onto a kept region to split"
            }
            aria-label="Split clip at playhead"
            className={`group relative flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition-all duration-200 hover:bg-zinc-100 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent sm:hidden ${
              splitFlash ? "tl-split-flash" : ""
            }`}
          >
            <Scissors
              size={14}
              className={`transition-transform duration-300 ${
                splitFlash ? "rotate-[-18deg] scale-110" : ""
              }`}
            />
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={() => scrollToTime(currentTime, "smooth")}
            title="Center the playhead"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <LocateFixed size={13} />
          </button>
          <button
            type="button"
            onClick={() => zoomBy(1 / 1.5)}
            title="Zoom out (or pinch on the timeline)"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100"
          >
            <ZoomOut size={14} />
          </button>
          <button
            type="button"
            onClick={() => zoomTo(MIN_ZOOM)}
            title="Fit"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100"
          >
            <Maximize2 size={13} />
          </button>
          <button
            type="button"
            onClick={() => zoomBy(1.5)}
            title="Zoom in (or pinch on the timeline) — drag word edges to refine timing"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100"
          >
            <ZoomIn size={14} />
          </button>
        </div>
      </div>

      <div ref={outerRef} className="relative min-h-0 flex-1">
        <canvas
          ref={canvasRef}
          className="pointer-events-none absolute inset-0 h-full w-full"
        />

        <div
          ref={scrollRef}
          onScroll={(e) => {
            touchTapRef.current = null;
            const nextScrollLeft = e.currentTarget.scrollLeft;
            zoomViewRef.current.scrollLeft = nextScrollLeft;
            setScrollLeft(nextScrollLeft);
          }}
          tabIndex={ready ? 0 : -1}
          aria-label="Timeline. Tap or click a split section to select it. Drag to scrub. Use the mouse wheel, trackpad, Shift-drag, or middle-drag to pan."
          title="Drag to scrub · Wheel, trackpad, Shift-drag, or middle-drag to pan"
          onKeyDown={onTimelineKeyDown}
          onBlur={(e) => {
            const nextTarget = e.relatedTarget as HTMLElement | null;
            if (
              e.currentTarget.contains(nextTarget) ||
              nextTarget?.closest("[data-timeline-action]")
            ) {
              return;
            }
            // Mobile Safari can report a null relatedTarget before dispatching
            // the button click. Defer clearing so the visible delete action
            // remains mounted long enough to receive that click.
            window.setTimeout(() => {
              const active = document.activeElement as HTMLElement | null;
              if (!active?.closest("[data-timeline-action]")) {
                useEditorStore.getState().setSelectedClipIndex(null);
              }
            }, 0);
          }}
          onPointerDownCapture={onPanPointerDownCapture}
          onPointerDown={onBackgroundPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onBackgroundPointerUp}
          onPointerCancel={onBackgroundPointerCancel}
          className="timeline-scroll scrollbar-thin absolute inset-0 overflow-x-auto overflow-y-hidden select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400/60"
          style={{
            cursor: panning ? "grabbing" : dragging ? "col-resize" : "default",
          }}
        >
          <div className="relative h-full" style={{ width: totalWidth }}>
            {/* Scene boundary markers */}
            {visibleSceneBoundaries.map((b) => {
              const x = originalToEdited(b.time, cuts) * pps;
              return (
                <button
                  type="button"
                  key={b.id}
                  data-tl-interactive
                  className={`tl-boundary group/boundary absolute top-0 bottom-0 z-[5] w-3 -translate-x-1/2 cursor-pointer focus-visible:outline-none ${selectedBoundaryId === b.id ? "drop-shadow-md" : ""}`}
                  style={{ left: x }}
                  aria-label={`Scene split at ${formatTime(originalToEdited(b.time, cuts))}. Press Delete to join clips.`}
                  title="Scene split — press Delete or double-click to join"
                  onKeyDown={(e) => {
                    if (
                      (e.key !== "Delete" && e.key !== "Backspace") ||
                      e.metaKey ||
                      e.ctrlKey ||
                      e.altKey
                    ) {
                      return;
                    }
                    e.preventDefault();
                    e.stopPropagation();
                    useEditorStore.getState().removeSceneBoundary(b.id);
                    setSelectedBoundaryId(null);
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    useEditorStore.getState().removeSceneBoundary(b.id);
                    setSelectedBoundaryId(null);
                  }}
                  onPointerDown={(e) => {
                    if (e.pointerType === "touch") {
                      touchTapRef.current = {
                        pointerId: e.pointerId,
                        startClientX: e.clientX,
                        startClientY: e.clientY,
                        target: { type: "boundary", id: b.id },
                      };
                      return;
                    }
                    e.stopPropagation();
                    setSelectedBoundaryId(b.id);
                    e.currentTarget.focus({ preventScroll: true });
                  }}
                >
                  <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-amber-400/80 transition group-hover/boundary:bg-amber-500 group-focus-visible/boundary:bg-amber-600" />
                  <div className="absolute top-[3px] left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 rounded-[1px] bg-amber-400 shadow-sm shadow-amber-500/30 transition group-hover/boundary:scale-125 group-hover/boundary:bg-amber-500 group-focus-visible/boundary:scale-125 group-focus-visible/boundary:bg-amber-600 group-focus-visible/boundary:ring-2 group-focus-visible/boundary:ring-amber-300" />
                </button>
              );
            })}

            {/* Clip trim handles (selected or hovered) */}
            {clips.map((clip) => {
              const active =
                clip.index === selectedClipIndex || clip.index === hoveredClipIndex;
              if (!active) return null;
              const selected = clip.index === selectedClipIndex;
              return (
                <div key={`trim-${clip.id}`}>
                  <div
                    data-tl-interactive
                    onPointerDown={(e) => startTrimDrag(e, clip.index, "in")}
                    className="tl-trim-handle absolute z-[6] -translate-x-1/2 cursor-ew-resize"
                    style={{
                      left: originalToEdited(clip.start, cuts) * pps,
                      top: RULER_H + WORDBAR_H + 4,
                      bottom: 4,
                      opacity: selected ? 1 : 0.7,
                    }}
                    title="Trim clip start"
                  >
                    <div
                      className={`h-full w-1 rounded-full transition-all duration-150 ${
                        selected
                          ? "bg-indigo-500 shadow-[0_0_0_3px_rgba(99,102,241,0.2)]"
                          : "bg-indigo-400/80"
                      }`}
                    />
                  </div>
                  <div
                    data-tl-interactive
                    onPointerDown={(e) => startTrimDrag(e, clip.index, "out")}
                    className="tl-trim-handle absolute z-[6] -translate-x-1/2 cursor-ew-resize"
                    style={{
                      left: originalToEdited(clip.end, cuts) * pps,
                      top: RULER_H + WORDBAR_H + 4,
                      bottom: 4,
                      opacity: selected ? 1 : 0.7,
                    }}
                    title="Trim clip end"
                  >
                    <div
                      className={`h-full w-1 rounded-full transition-all duration-150 ${
                        selected
                          ? "bg-indigo-500 shadow-[0_0_0_3px_rgba(99,102,241,0.2)]"
                          : "bg-indigo-400/80"
                      }`}
                    />
                  </div>
                  {selected && (
                    <div
                      className="pointer-events-none absolute z-[4] rounded-sm ring-1 ring-indigo-400/40"
                      style={{
                        left: originalToEdited(clip.start, cuts) * pps,
                        width: Math.max(
                          2,
                          (originalToEdited(clip.end, cuts) -
                            originalToEdited(clip.start, cuts)) *
                            pps
                        ),
                        top: RULER_H + WORDBAR_H + 2,
                        bottom: 2,
                      }}
                    />
                  )}
                </div>
              );
            })}

            {/* Wordbar chips */}
            {visibleWords.map(({ word: w, visibleStart, displayStart, displayEnd }) => {
              const wWidth = Math.max(6, (displayEnd - displayStart) * pps - 1);
              const hovered = hoveredWordId === w.id;
              const showWordHandles = showHandles && (hovered || wWidth > 28);
              return (
                <div
                  key={w.id}
                  data-tl-interactive
                  className={`tl-word absolute z-[3] flex items-center overflow-hidden rounded-md border text-[10px] leading-none transition-[box-shadow,background-color,border-color] duration-150 ${
                    hovered
                      ? "border-indigo-300 bg-white text-zinc-700 shadow-sm shadow-indigo-500/10"
                      : "border-zinc-200/90 bg-white/95 text-zinc-600"
                  }`}
                  style={{
                    left: displayStart * pps,
                    top: RULER_H + 5,
                    width: wWidth,
                    height: WORDBAR_H - 10,
                  }}
                  title={
                    showHandles
                      ? `${w.text} — drag edges to adjust timing`
                      : w.text
                  }
                  onPointerEnter={() => setHoveredWordId(w.id)}
                  onPointerLeave={() =>
                    setHoveredWordId((id) => (id === w.id ? null : id))
                  }
                  onPointerDown={(e) => {
                    // Tapping the chip body selects its split section. Mouse
                    // dragging its edge continues to refine word timing.
                    if ((e.target as HTMLElement).dataset.edge) return;
                    if (e.pointerType === "touch") {
                      touchTapRef.current = {
                        pointerId: e.pointerId,
                        startClientX: e.clientX,
                        startClientY: e.clientY,
                        target: { type: "clip" },
                      };
                      return;
                    }
                    if (!isUnmodifiedPrimaryGesture(e)) return;
                    e.stopPropagation();
                    e.preventDefault();
                    focusTimeline();
                    seekTo(visibleStart);
                    const clip = clips.find(
                      (candidate) =>
                        visibleStart >= candidate.start && visibleStart < candidate.end
                    );
                    useEditorStore
                      .getState()
                      .setSelectedClipIndex(clip?.index ?? null);
                    setSelectedBoundaryId(null);
                  }}
                >
                  <span className="pointer-events-none min-w-0 flex-1 truncate px-1.5">
                    {w.text}
                  </span>
                  {showWordHandles && (
                    <>
                      <span
                        data-edge="start"
                        data-tl-interactive
                        onPointerDown={(e) => startWordDrag(e, w, "start")}
                        className="tl-word-handle absolute inset-y-0 left-0 z-10 w-1.5 cursor-ew-resize"
                      >
                        <span
                          className={`absolute inset-y-1 left-0 w-0.5 rounded-full transition-all duration-150 ${
                            hovered
                              ? "bg-indigo-500 opacity-100"
                              : "bg-zinc-300 opacity-0 group-hover:opacity-100"
                          }`}
                          style={{ opacity: hovered ? 1 : 0.55 }}
                        />
                      </span>
                      <span
                        data-edge="end"
                        data-tl-interactive
                        onPointerDown={(e) => startWordDrag(e, w, "end")}
                        className="tl-word-handle absolute inset-y-0 right-0 z-10 w-1.5 cursor-ew-resize"
                      >
                        <span
                          className="absolute inset-y-1 right-0 w-0.5 rounded-full bg-indigo-500 transition-opacity duration-150"
                          style={{ opacity: hovered ? 1 : 0.55 }}
                        />
                      </span>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {playheadX >= -2 && playheadX <= width + 2 && (
          <div
            data-tl-interactive
            role="slider"
            tabIndex={ready ? 0 : -1}
            aria-label="Timeline playhead"
            aria-valuemin={0}
            aria-valuemax={editedDuration}
            aria-valuenow={originalToEdited(currentTime, cuts)}
            aria-valuetext={formatTime(originalToEdited(currentTime, cuts))}
            className="absolute top-0 bottom-0 z-20 w-4 -translate-x-1/2 cursor-ew-resize touch-none focus-visible:outline-2 focus-visible:outline-indigo-500"
            style={{ left: playheadX }}
            title="Drag the playhead to scrub"
            onPointerDown={startSeekDrag}
            onPointerMove={onPointerMove}
            onKeyDown={onPlayheadKeyDown}
          >
            <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-zinc-900/90" />
            <div className="pointer-events-none absolute -top-px left-1/2 h-2.5 w-2.5 -translate-x-1/2 rounded-sm bg-zinc-900 shadow-sm shadow-zinc-900/30 [clip-path:polygon(0_0,100%_0,100%_55%,50%_100%,0_55%)]" />
            {splitOk && (
              <div className="tl-playhead-split pointer-events-none absolute top-[22px] left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-amber-400 shadow-[0_0_0_3px_rgba(251,191,36,0.25)]" />
            )}
          </div>
        )}

        {pps < WORD_VIS_PPS && ready && (
          <div className="pointer-events-none absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-full bg-zinc-900/70 px-2.5 py-1 text-[10px] text-white/90 backdrop-blur-sm transition-opacity">
            Zoom in to edit word timing
          </div>
        )}
      </div>
    </footer>
  );
}
