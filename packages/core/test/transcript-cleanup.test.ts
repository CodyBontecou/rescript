import { describe, expect, it } from "vitest";
import { findFillerWordIds } from "../src/fillers";
import {
  cleanTranscript,
  collapseRepeatingNgrams,
  stripHallucinationPhrases,
} from "../src/hallucinations";
import {
  VAD_SAMPLE_RATE,
  energySpeechFrames,
  speechSegmentsFromFrames,
} from "../src/vad";
import type { Word } from "../src/schema";

function words(text: string): Word[] {
  return text.split(" ").map((token, id) => ({
    id,
    text: token,
    start: id * 0.3,
    end: id * 0.3 + 0.25,
    speaker: 0,
    deleted: false,
  }));
}

describe("transcript cleanup", () => {
  it("collapses repeating ngrams", () => {
    const value = words(
      "little bit of a little bit of a little bit of a little bit of a"
    );
    expect(collapseRepeatingNgrams(value).map((word) => word.text).join(" ")).toBe(
      "little bit of a"
    );
  });

  it("removes known hallucination phrases", () => {
    const value = words("okay I'm sorry thanks for watching next topic");
    expect(stripHallucinationPhrases(value).map((word) => word.text).join(" ")).toBe(
      "okay next topic"
    );
  });

  it("finds conservative filler words", () => {
    expect(findFillerWordIds(words("hello um like uh world"))).toEqual([1, 3]);
  });

  it("reindexes cleaned transcripts", () => {
    expect(cleanTranscript(words("thanks for watching hello"))[0]).toMatchObject({
      id: 0,
      text: "hello",
    });
  });
});

describe("voice activity helpers", () => {
  it("splits speech around long silence", () => {
    const audio = new Float32Array(VAD_SAMPLE_RATE * 6);
    for (let i = 0; i < VAD_SAMPLE_RATE * 3; i++) {
      audio[i] = Math.sin(i / 20) * 0.3;
    }
    for (let i = VAD_SAMPLE_RATE * 5; i < audio.length; i++) {
      audio[i] = Math.sin(i / 20) * 0.3;
    }
    const segments = speechSegmentsFromFrames(
      energySpeechFrames(audio),
      audio.length,
      { maxGapS: 1.5, padS: 0.1 }
    );
    expect(segments).toHaveLength(2);
  });
});
