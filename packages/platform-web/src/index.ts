import { Layer } from "effect";
import { FilePickerWeb } from "./file-picker";
import { PlaybackControllerWeb } from "./playback";
import { PreferencesWeb } from "./preferences";
import { ProjectRepositoryWeb } from "./projects";

export * from "./file-picker";
export * from "./playback";
export * from "./preferences";
export * from "./projects";

export const WebPlatformLive = Layer.mergeAll(
  ProjectRepositoryWeb,
  FilePickerWeb,
  PlaybackControllerWeb,
  PreferencesWeb
);
