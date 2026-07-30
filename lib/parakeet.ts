import type { Word } from "./types";

export interface ParakeetTimedWord {
  text: string;
  start_time: number;
  end_time: number;
}

/** Map Parakeet word timings from an ASR slice onto the source-media timeline. */
export function wordsFromParakeet(
  chunks: readonly ParakeetTimedWord[],
  offsetS: number,
  mediaDuration: number,
  startingId: number
): Word[] {
  const words: Word[] = [];

  for (const chunk of chunks) {
    const text = chunk.text.trim();
    if (
      !text ||
      !Number.isFinite(chunk.start_time) ||
      !Number.isFinite(chunk.end_time)
    ) {
      continue;
    }

    const start = Math.max(
      0,
      Math.min(mediaDuration, offsetS + chunk.start_time)
    );
    const end = Math.min(
      mediaDuration,
      Math.max(start + 0.01, offsetS + chunk.end_time)
    );
    if (start >= mediaDuration || end <= start) continue;

    words.push({
      id: startingId + words.length,
      text,
      start,
      end,
      speaker: 0,
      deleted: false,
    });
  }

  return words;
}
