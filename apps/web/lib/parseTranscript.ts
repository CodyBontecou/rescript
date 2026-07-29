import {
  isTranscriptSource,
  parseTranscript,
  TRANSCRIPT_ACCEPT,
} from "@rescript/core/transcript";
import type { Word } from "@rescript/core";

export { parseTranscript, TRANSCRIPT_ACCEPT };

export function isTranscriptFile(file: File): boolean {
  return isTranscriptSource(file.name, file.type);
}

export async function parseTranscriptFile(file: File): Promise<Word[]> {
  return parseTranscript(await file.text(), file.name);
}
