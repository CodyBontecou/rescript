import { Effect, Layer, Option } from "effect";
import {
  FilePicker,
  FilePickerError,
  type ExportDestination,
  type FilePickerService,
  type MediaKind,
} from "@rescript/core";
import { isTranscriptSource } from "@rescript/core/transcript";
import { registerWebMedia } from "./projects";

function pickerError(
  operation: FilePickerError["operation"],
  cause: unknown
) {
  return new FilePickerError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

function chooseFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    let settled = false;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => finish(input.files?.[0] ?? null), {
      once: true,
    });
    input.addEventListener("cancel", () => finish(null), { once: true });
    document.body.append(input);
    input.click();
  });
}

const service: FilePickerService = {
  importMedia: Effect.tryPromise({
    try: async () => {
      const file = await chooseFile("video/*,audio/*,.mkv,.webm,.mov,.mp4,.m4a,.mp3,.wav");
      return file ? Option.some(registerWebMedia(file)) : Option.none();
    },
    catch: (cause) => pickerError("import-media", cause),
  }),

  importTranscript: Effect.tryPromise({
    try: async () => {
      const file = await chooseFile(".srt,.vtt,.json,application/json,text/vtt");
      if (!file) return Option.none();
      if (!isTranscriptSource(file.name, file.type)) {
        throw new Error(`Unsupported transcript type: ${file.name}`);
      }
      return Option.some({ name: file.name, text: await file.text() });
    },
    catch: (cause) => pickerError("import-transcript", cause),
  }),

  exportDestination: (suggestedName: string, mediaKind: MediaKind) =>
    Effect.succeed(
      Option.some({
        destination: `web-download:${suggestedName}`,
        displayName:
          suggestedName || (mediaKind === "audio" ? "export.wav" : "export.mp4"),
      })
    ),
};

export const FilePickerWeb = Layer.succeed(FilePicker, service);

/** Complete a browser export selected through FilePickerWeb. */
export function downloadWebExport(
  destination: ExportDestination,
  data: Blob
): void {
  if (!destination.destination.startsWith("web-download:")) {
    throw new Error("Export destination was not created by the web adapter");
  }
  const url = URL.createObjectURL(data);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = destination.displayName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
