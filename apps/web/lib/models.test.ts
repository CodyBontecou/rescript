import { describe, expect, it } from "vitest";
import {
  MODELS,
  PARAKEET_MODELS,
  TRANSCRIPTION_MODEL_ORDER,
  isModelChoice,
  isParakeetModel,
  isTranscriptionModel,
} from "./models";

describe("transcription models", () => {
  it("offers Parakeet v2 and v3 in the model catalog", () => {
    expect(TRANSCRIPTION_MODEL_ORDER).toEqual([
      "base",
      "small",
      "parakeet-v2",
      "parakeet-v3",
    ]);
    expect(PARAKEET_MODELS["parakeet-v2"]).toMatchObject({
      engine: "parakeet",
      id: "parakeet-tdt-0.6b-v2",
    });
    expect(PARAKEET_MODELS["parakeet-v3"]).toMatchObject({
      engine: "parakeet",
      id: "parakeet-tdt-0.6b-v3",
    });
    expect(Object.keys(MODELS)).toEqual(TRANSCRIPTION_MODEL_ORDER);
  });

  it.each(["parakeet-v2", "parakeet-v3"] as const)(
    "recognizes %s as a local transcription model",
    (model) => {
      expect(isParakeetModel(model)).toBe(true);
      expect(isTranscriptionModel(model)).toBe(true);
      expect(isModelChoice(model)).toBe(true);
    }
  );

  it("keeps import separate from runnable transcription models", () => {
    expect(isModelChoice("import")).toBe(true);
    expect(isTranscriptionModel("import")).toBe(false);
    expect(isParakeetModel("base")).toBe(false);
    expect(isModelChoice("parakeet-v4")).toBe(false);
  });
});
