import { addPluginListener, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Effect, Either, Layer, Option, Schema, Stream } from "effect";
import {
  JobProgressSchema,
  JobServiceError,
  MediaExportResultSchema,
  MediaJobs,
  PreparedMediaSchema,
  type JobProgress,
  type MediaExportResult,
  type MediaJobService,
  type PreparedMedia,
} from "@rescript/core";

const JOB_PROGRESS_EVENT = "rescript://job-progress";

function jobError(
  operation: JobServiceError["operation"],
  cause: unknown
) {
  let message = "Native media job failed";
  if (cause instanceof Error) message = cause.message;
  else if (typeof cause === "string") message = cause;
  else if (cause && typeof cause === "object") {
    const value = cause as Record<string, unknown>;
    if (typeof value.message === "string") message = value.message;
    else {
      try {
        message = JSON.stringify(cause);
      } catch {
        // Keep the fallback.
      }
    }
  }
  return new JobServiceError({ operation, message, cause });
}

async function decodeOptional<A>(
  value: unknown,
  schema: Schema.Schema<any, any, never>
): Promise<Option.Option<A>> {
  if (value === null || value === undefined) return Option.none();
  return Option.some(
    (await Effect.runPromise(Schema.decodeUnknown(schema)(value))) as A
  );
}

export function observeNativeJob(
  jobId: string,
  iosPlugin: "av-media" | "transcription" = "av-media"
) {
  return Stream.asyncPush<JobProgress, JobServiceError>((emit) =>
    Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const onProgress = (payload: unknown) => {
            const decoded = Schema.decodeUnknownEither(JobProgressSchema)(payload);
            if (Either.isLeft(decoded)) {
              emit.fail(jobError("observe", decoded.left));
            } else if (decoded.right.jobId === jobId) {
              emit.single(decoded.right);
            }
          };
          const platform = await invoke<{ os: string }>("platform_info");
          if (platform.os === "ios") {
            const listener = await addPluginListener<unknown>(
              iosPlugin,
              "jobProgress",
              onProgress
            );
            return () => listener.unregister();
          }
          return listen<unknown>(JOB_PROGRESS_EVENT, (event) =>
            onProgress(event.payload)
          );
        },
        catch: (cause) => jobError("observe", cause),
      }),
      (unlisten) => Effect.promise(async () => void (await unlisten()))
    )
  );
}

const service: MediaJobService = {
  startPrepare: (request) =>
    Effect.tryPromise({
      try: () => invoke<string>("start_prepare_media", { request }),
      catch: (cause) => jobError("start", cause),
    }),

  startExport: (request) =>
    Effect.tryPromise({
      try: () => invoke<string>("start_export_media", { request }),
      catch: (cause) => jobError("start", cause),
    }),

  observe: observeNativeJob,

  snapshot: (jobId) =>
    Effect.tryPromise({
      try: async () =>
        decodeOptional(
          await invoke("media_job_snapshot", { jobId }),
          JobProgressSchema
        ),
      catch: (cause) => jobError("snapshot", cause),
    }),

  cancel: (jobId) =>
    Effect.tryPromise({
      try: () => invoke<void>("cancel_media_job", { jobId }),
      catch: (cause) => jobError("cancel", cause),
    }),

  prepareResult: (jobId) =>
    Effect.tryPromise({
      try: async () =>
        decodeOptional<PreparedMedia>(
          await invoke("media_prepare_result", { jobId }),
          PreparedMediaSchema
        ),
      catch: (cause) => jobError("snapshot", cause),
    }),

  exportResult: (jobId) =>
    Effect.tryPromise({
      try: async () =>
        decodeOptional<MediaExportResult>(
          await invoke("media_export_result", { jobId }),
          MediaExportResultSchema
        ),
      catch: (cause) => jobError("snapshot", cause),
    }),
};

export const MediaJobsTauri = Layer.succeed(MediaJobs, service);
