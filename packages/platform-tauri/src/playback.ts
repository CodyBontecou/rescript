import { Effect, Layer } from "effect";
import {
  PlaybackController,
  PlaybackError,
  type PlaybackControllerService,
} from "@rescript/core";
import { getNativeProjectMediaUrl } from "./projects";

const service: PlaybackControllerService = {
  source: (projectId) =>
    Effect.tryPromise({
      try: async () => ({
        projectId,
        url: await getNativeProjectMediaUrl(projectId),
      }),
      catch: (cause) =>
        new PlaybackError({
          operation: "source",
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    }),
  release: () => Effect.void,
};

export const PlaybackControllerTauri = Layer.succeed(
  PlaybackController,
  service
);
