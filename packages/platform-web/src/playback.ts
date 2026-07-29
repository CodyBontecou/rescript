import { Effect, Layer } from "effect";
import {
  PlaybackController,
  PlaybackError,
  type PlaybackControllerService,
} from "@rescript/core";
import { getWebProjectMedia } from "./projects";

const service: PlaybackControllerService = {
  source: (projectId) =>
    Effect.tryPromise({
      try: async () => {
        const media = await getWebProjectMedia(projectId);
        if (!media) throw new Error(`Project ${projectId} has no stored media`);
        return { projectId, url: URL.createObjectURL(media) };
      },
      catch: (cause) =>
        new PlaybackError({
          operation: "source",
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    }),
  release: (source) =>
    Effect.sync(() => {
      URL.revokeObjectURL(source.url);
    }),
};

export const PlaybackControllerWeb = Layer.succeed(PlaybackController, service);
