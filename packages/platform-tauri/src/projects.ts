import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { Effect, Layer, Option, Schema } from "effect";
import {
  ProjectManifestSchema,
  ProjectRepository,
  ProjectRepositoryError,
  ProjectSummarySchema,
  type ProjectManifest,
  type ProjectRepositoryService,
  type ProjectSummary,
} from "@rescript/core";

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  if (cause && typeof cause === "object") {
    const value = cause as Record<string, unknown>;
    if (typeof value.message === "string") return value.message;
    try {
      return JSON.stringify(cause);
    } catch {
      // Fall through.
    }
  }
  return "Unknown native project error";
}

function repositoryError(
  operation: ProjectRepositoryError["operation"],
  cause: unknown
) {
  return new ProjectRepositoryError({
    operation,
    message: messageOf(cause),
    cause,
  });
}

async function decodeManifest(value: unknown): Promise<ProjectManifest> {
  const decoded = await Effect.runPromise(
    Schema.decodeUnknown(ProjectManifestSchema)(value)
  );
  return decoded as ProjectManifest;
}

async function decodeSummaries(value: unknown): Promise<readonly ProjectSummary[]> {
  const decoded = await Effect.runPromise(
    Schema.decodeUnknown(Schema.Array(ProjectSummarySchema))(value)
  );
  return decoded as readonly ProjectSummary[];
}

const service: ProjectRepositoryService = {
  list: Effect.tryPromise({
    try: async () => decodeSummaries(await invoke("list_projects")),
    catch: (cause) => repositoryError("list", cause),
  }),

  read: (id) =>
    Effect.tryPromise({
      try: async () => {
        const value = await invoke<unknown | null>("read_project", { id });
        return value === null
          ? Option.none<ProjectManifest>()
          : Option.some(await decodeManifest(value));
      },
      catch: (cause) => repositoryError("read", cause),
    }),

  create: (input) =>
    Effect.tryPromise({
      try: async () =>
        decodeManifest(
          await invoke("create_project", {
            input: {
              sourcePath: input.media.source,
              name: input.name,
              mediaType: input.media.mediaType,
              mediaKind: input.media.mediaKind,
              duration: input.duration,
              model: input.model,
              words: input.words ?? [],
            },
          })
        ),
      catch: (cause) => repositoryError("create", cause),
    }),

  save: (input) =>
    Effect.tryPromise({
      try: async () =>
        decodeManifest(
          await invoke("save_project", {
            input: {
              project: input.project,
              expectedRevision: input.expectedRevision,
            },
          })
        ),
      catch: (cause) => repositoryError("save", cause),
    }),

  remove: (id) =>
    Effect.tryPromise({
      try: () => invoke<void>("delete_project", { id }),
      catch: (cause) => repositoryError("remove", cause),
    }),
};

export const ProjectRepositoryTauri = Layer.succeed(ProjectRepository, service);

export async function getNativeProjectMediaPath(projectId: string) {
  return invoke<string>("project_media_path", { id: projectId });
}

/** Scoped asset URL suitable for a webview <video> or <audio> element. */
export async function getNativeProjectMediaUrl(projectId: string) {
  return convertFileSrc(await getNativeProjectMediaPath(projectId));
}
