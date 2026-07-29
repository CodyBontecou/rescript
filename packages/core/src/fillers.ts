import type { Word } from "./schema";

/**
 * Filler sounds that carry no meaning and can safely be cut. Deliberately
 * conservative: ambiguous words like "like", "so" or "right" are excluded
 * because they are usually legitimate.
 */
const FILLER_WORDS = new Set([
  "um",
  "umm",
  "ummm",
  "uh",
  "uhh",
  "uhm",
  "erm",
  "er",
  "err",
  "ah",
  "ahh",
  "eh",
  "ehm",
  "hm",
  "hmm",
  "hmmm",
  "mm",
  "mmm",
  "mhm",
  "mm-hmm",
  "uh-huh",
]);

/** Normalize a transcript token for matching: lowercase, strip punctuation. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}-]+$/gu, "");
}

export function isFillerWord(text: string): boolean {
  return FILLER_WORDS.has(normalize(text));
}

/** Ids of all not-yet-deleted filler words in the transcript. */
export function findFillerWordIds(words: Word[]): number[] {
  return words.filter((w) => !w.deleted && isFillerWord(w.text)).map((w) => w.id);
}
