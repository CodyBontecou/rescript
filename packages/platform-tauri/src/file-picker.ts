import { invoke } from "@tauri-apps/api/core";
import { Effect, Layer, Option, Schema } from "effect";
import {
  FilePicker,
  FilePickerError,
  MediaKindSchema,
  type FilePickerService,
  type ImportedMedia,
  type ImportedTranscript,
} from "@rescript/core";

const ImportedMediaSchema = Schema.Struct({
  source: Schema.String,
  name: Schema.String,
  mediaType: Schema.String,
  mediaKind: MediaKindSchema,
  byteLength: Schema.Number,
});

const ImportedTranscriptSchema = Schema.Struct({
  name: Schema.String,
  text: Schema.String,
});

const ExportDestinationSchema = Schema.Struct({
  destination: Schema.String,
  displayName: Schema.String,
});

function pickerError(
  operation: FilePickerError["operation"],
  cause: unknown
) {
  let message = "Native file selection failed";
  if (cause instanceof Error) message = cause.message;
  else if (typeof cause === "string") message = cause;
  else if (cause && typeof cause === "object") {
    const value = cause as Record<string, unknown>;
    if (typeof value.message === "string") message = value.message;
    else {
      try {
        message = JSON.stringify(cause);
      } catch {
        // Keep the fallback.
      }
    }
  }
  return new FilePickerError({ operation, message, cause });
}

async function decodeMedia(value: unknown): Promise<ImportedMedia> {
  return (await Effect.runPromise(
    Schema.decodeUnknown(ImportedMediaSchema)(value)
  )) as ImportedMedia;
}

async function decodeTranscript(value: unknown): Promise<ImportedTranscript> {
  return (await Effect.runPromise(
    Schema.decodeUnknown(ImportedTranscriptSchema)(value)
  )) as ImportedTranscript;
}

const service: FilePickerService = {
  importMedia: Effect.tryPromise({
    try: async () => {
      const selected = await invoke<unknown | null>("pick_native_media");
      return selected === null
        ? Option.none<ImportedMedia>()
        : Option.some(await decodeMedia(selected));
    },
    catch: (cause) => pickerError("import-media", cause),
  }),

  importTranscript: Effect.tryPromise({
    try: async () => {
      const selected = await invoke<unknown | null>("pick_native_transcript");
      return selected === null
        ? Option.none<ImportedTranscript>()
        : Option.some(await decodeTranscript(selected));
    },
    catch: (cause) => pickerError("import-transcript", cause),
  }),

  exportDestination: (suggestedName, mediaKind) =>
    Effect.tryPromise({
      try: async () => {
        const selected = await invoke<unknown | null>("pick_export_destination", {
          suggestedName,
          mediaKind,
        });
        if (selected === null) return Option.none();
        return Option.some(
          await Effect.runPromise(
            Schema.decodeUnknown(ExportDestinationSchema)(selected)
          )
        );
      },
      catch: (cause) => pickerError("export", cause),
    }),
};

export const FilePickerTauri = Layer.succeed(FilePicker, service);
