import { Data, Effect, Option } from "effect";
import {
  FilePicker,
  PlaybackController,
  ProjectRepository,
  type CreateProjectInput,
  type EditorDocument,
  type MediaKind,
  type ProjectManifest,
  type Word,
} from "@rescript/core";
import { parseTranscript } from "@rescript/core/transcript";

export class TranscriptImportError extends Data.TaggedError(
  "TranscriptImportError"
)<{
  readonly fileName: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const listProjects = Effect.flatMap(
  ProjectRepository,
  (repository) => repository.list
);

export const readProject = (id: string) =>
  Effect.flatMap(ProjectRepository, (repository) => repository.read(id));

export const createProject = (input: CreateProjectInput) =>
  Effect.flatMap(ProjectRepository, (repository) => repository.create(input));

/** Ask the active platform for media and create only when the user selected it. */
export const chooseMediaAndCreateProject = (
  options: Omit<CreateProjectInput, "media" | "name"> & {
    readonly name?: string;
  }
) =>
  Effect.gen(function* () {
    const picker = yield* FilePicker;
    const selected = yield* picker.importMedia;
    if (Option.isNone(selected)) return Option.none<ProjectManifest>();

    const repository = yield* ProjectRepository;
    const project = yield* repository.create({
      ...options,
      name: options.name ?? selected.value.name,
      media: selected.value,
    });
    return Option.some(project);
  });

/**
 * Decode a platform-selected caption file using the shared parser. Cancellation
 * is represented by Option.none and is not an error.
 */
export const chooseExportDestination = (
  suggestedName: string,
  mediaKind: MediaKind
) =>
  Effect.flatMap(FilePicker, (picker) =>
    picker.exportDestination(suggestedName, mediaKind)
  );

export const chooseTranscript = Effect.gen(function* () {
  const picker = yield* FilePicker;
  const selected = yield* picker.importTranscript;
  if (Option.isNone(selected)) return Option.none<readonly Word[]>();

  const words = yield* Effect.try({
    try: () => parseTranscript(selected.value.text, selected.value.name),
    catch: (cause) =>
      new TranscriptImportError({
        fileName: selected.value.name,
        message:
          cause instanceof Error ? cause.message : "Unable to parse transcript",
        cause,
      }),
  });
  return Option.some(words);
});

/** Persist with optimistic revision checking; repositories increment revision. */
export const saveProject = (project: ProjectManifest) =>
  Effect.flatMap(ProjectRepository, (repository) =>
    repository.save({ project, expectedRevision: project.revision })
  );

/** Coalesce at the call site; this effect owns only cancellation-aware delay. */
export const autosaveProject = (
  project: ProjectManifest,
  debounceMs = 500
) => Effect.sleep(`${debounceMs} millis`).pipe(Effect.zipRight(saveProject(project)));

export const removeProject = (id: string) =>
  Effect.flatMap(ProjectRepository, (repository) => repository.remove(id));

export const projectPlaybackSource = (projectId: string) =>
  Effect.flatMap(PlaybackController, (playback) => playback.source(projectId));

export const releasePlaybackSource = (
  source: import("@rescript/core").PlaybackSource
) => Effect.flatMap(PlaybackController, (playback) => playback.release(source));

/** Apply editor document state without leaking view-store fields into storage. */
export function withEditorDocument(
  project: ProjectManifest,
  document: EditorDocument,
  showDeleted: boolean
): ProjectManifest {
  return {
    ...project,
    duration: document.duration,
    words: document.words,
    manualCuts: document.manualCuts,
    sceneBoundaries: document.sceneBoundaries,
    showDeleted,
  };
}
