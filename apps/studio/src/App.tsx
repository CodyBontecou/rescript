import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Effect, Option, Stream } from "effect";
import {
  chooseExportDestination,
  chooseMediaAndCreateProject,
  chooseTranscript,
  exportMedia,
  listProjects,
  prepareMedia,
  projectPlaybackSource,
  readProject,
  reconnectMediaExport,
  reconnectMediaPreparation,
  reconnectTranscriptionJob,
  releasePlaybackSource,
  removeProject,
  saveProject,
  transcribeProject,
  type RunningJob,
} from "@rescript/workflows";
import { TauriPlatformLive } from "@rescript/platform-tauri";
import {
  DEFAULT_SPEAKER_DIARIZATION_ENABLED,
  DEFAULT_TRANSCRIPTION_MODEL,
  type JobProgress,
  type PlaybackSource,
  type PreparedMedia,
  type ProjectManifest,
  type ProjectSummary,
  type TranscriptionModel,
  type Word,
} from "@rescript/core";
import { getCutRanges, getKeepRanges } from "@rescript/core/edits";
import HomeScreen from "./components/HomeScreen";
import { flushProjectAutosave } from "./editor/autosave";
import { useEditorStore } from "./editor/store";
import {
  LOCKED_EXPORT_ENTITLEMENT,
  UNLOCKED_EXPORT_ENTITLEMENT,
  getExportEntitlement,
  isPurchaseRequired,
  listenForExportEntitlementChanges,
  purchaseUnlimitedExports,
  restoreExportPurchases,
  type ExportEntitlementState,
  type ExportPurchaseResult,
} from "./export-entitlement";
import { PendingExportCoordinator } from "./pending-export";
import "./styles.css";

interface PlatformInfo {
  os: string;
  arch: string;
  mobile: boolean;
}

type PersistedJob = {
  jobId: string;
  projectId: string;
  revision: number;
  kind: "prepare" | "transcription" | "export";
  model?: TranscriptionModel;
};

const ACTIVE_JOB_KEY = "rescript.activeNativeJob.v1";
const MODEL_PREFERENCE_KEY = "rescript.native:model";
const DIARIZATION_PREFERENCE_KEY = "rescript.native:speaker-diarization";
const EditorShell = lazy(() => import("./components/EditorShell"));

function isTranscriptionModel(value: unknown): value is TranscriptionModel {
  return (
    value === "base" ||
    value === "small" ||
    value === "parakeet-v2" ||
    value === "parakeet-v3"
  );
}

function saveModelPreference(model: TranscriptionModel) {
  try {
    localStorage.setItem(MODEL_PREFERENCE_KEY, model);
  } catch {
    // Private storage modes should not block transcription.
  }
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  if (cause && typeof cause === "object") {
    const record = cause as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    try {
      return JSON.stringify(cause);
    } catch {
      // Keep the fallback.
    }
  }
  return "The operation failed";
}

function isTerminal(progress: JobProgress): boolean {
  return (
    progress.status === "completed" ||
    progress.status === "failed" ||
    progress.status === "cancelled"
  );
}

export default function App() {
  const [platform, setPlatform] = useState<PlatformInfo | null>(null);
  const [projects, setProjects] = useState<readonly ProjectSummary[]>([]);
  const [homeModel, setHomeModel] = useState<TranscriptionModel>(
    DEFAULT_TRANSCRIPTION_MODEL
  );
  const [homeSpeakerDiarizationEnabled, setHomeSpeakerDiarizationEnabled] =
    useState(DEFAULT_SPEAKER_DIARIZATION_ENABLED);
  const [homeBusy, setHomeBusy] = useState(false);
  const [homeError, setHomeError] = useState<string | null>(null);
  const [exportEntitlement, setExportEntitlement] =
    useState<ExportEntitlementState>(UNLOCKED_EXPORT_ENTITLEMENT);
  const [exportAccessChecking, setExportAccessChecking] = useState(false);
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [purchaseBusy, setPurchaseBusy] = useState(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const [purchaseMessage, setPurchaseMessage] = useState<string | null>(null);
  const manifest = useEditorStore((state) => state.manifest);
  const operationToken = useRef(0);
  const playbackRef = useRef<PlaybackSource | null>(null);
  const pendingExport = useRef(new PendingExportCoordinator());
  const entitlementCheckInProgress = useRef(false);
  const purchaseOperationInProgress = useRef(false);

  function ownsOperation(token: number, projectId: string, jobId?: string): boolean {
    const state = useEditorStore.getState();
    return (
      operationToken.current === token &&
      state.manifest?.id === projectId &&
      (jobId === undefined || state.activeJobId === jobId)
    );
  }

  function clearJobBookmark(jobId: string): void {
    const raw = localStorage.getItem(ACTIVE_JOB_KEY);
    if (!raw) return;
    try {
      const current = JSON.parse(raw) as Partial<PersistedJob>;
      if (current.jobId === jobId) localStorage.removeItem(ACTIVE_JOB_KEY);
    } catch {
      localStorage.removeItem(ACTIVE_JOB_KEY);
    }
  }

  useEffect(() => {
    try {
      const saved = localStorage.getItem(MODEL_PREFERENCE_KEY);
      if (isTranscriptionModel(saved)) setHomeModel(saved);
      const savedDiarization = localStorage.getItem(DIARIZATION_PREFERENCE_KEY);
      if (savedDiarization === "true" || savedDiarization === "false") {
        setHomeSpeakerDiarizationEnabled(savedDiarization === "true");
      }
    } catch {
      // Keep the shared default when local storage is unavailable.
    }
    return useEditorStore.subscribe((state, previous) => {
      if (
        state.manifest &&
        state.model !== previous.model
      ) {
        setHomeModel(state.model);
        saveModelPreference(state.model);
      }
    });
  }, []);

  useEffect(() => {
    if (!isTauri()) {
      setHomeError("Run Rescript through Tauri to use native projects.");
      return;
    }
    void invoke<PlatformInfo>("platform_info").then(setPlatform).catch((cause) => {
      setHomeError(messageOf(cause));
    });
    void refreshProjects();
    void resumePersistedJob();
  }, []);

  useEffect(() => {
    if (!platform) return;
    if (platform.os !== "ios") {
      setExportEntitlement(UNLOCKED_EXPORT_ENTITLEMENT);
      return;
    }

    let active = true;
    let unregister: (() => Promise<void>) | null = null;
    const accept = (state: ExportEntitlementState) => {
      if (!active) return;
      setExportEntitlement(state);
      if (state.entitled && document.visibilityState === "visible") {
        resumePendingExport(state);
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshExportEntitlement();
      }
    };

    setExportEntitlement(LOCKED_EXPORT_ENTITLEMENT);
    void refreshExportEntitlement();
    void listenForExportEntitlementChanges(accept)
      .then((cleanup) => {
        if (active) unregister = cleanup;
        else void cleanup();
      })
      .catch((cause) => {
        if (active) setPurchaseError(messageOf(cause));
      });
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (unregister) void unregister();
    };
  }, [platform?.os]);

  useEffect(() => {
    return () => {
      const playback = playbackRef.current;
      if (playback) {
        void Effect.runPromise(
          releasePlaybackSource(playback).pipe(Effect.provide(TauriPlatformLive))
        ).catch(() => undefined);
      }
    };
  }, []);

  async function resumePersistedJob() {
    const raw = localStorage.getItem(ACTIVE_JOB_KEY);
    if (!raw) return;
    let persisted: PersistedJob;
    try {
      persisted = JSON.parse(raw) as PersistedJob;
      if (
        !persisted.jobId ||
        !persisted.projectId ||
        !["prepare", "transcription", "export"].includes(persisted.kind)
      ) {
        throw new Error("Invalid native job bookmark");
      }
    } catch {
      localStorage.removeItem(ACTIVE_JOB_KEY);
      return;
    }

    const token = ++operationToken.current;
    let terminalSeen = false;
    try {
      const project = Option.getOrThrow(
        await Effect.runPromise(
          readProject(persisted.projectId).pipe(Effect.provide(TauriPlatformLive))
        )
      );
      if (operationToken.current !== token) return;
      const playback = await Effect.runPromise(
        projectPlaybackSource(project.id).pipe(Effect.provide(TauriPlatformLive))
      );
      if (operationToken.current !== token) {
        await Effect.runPromise(
          releasePlaybackSource(playback).pipe(Effect.provide(TauriPlatformLive))
        ).catch(() => undefined);
        return;
      }
      playbackRef.current = playback;
      const store = useEditorStore.getState();
      store.loadProject(project, { playback });
      store.setStatus(
        persisted.kind === "prepare"
          ? "preparing"
          : persisted.kind === "transcription"
            ? "transcribing"
            : "exporting"
      );

      if (persisted.kind === "prepare") {
        const running = await Effect.runPromise(
          reconnectMediaPreparation(persisted.jobId).pipe(
            Effect.provide(TauriPlatformLive)
          )
        );
        const terminal = await consumeJob(running, persisted, token);
        terminalSeen = terminal !== null && isTerminal(terminal);
        if (!ownsOperation(token, project.id, running.jobId)) return;
        if (assertCompleted(terminal)) {
          const prepared = Option.getOrThrow(await Effect.runPromise(running.result));
          if (!ownsOperation(token, project.id, running.jobId)) return;
          let saved = project;
          if (Math.abs(saved.duration - prepared.duration) > 0.001) {
            saved = await Effect.runPromise(
              saveProject({ ...saved, duration: prepared.duration }).pipe(
                Effect.provide(TauriPlatformLive)
              )
            );
          }
          if (!ownsOperation(token, project.id, running.jobId)) return;
          store.loadProject(saved, { preparedMedia: prepared, playback });
        }
      } else if (persisted.kind === "transcription") {
        const running = await Effect.runPromise(
          reconnectTranscriptionJob(persisted.jobId).pipe(
            Effect.provide(TauriPlatformLive)
          )
        );
        const terminal = await consumeJob(running, persisted, token);
        terminalSeen = terminal !== null && isTerminal(terminal);
        if (!ownsOperation(token, project.id, running.jobId)) return;
        if (assertCompleted(terminal)) {
          const words = normalizeWords(
            Option.getOrThrow(await Effect.runPromise(running.result)),
            project.duration
          );
          if (!ownsOperation(token, project.id, running.jobId)) return;
          store.replaceTranscript(
            words,
            persisted.model ??
              (project.model === "import"
                ? DEFAULT_TRANSCRIPTION_MODEL
                : project.model)
          );
          await flushProjectAutosave();
        }
      } else {
        const running = await Effect.runPromise(
          reconnectMediaExport(persisted.jobId).pipe(
            Effect.provide(TauriPlatformLive)
          )
        );
        const terminal = await consumeJob(running, persisted, token);
        terminalSeen = terminal !== null && isTerminal(terminal);
        if (!ownsOperation(token, project.id, running.jobId)) return;
        if (assertCompleted(terminal)) {
          const result = Option.getOrThrow(await Effect.runPromise(running.result));
          if (!ownsOperation(token, project.id, running.jobId)) return;
          store.setExportResult(result);
          store.setExportOpen(true);
        }
      }
    } catch (cause) {
      if (operationToken.current === token) {
        useEditorStore.getState().setError(`Recovered job: ${messageOf(cause)}`);
      }
    } finally {
      if (terminalSeen) clearJobBookmark(persisted.jobId);
      if (operationToken.current === token) {
        const store = useEditorStore.getState();
        store.setActiveJob(null);
        store.setProgress(null);
        if (store.manifest?.id === persisted.projectId) store.setStatus("ready");
        await refreshProjects();
      }
    }
  }

  async function refreshProjects() {
    if (!isTauri()) return;
    try {
      setProjects(
        await Effect.runPromise(listProjects.pipe(Effect.provide(TauriPlatformLive)))
      );
    } catch (cause) {
      setHomeError(messageOf(cause));
    }
  }

  async function releaseCurrentPlayback() {
    const playback = playbackRef.current;
    playbackRef.current = null;
    if (!playback) return;
    await Effect.runPromise(
      releasePlaybackSource(playback).pipe(Effect.provide(TauriPlatformLive))
    ).catch(() => undefined);
  }

  async function consumeJob(
    job: RunningJob,
    persisted: Omit<PersistedJob, "jobId">,
    token: number
  ): Promise<JobProgress | null> {
    const store = useEditorStore.getState();
    localStorage.setItem(
      ACTIVE_JOB_KEY,
      JSON.stringify({ ...persisted, jobId: job.jobId } satisfies PersistedJob)
    );
    store.setActiveJob(job.jobId, async () => {
      await Effect.runPromise(job.cancel);
    });

    let terminal: JobProgress | null = null;
    await Effect.runPromise(
      Stream.runForEach(job.progress, (progress) =>
        Effect.sync(() => {
          terminal = progress;
          if (ownsOperation(token, persisted.projectId, job.jobId)) {
            useEditorStore.getState().setProgress(progress);
          }
        })
      )
    );
    return terminal;
  }

  function assertCompleted(progress: JobProgress | null): boolean {
    if (!progress) throw new Error("The native job ended without a final status");
    if (progress.status === "cancelled") return false;
    if (progress.status !== "completed") throw new Error(progress.message);
    return true;
  }

  async function prepareProject(
    initial: ProjectManifest,
    playback: PlaybackSource,
    token: number
  ): Promise<{ project: ProjectManifest; prepared: PreparedMedia } | null> {
    const store = useEditorStore.getState();
    store.loadProject(initial, { playback });
    store.setStatus("preparing");
    store.setError(null);

    const running = await Effect.runPromise(
      prepareMedia({ projectId: initial.id, revision: initial.revision }).pipe(
        Effect.provide(TauriPlatformLive)
      )
    );
    const terminal = await consumeJob(
      running,
      {
        kind: "prepare",
        projectId: initial.id,
        revision: initial.revision,
      },
      token
    );
    if (!ownsOperation(token, initial.id, running.jobId)) return null;
    if (terminal?.status === "failed") {
      clearJobBookmark(running.jobId);
      store.setActiveJob(null);
    }
    if (!assertCompleted(terminal)) {
      clearJobBookmark(running.jobId);
      store.setActiveJob(null);
      store.setStatus("ready");
      store.setProgress(null);
      return null;
    }
    const prepared = Option.getOrThrow(await Effect.runPromise(running.result));
    if (!ownsOperation(token, initial.id, running.jobId)) return null;
    let project = initial;
    if (Math.abs(project.duration - prepared.duration) > 0.001) {
      project = await Effect.runPromise(
        saveProject({ ...project, duration: prepared.duration }).pipe(
          Effect.provide(TauriPlatformLive)
        )
      );
    }
    if (!ownsOperation(token, initial.id, running.jobId)) return null;
    clearJobBookmark(running.jobId);
    store.loadProject(project, { preparedMedia: prepared, playback });
    return { project, prepared };
  }

  async function enterProject(project: ProjectManifest, autoTranscribe = false) {
    await flushProjectAutosave();
    const token = ++operationToken.current;
    await releaseCurrentPlayback();
    if (operationToken.current !== token) return;
    const playback = await Effect.runPromise(
      projectPlaybackSource(project.id).pipe(Effect.provide(TauriPlatformLive))
    );
    if (operationToken.current !== token) {
      await Effect.runPromise(
        releasePlaybackSource(playback).pipe(Effect.provide(TauriPlatformLive))
      ).catch(() => undefined);
      return;
    }
    playbackRef.current = playback;
    const prepared = await prepareProject(project, playback, token);
    if (operationToken.current !== token) return;
    await refreshProjects();
    if (prepared && autoTranscribe) await transcribeCurrentProject();
  }

  function changeHomeModel(model: TranscriptionModel) {
    setHomeModel(model);
    saveModelPreference(model);
  }

  function changeHomeSpeakerDiarization(enabled: boolean) {
    setHomeSpeakerDiarizationEnabled(enabled);
    try {
      localStorage.setItem(DIARIZATION_PREFERENCE_KEY, String(enabled));
    } catch {
      // Keep the in-memory preference when local storage is unavailable.
    }
  }

  async function chooseMedia() {
    setHomeBusy(true);
    setHomeError(null);
    try {
      const selected = await Effect.runPromise(
        chooseMediaAndCreateProject({
          model: homeModel,
          speakerDiarizationEnabled: homeSpeakerDiarizationEnabled,
        }).pipe(
          Effect.provide(TauriPlatformLive)
        )
      );
      if (Option.isSome(selected)) {
        await enterProject(selected.value, true);
      }
    } catch (cause) {
      useEditorStore.getState().reset();
      setHomeError(messageOf(cause));
    } finally {
      setHomeBusy(false);
    }
  }

  async function openProject(summary: ProjectSummary) {
    setHomeBusy(true);
    setHomeError(null);
    try {
      const project = Option.getOrThrow(
        await Effect.runPromise(
          readProject(summary.id).pipe(Effect.provide(TauriPlatformLive))
        )
      );
      await enterProject(project, false);
    } catch (cause) {
      useEditorStore.getState().reset();
      setHomeError(messageOf(cause));
    } finally {
      setHomeBusy(false);
    }
  }

  async function goHome(): Promise<boolean> {
    const store = useEditorStore.getState();
    try {
      await flushProjectAutosave();
    } catch {
      const discard = window.confirm(
        "Your latest edits could not be saved. Leave this project and discard those unsaved edits?"
      );
      if (!discard) return false;
    }
    operationToken.current += 1;
    pendingExport.current.clear();
    setPaywallOpen(false);
    setPurchaseError(null);
    setPurchaseMessage(null);
    if (store.cancelJob) await store.cancelJob().catch(() => undefined);
    await releaseCurrentPlayback();
    store.reset();
    await refreshProjects();
    return true;
  }

  async function transcribeCurrentProject() {
    const store = useEditorStore.getState();
    if (!store.manifest || store.status !== "ready") return;
    const projectId = store.manifest.id;
    const token = ++operationToken.current;
    let jobId: string | null = null;
    let terminalSeen = false;
    store.setError(null);
    store.setStatus("transcribing");
    store.setProgress(null);
    try {
      await flushProjectAutosave();
      const current = useEditorStore.getState();
      if (!current.manifest || !ownsOperation(token, projectId)) return;
      const running = await Effect.runPromise(
        transcribeProject({
          projectId,
          revision: current.manifest.revision,
          model: current.model,
        }).pipe(Effect.provide(TauriPlatformLive))
      );
      jobId = running.jobId;
      const terminal = await consumeJob(
        running,
        {
          kind: "transcription",
          projectId,
          revision: current.manifest.revision,
          model: current.model,
        },
        token
      );
      terminalSeen = terminal !== null && isTerminal(terminal);
      if (!ownsOperation(token, projectId, running.jobId)) return;
      if (!assertCompleted(terminal)) return;
      const words = normalizeWords(
        Option.getOrThrow(await Effect.runPromise(running.result)),
        current.duration
      );
      if (!ownsOperation(token, projectId, running.jobId)) return;
      if (words.length === 0) throw new Error("Transcription returned no timed words");
      useEditorStore.getState().replaceTranscript(words, current.model);
      await flushProjectAutosave();
      if (!ownsOperation(token, projectId, running.jobId)) return;
      await refreshProjects();
    } catch (cause) {
      if (ownsOperation(token, projectId, jobId ?? undefined)) {
        useEditorStore.getState().setError(messageOf(cause));
      }
    } finally {
      if (jobId && terminalSeen) clearJobBookmark(jobId);
      if (operationToken.current === token) {
        const latest = useEditorStore.getState();
        if (latest.manifest?.id === projectId) {
          latest.setActiveJob(null);
          latest.setProgress(null);
          latest.setStatus("ready");
        }
      }
    }
  }

  function normalizeWords(words: readonly Word[], duration: number): Word[] {
    return words
      .flatMap((word) => {
        if (!Number.isFinite(word.start) || !Number.isFinite(word.end)) return [];
        const start = Math.max(0, word.start);
        if (start >= duration) return [];
        const end = Math.min(duration, word.end);
        return end > start ? [{ ...word, start, end, speaker: Math.max(0, Math.trunc(word.speaker)) }] : [];
      })
      .sort((left, right) =>
        left.start === right.start ? left.end - right.end : left.start - right.start
      )
      .map((word, id) => ({ ...word, id }));
  }

  async function importTranscript() {
    const store = useEditorStore.getState();
    if (!store.manifest || store.status !== "ready") return;
    if (
      store.words.length > 0 &&
      !window.confirm("Replace the current transcript with the selected file?")
    ) {
      return;
    }
    const token = operationToken.current;
    const projectId = store.manifest.id;
    store.setError(null);
    try {
      const selected = await Effect.runPromise(
        chooseTranscript.pipe(Effect.provide(TauriPlatformLive))
      );
      if (Option.isNone(selected) || !ownsOperation(token, projectId)) return;
      const latest = useEditorStore.getState();
      if (latest.status !== "ready") return;
      const words = normalizeWords(selected.value, latest.duration);
      if (words.length === 0) throw new Error("The transcript has no words inside this media duration");
      useEditorStore.getState().replaceTranscript(words, "import");
      await flushProjectAutosave();
      if (!ownsOperation(token, projectId)) return;
      await refreshProjects();
    } catch (cause) {
      if (ownsOperation(token, projectId)) {
        useEditorStore.getState().setError(messageOf(cause));
      }
    }
  }

  function queuePendingExport(projectId: string) {
    pendingExport.current.remember(projectId);
  }

  function resumePendingExport(entitlement: ExportEntitlementState): boolean {
    const store = useEditorStore.getState();
    const intent = pendingExport.current.consume({
      accessGranted:
        entitlement.enforcement === "none" || entitlement.entitled,
      projectId: store.manifest?.id ?? null,
      exportDialogOpen: store.exportOpen,
      ready: store.status === "ready",
    });
    if (!intent) return false;

    setPaywallOpen(false);
    setPurchaseError(null);
    setPurchaseMessage(null);
    void startExport();
    return true;
  }

  async function refreshExportEntitlement() {
    if (
      entitlementCheckInProgress.current ||
      purchaseOperationInProgress.current
    ) return;
    entitlementCheckInProgress.current = true;
    setExportAccessChecking(true);
    setPurchaseError(null);
    try {
      const entitlement = await getExportEntitlement();
      setExportEntitlement(entitlement);
      if (document.visibilityState === "visible") {
        resumePendingExport(entitlement);
      }
    } catch (cause) {
      setPurchaseError(messageOf(cause));
    } finally {
      entitlementCheckInProgress.current = false;
      setExportAccessChecking(false);
    }
  }

  async function requestExport() {
    const store = useEditorStore.getState();
    if (!store.manifest || store.status !== "ready") return;
    if (entitlementCheckInProgress.current) return;
    const projectId = store.manifest.id;

    entitlementCheckInProgress.current = true;
    setExportAccessChecking(true);
    setPurchaseError(null);
    setPurchaseMessage(null);
    try {
      const entitlement = await getExportEntitlement();
      setExportEntitlement(entitlement);
      if (entitlement.enforcement === "none" || entitlement.entitled) {
        pendingExport.current.clear();
        setPaywallOpen(false);
        await startExport();
      } else {
        queuePendingExport(projectId);
        setPaywallOpen(true);
      }
    } catch (cause) {
      if (platform?.os !== "ios") {
        pendingExport.current.clear();
        setExportEntitlement(UNLOCKED_EXPORT_ENTITLEMENT);
        setPaywallOpen(false);
        await startExport();
      } else {
        queuePendingExport(projectId);
        setExportEntitlement(LOCKED_EXPORT_ENTITLEMENT);
        setPurchaseError(`Could not check export access. ${messageOf(cause)}`);
        setPaywallOpen(true);
      }
    } finally {
      entitlementCheckInProgress.current = false;
      setExportAccessChecking(false);
    }
  }

  function handlePurchaseResult(result: ExportPurchaseResult) {
    setExportEntitlement(result.entitlement);
    switch (result.outcome) {
      case "purchased":
      case "alreadyEntitled":
      case "restored":
      case "notApplicable":
        if (!result.entitlement.entitled) {
          throw new Error("The purchase completed, but the App Store did not grant export access.");
        }
        if (document.visibilityState === "visible") {
          resumePendingExport(result.entitlement);
        }
        break;
      case "pending":
        setPurchaseMessage(
          "Purchase pending approval. Keep this export window open and the export will continue once it is approved."
        );
        break;
      case "cancelled":
        break;
      case "notFound":
        setPurchaseError("No previous Unlimited Exports purchase was found for this Apple ID.");
        break;
    }
  }

  async function runPurchaseOperation(operation: "purchase" | "restore") {
    if (purchaseOperationInProgress.current) return;
    purchaseOperationInProgress.current = true;
    setPurchaseBusy(true);
    setPurchaseError(null);
    setPurchaseMessage(null);
    try {
      const result =
        operation === "purchase"
          ? await purchaseUnlimitedExports()
          : await restoreExportPurchases();
      handlePurchaseResult(result);
    } catch (cause) {
      setPurchaseError(messageOf(cause));
    } finally {
      purchaseOperationInProgress.current = false;
      setPurchaseBusy(false);
    }
  }

  function dismissPaywall() {
    if (purchaseOperationInProgress.current) return;
    pendingExport.current.clear();
    setPaywallOpen(false);
    setPurchaseError(null);
    setPurchaseMessage(null);
  }

  async function startExport() {
    let store = useEditorStore.getState();
    if (!store.manifest || store.status !== "ready") return;
    const projectId = store.manifest.id;
    const token = ++operationToken.current;
    let jobId: string | null = null;
    let terminalSeen = false;
    store.setError(null);
    store.setExportResult(null);
    store.setStatus("exporting");
    try {
      await flushProjectAutosave();
      store = useEditorStore.getState();
      if (!store.manifest || !ownsOperation(token, projectId)) return;
      const cuts = getCutRanges(store.words, store.duration, store.manualCuts);
      const keepRanges = getKeepRanges(cuts, store.duration);
      if (keepRanges.length === 0) throw new Error("Nothing remains after the current cuts");
      const extension = store.manifest.media.mediaKind === "audio" ? "m4a" : "mp4";
      const base = store.manifest.media.name.replace(/\.[^.]+$/, "") || "edited";
      const destination = await Effect.runPromise(
        chooseExportDestination(
          `${base}.edited.${extension}`,
          store.manifest.media.mediaKind
        ).pipe(Effect.provide(TauriPlatformLive))
      );
      if (Option.isNone(destination) || !ownsOperation(token, projectId)) return;

      const running = await Effect.runPromise(
        exportMedia({
          projectId,
          revision: store.manifest.revision,
          keepRanges,
          destination: destination.value,
        }).pipe(Effect.provide(TauriPlatformLive))
      );
      jobId = running.jobId;
      const terminal = await consumeJob(
        running,
        {
          kind: "export",
          projectId,
          revision: store.manifest.revision,
        },
        token
      );
      terminalSeen = terminal !== null && isTerminal(terminal);
      if (!ownsOperation(token, projectId, running.jobId)) return;
      if (!assertCompleted(terminal)) return;
      const result = Option.getOrThrow(await Effect.runPromise(running.result));
      if (!ownsOperation(token, projectId, running.jobId)) return;
      useEditorStore.getState().setExportResult(result);
    } catch (cause) {
      if (ownsOperation(token, projectId, jobId ?? undefined)) {
        const latest = useEditorStore.getState();
        if (isPurchaseRequired(cause)) {
          latest.setError(null);
          queuePendingExport(projectId);
          setExportEntitlement(LOCKED_EXPORT_ENTITLEMENT);
          setPurchaseError(null);
          setPurchaseMessage(null);
          setPaywallOpen(true);
        } else {
          latest.setError(messageOf(cause));
        }
      }
    } finally {
      if (jobId && terminalSeen) clearJobBookmark(jobId);
      if (operationToken.current === token) {
        const latest = useEditorStore.getState();
        if (latest.manifest?.id === projectId) {
          latest.setActiveJob(null);
          latest.setProgress(null);
          latest.setStatus("ready");
        }
      }
    }
  }

  async function deleteProject(summary: ProjectSummary) {
    if (!window.confirm(`Delete “${summary.name}” and its private project files?`)) return;
    setHomeError(null);
    try {
      if (
        useEditorStore.getState().manifest?.id === summary.id &&
        !(await goHome())
      ) {
        return;
      }
      await Effect.runPromise(
        removeProject(summary.id).pipe(Effect.provide(TauriPlatformLive))
      );
      await refreshProjects();
    } catch (cause) {
      setHomeError(messageOf(cause));
    }
  }

  return manifest ? (
    <Suspense fallback={<div className="editor-loading">Opening editor…</div>}>
      <EditorShell
        onHome={() => void goHome()}
        onImportTranscript={() => void importTranscript()}
        onTranscribe={() => void transcribeCurrentProject()}
        onExport={requestExport}
        exportEntitlement={exportEntitlement}
        exportAccessChecking={exportAccessChecking}
        paywallOpen={paywallOpen}
        purchaseBusy={purchaseBusy}
        purchaseError={purchaseError}
        purchaseMessage={purchaseMessage}
        onPurchase={() => void runPurchaseOperation("purchase")}
        onRestorePurchase={() => void runPurchaseOperation("restore")}
        onRetryExportAccess={() => void refreshExportEntitlement()}
        onDismissPaywall={dismissPaywall}
      />
    </Suspense>
  ) : (
    <HomeScreen
      platform={platform}
      projects={projects}
      model={homeModel}
      speakerDiarizationEnabled={homeSpeakerDiarizationEnabled}
      busy={homeBusy}
      error={homeError}
      onModelChange={changeHomeModel}
      onSpeakerDiarizationChange={changeHomeSpeakerDiarization}
      onChooseMedia={() => void chooseMedia()}
      onOpenProject={(project) => void openProject(project)}
      onRemoveProject={(project) => void deleteProject(project)}
    />
  );
}
