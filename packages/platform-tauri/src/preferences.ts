import { Effect, Layer } from "effect";
import {
  Preferences,
  PreferencesError,
  type ModelChoice,
  type PreferencesService,
} from "@rescript/core";

const MODEL_KEY = "rescript.native:model";

function isModelChoice(value: unknown): value is ModelChoice {
  return (
    value === "base" ||
    value === "small" ||
    value === "parakeet-v2" ||
    value === "parakeet-v3" ||
    value === "import"
  );
}

const service: PreferencesService = {
  loadModel: Effect.try({
    try: () => {
      const stored = localStorage.getItem(MODEL_KEY);
      return isModelChoice(stored) ? stored : "base";
    },
    catch: (cause) =>
      new PreferencesError({
        operation: "load",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  }),

  saveModel: (model) =>
    Effect.try({
      try: () => localStorage.setItem(MODEL_KEY, model),
      catch: (cause) =>
        new PreferencesError({
          operation: "save",
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    }),
};

export const PreferencesTauri = Layer.succeed(Preferences, service);
