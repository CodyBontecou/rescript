export type {
  ClipSegment,
  EditSnapshot,
  EditorDocument,
  EditorStatus,
  JobProgress,
  ManualCut,
  ProgressInfo,
  ProjectManifest,
  ProjectSummary,
  SceneBoundary,
  SpeakerTurn,
  TimeRange,
  Word,
} from "@rescript/core";

import type { Word } from "@rescript/core";
import type { TranscriptionModel } from "./models";

/** Browser-worker messages are intentionally kept out of the shared domain. */
export type WorkerResponse =
  | { type: "progress"; message: string; value: number | null }
  | { type: "partial"; text: string }
  | { type: "complete"; words: Word[] }
  | { type: "error"; message: string };

export interface WorkerRequest {
  audio: Float32Array;
  duration: number;
  model: TranscriptionModel;
  language?: string;
}
