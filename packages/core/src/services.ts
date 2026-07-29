import { Context, Data, Effect, Option, Stream } from "effect";
import type {
  JobProgress,
  MediaExportResult,
  MediaKind,
  ModelChoice,
  ModelDescriptor,
  PreparedMedia,
  ProjectManifest,
  ProjectSummary,
  TimeRange,
  TranscriptionModel,
  Word,
} from "./schema";

export class ProjectRepositoryError extends Data.TaggedError(
  "ProjectRepositoryError"
)<{
  readonly operation: "list" | "read" | "create" | "save" | "remove";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class FilePickerError extends Data.TaggedError("FilePickerError")<{
  readonly operation: "import-media" | "import-transcript" | "export";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class JobServiceError extends Data.TaggedError("JobServiceError")<{
  readonly operation: "start" | "observe" | "snapshot" | "cancel";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ModelRepositoryError extends Data.TaggedError(
  "ModelRepositoryError"
)<{
  readonly operation: "list" | "remove";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class PlaybackError extends Data.TaggedError("PlaybackError")<{
  readonly operation: "source" | "release";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class PreferencesError extends Data.TaggedError("PreferencesError")<{
  readonly operation: "load" | "save";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ImportedMedia {
  /** Opaque reference understood only by the active platform adapter. */
  readonly source: string;
  readonly name: string;
  readonly mediaType: string;
  readonly mediaKind: MediaKind;
  readonly byteLength: number;
}

export interface ImportedTranscript {
  readonly name: string;
  readonly text: string;
}

export interface ExportDestination {
  /** Opaque destination token, never assumed to be a filesystem path. */
  readonly destination: string;
  readonly displayName: string;
}

export interface CreateProjectInput {
  readonly name: string;
  readonly media: ImportedMedia;
  readonly duration?: number;
  readonly model: ModelChoice;
  readonly words?: readonly Word[];
}

export interface SaveProjectInput {
  readonly project: ProjectManifest;
  /** Prevent stale autosaves from overwriting a newer revision. */
  readonly expectedRevision: number;
}

export interface ProjectRepositoryService {
  readonly list: Effect.Effect<readonly ProjectSummary[], ProjectRepositoryError>;
  readonly read: (
    id: string
  ) => Effect.Effect<Option.Option<ProjectManifest>, ProjectRepositoryError>;
  readonly create: (
    input: CreateProjectInput
  ) => Effect.Effect<ProjectManifest, ProjectRepositoryError>;
  readonly save: (
    input: SaveProjectInput
  ) => Effect.Effect<ProjectManifest, ProjectRepositoryError>;
  readonly remove: (id: string) => Effect.Effect<void, ProjectRepositoryError>;
}

export class ProjectRepository extends Context.Tag(
  "@rescript/core/ProjectRepository"
)<ProjectRepository, ProjectRepositoryService>() {}

export interface FilePickerService {
  readonly importMedia: Effect.Effect<
    Option.Option<ImportedMedia>,
    FilePickerError
  >;
  readonly importTranscript: Effect.Effect<
    Option.Option<ImportedTranscript>,
    FilePickerError
  >;
  readonly exportDestination: (
    suggestedName: string,
    mediaKind: MediaKind
  ) => Effect.Effect<Option.Option<ExportDestination>, FilePickerError>;
}

export class FilePicker extends Context.Tag("@rescript/core/FilePicker")<
  FilePicker,
  FilePickerService
>() {}

export interface JobControllerService {
  readonly observe: (
    jobId: string
  ) => Stream.Stream<JobProgress, JobServiceError>;
  readonly snapshot: (
    jobId: string
  ) => Effect.Effect<Option.Option<JobProgress>, JobServiceError>;
  readonly cancel: (jobId: string) => Effect.Effect<void, JobServiceError>;
}

export interface PrepareMediaRequest {
  readonly projectId: string;
  readonly revision: number;
}

export interface ExportMediaRequest {
  readonly projectId: string;
  readonly revision: number;
  readonly keepRanges: readonly TimeRange[];
  readonly destination: ExportDestination;
}

export interface MediaJobService extends JobControllerService {
  readonly startPrepare: (
    request: PrepareMediaRequest
  ) => Effect.Effect<string, JobServiceError>;
  readonly startExport: (
    request: ExportMediaRequest
  ) => Effect.Effect<string, JobServiceError>;
  readonly prepareResult: (
    jobId: string
  ) => Effect.Effect<Option.Option<PreparedMedia>, JobServiceError>;
  readonly exportResult: (
    jobId: string
  ) => Effect.Effect<Option.Option<MediaExportResult>, JobServiceError>;
}

export class MediaJobs extends Context.Tag("@rescript/core/MediaJobs")<
  MediaJobs,
  MediaJobService
>() {}

export interface TranscriptionRequest {
  readonly projectId: string;
  readonly revision: number;
  readonly model: Exclude<ModelChoice, "import">;
  readonly language?: string;
}

export interface TranscriptionJobService extends JobControllerService {
  readonly start: (
    request: TranscriptionRequest
  ) => Effect.Effect<string, JobServiceError>;
  readonly result: (
    jobId: string
  ) => Effect.Effect<Option.Option<readonly Word[]>, JobServiceError>;
}

export class TranscriptionJobs extends Context.Tag(
  "@rescript/core/TranscriptionJobs"
)<TranscriptionJobs, TranscriptionJobService>() {}

export interface ModelRepositoryService {
  readonly list: Effect.Effect<
    readonly ModelDescriptor[],
    ModelRepositoryError
  >;
  readonly remove: (
    model: TranscriptionModel
  ) => Effect.Effect<void, ModelRepositoryError>;
}

export class ModelRepository extends Context.Tag(
  "@rescript/core/ModelRepository"
)<ModelRepository, ModelRepositoryService>() {}

export interface PlaybackSource {
  readonly projectId: string;
  readonly url: string;
}

export interface PlaybackControllerService {
  readonly source: (
    projectId: string
  ) => Effect.Effect<PlaybackSource, PlaybackError>;
  readonly release: (
    source: PlaybackSource
  ) => Effect.Effect<void, PlaybackError>;
}

export class PlaybackController extends Context.Tag(
  "@rescript/core/PlaybackController"
)<PlaybackController, PlaybackControllerService>() {}

export interface PreferencesService {
  readonly loadModel: Effect.Effect<ModelChoice, PreferencesError>;
  readonly saveModel: (
    model: Exclude<ModelChoice, "import">
  ) => Effect.Effect<void, PreferencesError>;
}

export class Preferences extends Context.Tag("@rescript/core/Preferences")<
  Preferences,
  PreferencesService
>() {}
