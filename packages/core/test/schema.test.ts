import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRANSCRIPTION_MODEL,
  decodeProjectManifest,
} from "../src/schema";

function manifest() {
  return {
    schemaVersion: 1 as const,
    id: "project-1",
    revision: 0,
    name: "Interview",
    media: {
      relativePath: "media/original.mov",
      name: "interview.mov",
      mediaType: "video/quicktime",
      mediaKind: "video" as const,
      byteLength: 1234,
    },
    duration: 12,
    model: "base" as const,
    speakerDiarizationEnabled: false,
    words: [
      {
        id: 0,
        text: "Hello",
        start: 0,
        end: 0.4,
        speaker: 0,
        deleted: false,
      },
    ],
    manualCuts: [],
    sceneBoundaries: [],
    showDeleted: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("project manifest schema", () => {
  it("uses Parakeet v2 as the shared transcription default", () => {
    expect(DEFAULT_TRANSCRIPTION_MODEL).toBe("parakeet-v2");
  });

  it("decodes a valid versioned project", async () => {
    const decoded = await Effect.runPromise(decodeProjectManifest(manifest()));
    expect(decoded.id).toBe("project-1");
    expect(decoded.schemaVersion).toBe(1);
    expect(decoded.speakerDiarizationEnabled).toBe(false);
  });

  it("keeps diarization enabled for legacy manifests", async () => {
    const { speakerDiarizationEnabled: _, ...legacy } = manifest();
    const decoded = await Effect.runPromise(decodeProjectManifest(legacy));
    expect(decoded.speakerDiarizationEnabled).toBe(true);
  });

  it.each(["parakeet-v2", "parakeet-v3"] as const)(
    "decodes the %s transcription model",
    async (model) => {
      const input = { ...manifest(), model };
      const decoded = await Effect.runPromise(decodeProjectManifest(input));
      expect(decoded.model).toBe(model);
    }
  );

  it("rejects non-finite and inverted word timings", async () => {
    const invalid = manifest();
    invalid.words[0].start = 0.5;
    invalid.words[0].end = 0.2;
    await expect(
      Effect.runPromise(decodeProjectManifest(invalid))
    ).rejects.toBeDefined();
  });

  it("rejects unordered words, duplicate IDs, and negative speakers", async () => {
    const unordered = manifest();
    unordered.words[0].start = 0.5;
    unordered.words[0].end = 0.8;
    unordered.words.push({
      id: 1,
      text: "Earlier",
      start: 0.1,
      end: 0.3,
      speaker: 0,
      deleted: false,
    });
    await expect(
      Effect.runPromise(decodeProjectManifest(unordered))
    ).rejects.toBeDefined();

    const duplicate = manifest();
    duplicate.words.push({
      id: 0,
      text: "Duplicate",
      start: 0.5,
      end: 0.8,
      speaker: 0,
      deleted: false,
    });
    await expect(
      Effect.runPromise(decodeProjectManifest(duplicate))
    ).rejects.toBeDefined();

    const negativeSpeaker = manifest();
    negativeSpeaker.words[0].speaker = -1;
    await expect(
      Effect.runPromise(decodeProjectManifest(negativeSpeaker))
    ).rejects.toBeDefined();
  });

  it("rejects timings outside media duration", async () => {
    const invalid = manifest();
    invalid.words[0].end = 13;
    await expect(
      Effect.runPromise(decodeProjectManifest(invalid))
    ).rejects.toBeDefined();
  });
});
