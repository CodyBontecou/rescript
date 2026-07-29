import { invoke } from "@tauri-apps/api/core";
import { Effect, Layer, Option, Schema } from "effect";
import {
  JobProgressSchema,
  JobServiceError,
  TranscriptionJobs,
  WordSchema,
  type JobProgress,
  type TranscriptionJobService,
  type Word,
} from "@rescript/core";
import { observeNativeJob } from "./media-jobs";

function transcriptionError(
  operation: JobServiceError["operation"],
  cause: unknown
) {
  let message = "Native transcription failed";
  if (cause instanceof Error) message = cause.message;
  else if (typeof cause === "string") message = cause;
  else if (cause && typeof cause === "object") {
    const value = cause as Record<string, unknown>;
    if (typeof value.message === "string") message = value.message;
    else {
      try {
        message = JSON.stringify(cause);
      } catch {
        // Keep fallback.
      }
    }
  }
  return new JobServiceError({ operation, message, cause });
}

async function decodeProgress(value: unknown) {
  if (value === null || value === undefined) {
    return Option.none<JobProgress>();
  }
  return Option.some(
    (await Effect.runPromise(
      Schema.decodeUnknown(JobProgressSchema)(value)
    )) as JobProgress
  );
}

async function decodeWords(value: unknown) {
  if (value === null || value === undefined) {
    return Option.none<readonly Word[]>();
  }
  return Option.some(
    (await Effect.runPromise(
      Schema.decodeUnknown(Schema.Array(WordSchema))(value)
    )) as readonly Word[]
  );
}

const service: TranscriptionJobService = {
  start: (request) =>
    Effect.tryPromise({
      try: () => invoke<string>("start_transcription", { request }),
      catch: (cause) => transcriptionError("start", cause),
    }),
  observe: (jobId) => observeNativeJob(jobId, "transcription"),
  snapshot: (jobId) =>
    Effect.tryPromise({
      try: async () =>
        decodeProgress(
          await invoke("transcription_job_snapshot", { jobId })
        ),
      catch: (cause) => transcriptionError("snapshot", cause),
    }),
  cancel: (jobId) =>
    Effect.tryPromise({
      try: () => invoke<void>("cancel_transcription_job", { jobId }),
      catch: (cause) => transcriptionError("cancel", cause),
    }),
  result: (jobId) =>
    Effect.tryPromise({
      try: async () =>
        decodeWords(await invoke("transcription_result", { jobId })),
      catch: (cause) => transcriptionError("snapshot", cause),
    }),
};

export const TranscriptionJobsTauri = Layer.succeed(
  TranscriptionJobs,
  service
);
