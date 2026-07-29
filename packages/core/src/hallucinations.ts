import type { Word } from "./schema";

/**
 * Known Whisper hallucination phrases. These often appear as sudden topic
 * shifts near silence, music, or chunk boundaries — especially with the
 * smaller base model on longer audio.
 */
const HALLUCINATION_PHRASES = [
  "i'm sorry",
  "i am sorry",
  "thank you for watching",
  "thanks for watching",
  "please subscribe",
  "like and subscribe",
  "subscribe to my channel",
  "see you next time",
  "thanks for listening",
  "subtitles by the amara.org community",
  "subtitles by",
  "www.youtube.com",
].map((p) => p.split(/\s+/));

function normalizeToken(text: string): string {
  return text.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'-]+$/gu, "");
}

function wordKey(w: Word): string {
  return normalizeToken(w.text);
}

/**
 * Collapse consecutive repeating n-grams (e.g. "little bit of a" × N) down to
 * a single occurrence. Walks greedily left-to-right. Among candidates at each
 * position, prefers the collapse that removes the most words (so "little bit
 * of a" ×4 wins over that phrase-pair ×2). Longer phrases need only 2
 * consecutive copies; short ones need 3 to avoid collapsing "yes yes yes".
 */
export function collapseRepeatingNgrams(
  words: Word[],
  { minN = 2, maxN = 8 }: { minN?: number; maxN?: number } = {}
): Word[] {
  if (words.length < minN * 2) return words;
  const keys = words.map(wordKey);
  const out: Word[] = [];
  let i = 0;
  while (i < words.length) {
    const maxLen = Math.min(maxN, Math.floor((words.length - i) / 2));
    let bestN = 0;
    let bestRepeats = 0;
    for (let n = maxLen; n >= minN; n--) {
      const minRepeats = n >= 4 ? 2 : 3;
      if (i + n * minRepeats > words.length) continue;
      const unit = keys.slice(i, i + n);
      if (unit.some((k) => !k)) continue;
      let repeats = 1;
      while (
        i + (repeats + 1) * n <= words.length &&
        unit.every((k, j) => keys[i + repeats * n + j] === k)
      ) {
        repeats++;
      }
      if (repeats < minRepeats) continue;
      const removed = (repeats - 1) * n;
      const bestRemoved = (bestRepeats - 1) * bestN;
      if (removed > bestRemoved || (removed === bestRemoved && repeats > bestRepeats)) {
        bestN = n;
        bestRepeats = repeats;
      }
    }
    if (bestN > 0) {
      out.push(...words.slice(i, i + bestN));
      i += bestRepeats * bestN;
    } else {
      out.push(words[i]);
      i++;
    }
  }
  return out;
}

/**
 * Drop known hallucination phrases when they appear as contiguous runs.
 * Only removes phrases that are fully matched; surrounding real speech is kept.
 */
export function stripHallucinationPhrases(words: Word[]): Word[] {
  if (words.length === 0) return words;
  const keys = words.map(wordKey);
  const drop = new Array(words.length).fill(false);

  for (let i = 0; i < keys.length; i++) {
    for (const phrase of HALLUCINATION_PHRASES) {
      if (i + phrase.length > keys.length) continue;
      if (phrase.every((tok, j) => keys[i + j] === tok)) {
        for (let j = 0; j < phrase.length; j++) drop[i + j] = true;
      }
    }
  }
  return words.filter((_, i) => !drop[i]);
}

/**
 * Drop a trailing run of near-identical short words that often appears when
 * Whisper loops at the end of a clip (e.g. a dozen "um" / "you" / "." tokens).
 */
export function trimTrailingDegenerateTail(words: Word[]): Word[] {
  if (words.length < 8) return words;
  const keys = words.map(wordKey);
  const window = 6;
  let cutFrom = words.length;

  for (let i = words.length - 1; i >= window; i--) {
    const unique = new Set<string>();
    for (let j = i - window + 1; j <= i; j++) {
      if (keys[j]) unique.add(keys[j]!);
    }
    // Degenerate: ≤2 distinct tokens in a 6-word window near the end.
    if (unique.size > 0 && unique.size <= 2) {
      cutFrom = i - window + 1;
    } else if (cutFrom < words.length) {
      break;
    }
  }
  // Only trim if we'd drop a meaningful chunk (≥6 words) of the tail.
  if (words.length - cutFrom >= 6) return words.slice(0, cutFrom);
  return words;
}

/** Apply all hallucination cleanups and re-index word ids. */
export function cleanTranscript(words: Word[]): Word[] {
  let cleaned = collapseRepeatingNgrams(words);
  cleaned = stripHallucinationPhrases(cleaned);
  cleaned = trimTrailingDegenerateTail(cleaned);
  return cleaned.map((w, i) => (w.id === i ? w : { ...w, id: i }));
}
