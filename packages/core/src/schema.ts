import { Schema } from "effect";

/** A single transcribed word timed against the original media. */
export interface Word {
  id: number;
  text: string;
  start: number;
  end: number;
  speaker: number;
  deleted: boolean;
}

/** A half-open time range [start, end), in original media seconds. */
export interface TimeRange {
  start: number;
  end: number;
}

export interface ManualCut extends TimeRange {
  id: number;
}

export interface SceneBoundary {
  id: number;
  time: number;
}

export interface EditSnapshot {
  words: Word[];
  manualCuts: ManualCut[];
  sceneBoundaries: SceneBoundary[];
}

export interface ClipSegment extends TimeRange {
  id: string;
  index: number;
}

export interface SpeakerTurn {
  speaker: number;
  words: Word[];
}

export type MediaKind = "video" | "audio";
export type WhisperModel = "base" | "small";
export type ParakeetModel = "parakeet-v2" | "parakeet-v3";
export type TranscriptionModel = WhisperModel | ParakeetModel;
export const DEFAULT_TRANSCRIPTION_MODEL: TranscriptionModel = "parakeet-v2";
/** New projects skip the speaker model unless the user opts in. */
export const DEFAULT_SPEAKER_DIARIZATION_ENABLED = false;
export type ModelChoice = TranscriptionModel | "import";
export type ModelAvailability = "missing" | "ready";

export interface ModelDescriptor {
  model: TranscriptionModel;
  label: string;
  byteLength: number;
  availability: ModelAvailability;
}

export type EditorStatus =
  | "idle"
  | "preparing"
  | "transcribing"
  | "ready"
  | "exporting"
  | "error";

export interface ProgressInfo {
  message: string;
  value: number | null;
}

/** Persistent, platform-neutral editor state. */
export interface EditorDocument {
  duration: number;
  words: Word[];
  manualCuts: ManualCut[];
  sceneBoundaries: SceneBoundary[];
  nextManualCutId: number;
  nextBoundaryId: number;
}

export interface ProjectMediaReference {
  /** Project-relative path. Native adapters must never expose arbitrary paths. */
  relativePath: string;
  name: string;
  mediaType: string;
  mediaKind: MediaKind;
  byteLength: number;
}

export interface ProjectManifest {
  schemaVersion: 1;
  id: string;
  revision: number;
  name: string;
  media: ProjectMediaReference;
  duration: number;
  model: ModelChoice;
  speakerDiarizationEnabled: boolean;
  words: Word[];
  manualCuts: ManualCut[];
  sceneBoundaries: SceneBoundary[];
  showDeleted: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectSummary {
  id: string;
  revision: number;
  name: string;
  mediaKind: MediaKind;
  duration: number;
  model: ModelChoice;
  createdAt: number;
  updatedAt: number;
}

export type JobKind = "media" | "transcription" | "export";
export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface JobProgress {
  jobId: string;
  kind: JobKind;
  status: JobStatus;
  phase: string;
  message: string;
  ratio: number | null;
}

/** Reduced native media result. Full PCM remains behind the platform service. */
export interface PreparedMedia {
  duration: number;
  sampleRate: number;
  waveformSamplesPerSecond: number;
  waveform: number[];
  /** Opaque project-local reference consumed by transcription services. */
  audioReference: string;
}

export interface MediaExportResult {
  destination: string;
  byteLength: number;
}

const FiniteNumber = Schema.Number.pipe(
  Schema.filter((value) => Number.isFinite(value), {
    message: () => "Expected a finite number",
  })
);
const NonNegativeNumber = FiniteNumber.pipe(
  Schema.filter((value) => value >= 0, {
    message: () => "Expected a non-negative number",
  })
);
const Integer = FiniteNumber.pipe(
  Schema.filter((value) => Number.isInteger(value), {
    message: () => "Expected an integer",
  })
);
const NonNegativeInteger = Integer.pipe(
  Schema.filter((value) => value >= 0, {
    message: () => "Expected a non-negative integer",
  })
);

export const WordSchema = Schema.Struct({
  id: NonNegativeInteger,
  text: Schema.String,
  start: NonNegativeNumber,
  end: NonNegativeNumber,
  speaker: NonNegativeInteger,
  deleted: Schema.Boolean,
}).pipe(
  Schema.filter((word) => word.end > word.start, {
    message: () => "Word end must be greater than start",
  })
);

export const TimeRangeSchema = Schema.Struct({
  start: NonNegativeNumber,
  end: NonNegativeNumber,
}).pipe(
  Schema.filter((range) => range.end > range.start, {
    message: () => "Range end must be greater than start",
  })
);

export const ManualCutSchema = Schema.Struct({
  id: NonNegativeInteger,
  start: NonNegativeNumber,
  end: NonNegativeNumber,
}).pipe(
  Schema.filter((range) => range.end > range.start, {
    message: () => "Manual cut end must be greater than start",
  })
);

export const SceneBoundarySchema = Schema.Struct({
  id: NonNegativeInteger,
  time: NonNegativeNumber,
});

export const MediaKindSchema = Schema.Literal("video", "audio");
export const WhisperModelSchema = Schema.Literal("base", "small");
export const ParakeetModelSchema = Schema.Literal("parakeet-v2", "parakeet-v3");
export const TranscriptionModelSchema = Schema.Literal(
  "base",
  "small",
  "parakeet-v2",
  "parakeet-v3"
);
export const ModelChoiceSchema = Schema.Literal(
  "base",
  "small",
  "parakeet-v2",
  "parakeet-v3",
  "import"
);
export const ModelAvailabilitySchema = Schema.Literal("missing", "ready");
export const JobKindSchema = Schema.Literal("media", "transcription", "export");
export const JobStatusSchema = Schema.Literal(
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled"
);

export const ModelDescriptorSchema = Schema.Struct({
  model: TranscriptionModelSchema,
  label: Schema.String,
  byteLength: NonNegativeInteger,
  availability: ModelAvailabilitySchema,
});

export const ProjectMediaReferenceSchema = Schema.Struct({
  relativePath: Schema.String,
  name: Schema.String,
  mediaType: Schema.String,
  mediaKind: MediaKindSchema,
  byteLength: NonNegativeInteger,
});

export const ProjectManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: Schema.String,
  revision: NonNegativeInteger,
  name: Schema.String,
  media: ProjectMediaReferenceSchema,
  duration: NonNegativeNumber,
  model: ModelChoiceSchema,
  // Keep speaker detection enabled for manifests written before this setting
  // existed so opening an older project does not silently change its behavior.
  speakerDiarizationEnabled: Schema.optionalWith(Schema.Boolean, {
    default: () => true,
  }),
  words: Schema.Array(WordSchema),
  manualCuts: Schema.Array(ManualCutSchema),
  sceneBoundaries: Schema.Array(SceneBoundarySchema),
  showDeleted: Schema.Boolean,
  createdAt: NonNegativeNumber,
  updatedAt: NonNegativeNumber,
}).pipe(
  Schema.filter(
    (project) =>
      project.words.every(
        (word, index) =>
          word.end <= project.duration + 1e-4 &&
          (index === 0 || project.words[index - 1].start <= word.start)
      ) &&
      new Set(project.words.map((word) => word.id)).size === project.words.length &&
      project.manualCuts.every((cut) => cut.end <= project.duration + 1e-4) &&
      new Set(project.manualCuts.map((cut) => cut.id)).size === project.manualCuts.length &&
      project.sceneBoundaries.every(
        (boundary, index) =>
          boundary.time > 0 &&
          boundary.time < project.duration &&
          (index === 0 || project.sceneBoundaries[index - 1].time < boundary.time)
      ) &&
      new Set(project.sceneBoundaries.map((boundary) => boundary.id)).size ===
        project.sceneBoundaries.length,
    {
      message: () =>
        "Project timings and IDs must be ordered, unique, and within the media duration",
    }
  )
);

export const ProjectSummarySchema = Schema.Struct({
  id: Schema.String,
  revision: NonNegativeInteger,
  name: Schema.String,
  mediaKind: MediaKindSchema,
  duration: NonNegativeNumber,
  model: ModelChoiceSchema,
  createdAt: NonNegativeNumber,
  updatedAt: NonNegativeNumber,
});

const ProgressRatio = NonNegativeNumber.pipe(
  Schema.filter((value) => value <= 1, {
    message: () => "Progress ratio must be between zero and one",
  })
);

export const JobProgressSchema = Schema.Struct({
  jobId: Schema.String,
  kind: JobKindSchema,
  status: JobStatusSchema,
  phase: Schema.String,
  message: Schema.String,
  ratio: Schema.NullOr(ProgressRatio),
});

export const PreparedMediaSchema = Schema.Struct({
  duration: NonNegativeNumber,
  sampleRate: NonNegativeInteger,
  waveformSamplesPerSecond: NonNegativeNumber,
  waveform: Schema.Array(ProgressRatio),
  audioReference: Schema.String,
});

export const MediaExportResultSchema = Schema.Struct({
  destination: Schema.String,
  byteLength: NonNegativeInteger,
});

export const decodeProjectManifest = Schema.decodeUnknown(ProjectManifestSchema);
export const decodeProjectSummary = Schema.decodeUnknown(ProjectSummarySchema);
export const decodeJobProgress = Schema.decodeUnknown(JobProgressSchema);
