import { Layer } from "effect";
import { FilePickerTauri } from "./file-picker";
import { MediaJobsTauri } from "./media-jobs";
import { ModelRepositoryTauri } from "./models";
import { PlaybackControllerTauri } from "./playback";
import { PreferencesTauri } from "./preferences";
import { ProjectRepositoryTauri } from "./projects";
import { TranscriptionJobsTauri } from "./transcription-jobs";

export * from "./file-picker";
export * from "./media-jobs";
export * from "./models";
export * from "./playback";
export * from "./preferences";
export * from "./projects";
export * from "./transcription-jobs";

export const TauriPlatformLive = Layer.mergeAll(
  ProjectRepositoryTauri,
  TranscriptionJobsTauri,
  FilePickerTauri,
  MediaJobsTauri,
  ModelRepositoryTauri,
  PlaybackControllerTauri,
  PreferencesTauri
);
