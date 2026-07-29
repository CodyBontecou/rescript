import { describe, expect, it } from "vitest";
import { wordsFromParakeet } from "./parakeet";

describe("Parakeet word timestamps", () => {
  it("maps slice-local timings onto the media timeline", () => {
    expect(
      wordsFromParakeet(
        [
          { text: " Hello ", start_time: 0.1, end_time: 0.4 },
          { text: "world.", start_time: 0.4, end_time: 0.9 },
        ],
        12,
        30,
        5
      )
    ).toEqual([
      {
        id: 5,
        text: "Hello",
        start: 12.1,
        end: 12.4,
        speaker: 0,
        deleted: false,
      },
      {
        id: 6,
        text: "world.",
        start: 12.4,
        end: 12.9,
        speaker: 0,
        deleted: false,
      },
    ]);
  });

  it("drops invalid and out-of-range timings and clamps the media end", () => {
    const words = wordsFromParakeet(
      [
        { text: "", start_time: 0, end_time: 0.2 },
        { text: "invalid", start_time: Number.NaN, end_time: 0.3 },
        { text: "last", start_time: 0.8, end_time: 1.5 },
        { text: "outside", start_time: 1.2, end_time: 1.4 },
      ],
      9,
      10,
      0
    );

    expect(words).toHaveLength(1);
    expect(words[0]).toMatchObject({ text: "last", start: 9.8, end: 10 });
  });
});
