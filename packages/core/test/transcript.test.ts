import { describe, expect, it } from "vitest";
import { isTranscriptSource, parseTranscript } from "../src/transcript";

const srt = `1
00:00:01,000 --> 00:00:03,000
Hello world

2
00:00:04,500 --> 00:00:06,000
Alice: How are you?
`;

const vtt = `WEBVTT

00:01.000 --> 00:03.000
<v Alice>Hello world</v>
`;

describe("transcript parsing", () => {
  it("parses SRT cues and speaker labels", () => {
    const words = parseTranscript(srt, "sample.srt");
    expect(words.map((word) => word.text)).toEqual([
      "Hello",
      "world",
      "How",
      "are",
      "you?",
    ]);
    expect(words[0].start).toBe(1);
    expect(words[1].end).toBe(3);
    expect(words[2].speaker).toBe(0);
  });

  it("parses WebVTT voice spans", () => {
    const words = parseTranscript(vtt, "sample.vtt");
    expect(words).toHaveLength(2);
    expect(words[1].end).toBe(3);
  });

  it("parses JSON word arrays", () => {
    const words = parseTranscript(
      JSON.stringify({
        words: [
          { text: "hello", start: 0, end: 0.5, speaker: "Cody" },
          { word: "world", start: 0.5, end: 1, speaker: "Cody" },
        ],
      }),
      "sample.json"
    );
    expect(words.map((word) => word.speaker)).toEqual([0, 0]);
  });

  it("detects supported transcript sources without browser File objects", () => {
    expect(isTranscriptSource("captions.srt")).toBe(true);
    expect(isTranscriptSource("captions", "application/json")).toBe(true);
    expect(isTranscriptSource("captions.txt", "text/plain")).toBe(false);
  });
});
