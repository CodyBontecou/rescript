import { Effect, Option, Schedule, Stream } from "effect";
import {
  MediaJobs,
  TranscriptionJobs,
  type ExportMediaRequest,
  type JobProgress,
  type MediaExportResult,
  type PreparedMedia,
  type PrepareMediaRequest,
  type TranscriptionRequest,
  type Word,
} from "@rescript/core";

export interface RunningJob {
  readonly jobId: string;
  readonly progress: Stream.Stream<JobProgress, import("@rescript/core").JobServiceError>;
  readonly cancel: Effect.Effect<void, import("@rescript/core").JobServiceError>;
}

function terminal(progress: JobProgress): boolean {
  return (
    progress.status === "completed" ||
    progress.status === "failed" ||
    progress.status === "cancelled"
  );
}

/**
 * Merge listener events with periodic durable snapshots. Subscribing and then
 * polling closes the completion race between a one-shot snapshot and listener
 * registration, while also recovering progress after a webview restart.
 */
function reconnectingProgress(
  jobId: string,
  jobs: {
    readonly snapshot: (
      jobId: string
    ) => Effect.Effect<
      Option.Option<JobProgress>,
      import("@rescript/core").JobServiceError
    >;
    readonly observe: (
      jobId: string
    ) => Stream.Stream<
      JobProgress,
      import("@rescript/core").JobServiceError
    >;
  }
) {
  return Stream.unwrap(
    Effect.map(jobs.snapshot(jobId), (initial) => {
      if (Option.isSome(initial) && terminal(initial.value)) {
        return Stream.succeed(initial.value);
      }
      const snapshots = Stream.repeatEffect(jobs.snapshot(jobId)).pipe(
        Stream.schedule(Schedule.spaced("250 millis")),
        Stream.filterMap((snapshot) => snapshot)
      );
      const live = Stream.merge(jobs.observe(jobId), snapshots);
      return Option.isSome(initial)
        ? Stream.concat(Stream.succeed(initial.value), live)
        : live;
    })
  ).pipe(
    Stream.changesWith(
      (left, right) =>
        left.status === right.status &&
        left.phase === right.phase &&
        left.message === right.message &&
        left.ratio === right.ratio
    ),
    Stream.takeUntil(terminal)
  );
}

export interface RunningMediaPreparation extends RunningJob {
  readonly result: Effect.Effect<
    Option.Option<PreparedMedia>,
    import("@rescript/core").JobServiceError
  >;
}

export interface RunningMediaExport extends RunningJob {
  readonly result: Effect.Effect<
    Option.Option<MediaExportResult>,
    import("@rescript/core").JobServiceError
  >;
}

export const prepareMedia = (request: PrepareMediaRequest) =>
  Effect.gen(function* () {
    const jobs = yield* MediaJobs;
    const jobId = yield* jobs.startPrepare(request);
    return {
      jobId,
      progress: reconnectingProgress(jobId, jobs),
      cancel: jobs.cancel(jobId),
      result: jobs.prepareResult(jobId),
    } satisfies RunningMediaPreparation;
  });

export const exportMedia = (request: ExportMediaRequest) =>
  Effect.gen(function* () {
    const jobs = yield* MediaJobs;
    const jobId = yield* jobs.startExport(request);
    return {
      jobId,
      progress: reconnectingProgress(jobId, jobs),
      cancel: jobs.cancel(jobId),
      result: jobs.exportResult(jobId),
    } satisfies RunningMediaExport;
  });

export interface RunningTranscription extends RunningJob {
  readonly result: Effect.Effect<
    Option.Option<readonly Word[]>,
    import("@rescript/core").JobServiceError
  >;
}

export const transcribeProject = (request: TranscriptionRequest) =>
  Effect.gen(function* () {
    const jobs = yield* TranscriptionJobs;
    const jobId = yield* jobs.start(request);
    return {
      jobId,
      progress: reconnectingProgress(jobId, jobs),
      cancel: jobs.cancel(jobId),
      result: jobs.result(jobId),
    } satisfies RunningTranscription;
  });

export const reconnectMediaJob = (jobId: string) =>
  Effect.map(MediaJobs, (jobs): RunningJob => ({
    jobId,
    progress: reconnectingProgress(jobId, jobs),
    cancel: jobs.cancel(jobId),
  }));

export const reconnectMediaPreparation = (jobId: string) =>
  Effect.map(
    MediaJobs,
    (jobs): RunningMediaPreparation => ({
      jobId,
      progress: reconnectingProgress(jobId, jobs),
      cancel: jobs.cancel(jobId),
      result: jobs.prepareResult(jobId),
    })
  );

export const reconnectMediaExport = (jobId: string) =>
  Effect.map(
    MediaJobs,
    (jobs): RunningMediaExport => ({
      jobId,
      progress: reconnectingProgress(jobId, jobs),
      cancel: jobs.cancel(jobId),
      result: jobs.exportResult(jobId),
    })
  );

export const reconnectTranscriptionJob = (jobId: string) =>
  Effect.map(
    TranscriptionJobs,
    (jobs): RunningTranscription => ({
      jobId,
      progress: reconnectingProgress(jobId, jobs),
      cancel: jobs.cancel(jobId),
      result: jobs.result(jobId),
    })
  );
