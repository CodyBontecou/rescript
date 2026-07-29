import { Effect, Layer } from "effect";
import {
  DEFAULT_TRANSCRIPTION_MODEL,
  Preferences,
  PreferencesError,
  type ModelChoice,
  type PreferencesService,
} from "@rescript/core";

const MODEL_KEY = "rescript:model";

function preferencesError(
  operation: PreferencesError["operation"],
  cause: unknown
) {
  return new PreferencesError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

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
      const value = localStorage.getItem(MODEL_KEY);
      return isModelChoice(value) ? value : DEFAULT_TRANSCRIPTION_MODEL;
    },
    catch: (cause) => preferencesError("load", cause),
  }),

  saveModel: (model) =>
    Effect.try({
      try: () => localStorage.setItem(MODEL_KEY, model),
      catch: (cause) => preferencesError("save", cause),
    }),
};

export const PreferencesWeb = Layer.succeed(Preferences, service);
