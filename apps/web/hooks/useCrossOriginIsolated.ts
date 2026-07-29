"use client";

import { useSyncExternalStore } from "react";

export type IsolationState = "checking" | "preparing" | "ready" | "unavailable";

/** How long to wait for the COI service worker to take over before giving up. */
const PREPARE_TIMEOUT_MS = 10_000;

function isIsolated() {
  return self.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined";
}

// Module-level store: isolation is a property of the page, not of any component,
// and it only ever moves from "checking" to a settled value once.
let state: IsolationState = "checking";
const listeners = new Set<() => void>();
let watching = false;

function emit(next: IsolationState) {
  if (state === next) return;
  state = next;
  for (const listener of listeners) listener();
}

function watch() {
  if (isIsolated()) return emit("ready");
  // A service worker already controlling an un-isolated page means the worker
  // cannot fix this (insecure context, stripped headers, or a browser without
  // SharedArrayBuffer) — waiting for a reload that never comes is worse than
  // saying so.
  const sw = navigator.serviceWorker;
  if (!window.isSecureContext || !sw || sw.controller) return emit("unavailable");

  emit("preparing");
  // coi-serviceworker reloads as soon as it takes control, so normally the page
  // goes away before this resolves. Poll anyway — the reload can be blocked (or
  // skipped by a future version) and we still want to notice isolation.
  let waited = 0;
  const timer = setInterval(() => {
    waited += 250;
    if (isIsolated()) {
      clearInterval(timer);
      emit("ready");
    } else if (waited >= PREPARE_TIMEOUT_MS) {
      clearInterval(timer);
      emit("unavailable");
    }
  }, 250);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!watching) {
    watching = true;
    watch();
  }
  return () => listeners.delete(listener);
}

/**
 * Reports whether the page can use SharedArrayBuffer, which ffmpeg.wasm and
 * onnxruntime both require for multi-threading.
 *
 * On static hosts isolation comes from public/coi-serviceworker.js, which
 * registers itself and then reloads the page — so on a first visit the app is
 * briefly interactive *without* isolation. Anything started in that window dies
 * with "SharedArrayBuffer is not defined" (and loses its work to the reload),
 * so the UI waits for "ready" before touching the pipeline.
 */
export function useCrossOriginIsolated(): IsolationState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => "checking" as IsolationState
  );
}
