import { Chunk, Effect, Layer, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
  MediaJobs,
  type JobProgress,
  type MediaJobService,
} from "@rescript/core";
import { prepareMedia, reconnectMediaJob } from "../src/jobs";

function progress(
  status: JobProgress["status"],
  ratio: number | null
): JobProgress {
  return {
    jobId: "job-1",
    kind: "media",
    status,
    phase: status,
    message: status,
    ratio,
  };
}

function mediaLayer(overrides: Partial<MediaJobService> = {}) {
  const service: MediaJobService = {
    startPrepare: () => Effect.succeed("job-1"),
    startExport: () => Effect.succeed("job-1"),
    snapshot: () => Effect.succeed(Option.none()),
    observe: () => Stream.make(progress("running", 0.5), progress("completed", 1)),
    cancel: () => Effect.void,
    prepareResult: () => Effect.succeed(Option.none()),
    exportResult: () => Effect.succeed(Option.none()),
    ...overrides,
  };
  return Layer.succeed(MediaJobs, service);
}

describe("native job workflows", () => {
  it("starts and observes a media preparation job", async () => {
    const layer = mediaLayer();
    const running = await Effect.runPromise(
      prepareMedia({ projectId: "p1", revision: 2 }).pipe(Effect.provide(layer))
    );
    const events = await Effect.runPromise(
      Stream.runCollect(running.progress)
    );
    expect(Chunk.toReadonlyArray(events).map((event) => event.status)).toEqual([
      "running",
      "completed",
    ]);
  });

  it("returns a terminal snapshot without reopening event observation", async () => {
    let observed = false;
    const layer = mediaLayer({
      snapshot: () => Effect.succeed(Option.some(progress("completed", 1))),
      observe: () => {
        observed = true;
        return Stream.empty;
      },
    });
    const running = await Effect.runPromise(
      reconnectMediaJob("job-1").pipe(Effect.provide(layer))
    );
    const events = await Effect.runPromise(Stream.runCollect(running.progress));
    expect(Chunk.toReadonlyArray(events)).toHaveLength(1);
    expect(observed).toBe(false);
  });

  it("polls a second snapshot when completion races listener registration", async () => {
    let snapshots = 0;
    const layer = mediaLayer({
      snapshot: () =>
        Effect.sync(() => {
          snapshots += 1;
          return Option.some(
            snapshots === 1
              ? progress("running", 0.25)
              : progress("completed", 1)
          );
        }),
      observe: () => Stream.empty,
    });
    const running = await Effect.runPromise(
      reconnectMediaJob("job-1").pipe(Effect.provide(layer))
    );
    const events = Chunk.toReadonlyArray(
      await Effect.runPromise(Stream.runCollect(running.progress))
    );
    expect(events.map((event) => event.ratio)).toEqual([0.25, 1]);
  });

  it("emits a running snapshot before live events", async () => {
    const layer = mediaLayer({
      snapshot: () => Effect.succeed(Option.some(progress("running", 0.25))),
      observe: () => Stream.make(progress("completed", 1)),
    });
    const running = await Effect.runPromise(
      reconnectMediaJob("job-1").pipe(Effect.provide(layer))
    );
    const events = Chunk.toReadonlyArray(
      await Effect.runPromise(Stream.runCollect(running.progress))
    );
    expect(events.map((event) => event.ratio)).toEqual([0.25, 1]);
  });
});
