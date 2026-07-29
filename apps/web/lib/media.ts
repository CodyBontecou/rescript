import type { MediaKind } from "@rescript/core";

export type { MediaKind } from "@rescript/core";

const VIDEO_EXT = /\.(mp4|webm|mov|mkv|m4v)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac|opus|wma)$/i;

/** Classify a File as video, audio, or unsupported (null). */
export function detectMediaKind(file: File): MediaKind | null {
  if (file.type.startsWith("video/") || VIDEO_EXT.test(file.name)) return "video";
  if (file.type.startsWith("audio/") || AUDIO_EXT.test(file.name)) return "audio";
  return null;
}

export const MEDIA_ACCEPT =
  "video/*,audio/*,.mp4,.webm,.mov,.mkv,.m4v,.mp3,.wav,.m4a,.aac,.ogg,.flac,.opus";
