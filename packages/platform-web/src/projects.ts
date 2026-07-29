import { Effect, Layer, Option } from "effect";
import {
  ProjectRepository,
  ProjectRepositoryError,
  decodeProjectManifest,
  type CreateProjectInput,
  type ImportedMedia,
  type ProjectManifest,
  type ProjectRepositoryService,
  type ProjectSummary,
} from "@rescript/core";

const DB_NAME = "rescript-effect-projects";
const DB_VERSION = 1;
const STORE = "projects";
const MAX_PROJECTS = 10;

interface WebProjectRecord {
  manifest: ProjectManifest;
  media: Blob;
}

const selectedMedia = new Map<string, File>();

/** Register browser-owned bytes and return a service-safe opaque media handle. */
export function registerWebMedia(file: File): ImportedMedia {
  const source = `web-memory:${crypto.randomUUID()}`;
  selectedMedia.set(source, file);
  return {
    source,
    name: file.name,
    mediaType: file.type || "application/octet-stream",
    mediaKind: file.type.startsWith("audio/") ? "audio" : "video",
    byteLength: file.size,
  };
}

function repositoryError(
  operation: ProjectRepositoryError["operation"],
  cause: unknown
) {
  return new ProjectRepositoryError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE, { keyPath: "manifest.id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open project database"));
  });
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

async function validateManifest(value: unknown): Promise<ProjectManifest> {
  await Effect.runPromise(decodeProjectManifest(value));
  return value as ProjectManifest;
}

function summaryOf(manifest: ProjectManifest): ProjectSummary {
  return {
    id: manifest.id,
    revision: manifest.revision,
    name: manifest.name,
    mediaKind: manifest.media.mediaKind,
    duration: manifest.duration,
    model: manifest.model,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
  };
}

async function allRecords(database: IDBDatabase): Promise<WebProjectRecord[]> {
  const transaction = database.transaction(STORE, "readonly");
  const records = await idbRequest(
    transaction.objectStore(STORE).getAll() as IDBRequest<WebProjectRecord[]>
  );
  await transactionDone(transaction);
  return records;
}

const service: ProjectRepositoryService = {
  list: Effect.tryPromise({
    try: async () => {
      const database = await openDatabase();
      try {
        const records = await allRecords(database);
        return records
          .map((record) => summaryOf(record.manifest))
          .sort((left, right) => right.updatedAt - left.updatedAt);
      } finally {
        database.close();
      }
    },
    catch: (cause) => repositoryError("list", cause),
  }),

  read: (id) =>
    Effect.tryPromise({
      try: async () => {
        const database = await openDatabase();
        try {
          const transaction = database.transaction(STORE, "readonly");
          const record = await idbRequest(
            transaction.objectStore(STORE).get(id) as IDBRequest<
              WebProjectRecord | undefined
            >
          );
          await transactionDone(transaction);
          return record
            ? Option.some(await validateManifest(record.manifest))
            : Option.none<ProjectManifest>();
        } finally {
          database.close();
        }
      },
      catch: (cause) => repositoryError("read", cause),
    }),

  create: (input: CreateProjectInput) =>
    Effect.tryPromise({
      try: async () => {
        const media = selectedMedia.get(input.media.source);
        if (!media) throw new Error("Selected browser media is no longer available");
        const now = Date.now();
        const manifest: ProjectManifest = {
          schemaVersion: 1,
          id: crypto.randomUUID(),
          revision: 0,
          name: input.name,
          media: {
            relativePath: "media/original",
            name: input.media.name,
            mediaType: input.media.mediaType,
            mediaKind: input.media.mediaKind,
            byteLength: input.media.byteLength,
          },
          duration: input.duration ?? 0,
          model: input.model,
          words: [...(input.words ?? [])],
          manualCuts: [],
          sceneBoundaries: [],
          showDeleted: false,
          createdAt: now,
          updatedAt: now,
        };
        await validateManifest(manifest);

        const database = await openDatabase();
        try {
          const transaction = database.transaction(STORE, "readwrite");
          const store = transaction.objectStore(STORE);
          store.put({ manifest, media } satisfies WebProjectRecord);
          const records = await idbRequest(
            store.getAll() as IDBRequest<WebProjectRecord[]>
          );
          for (const record of records
            .filter((record) => record.manifest.id !== manifest.id)
            .sort((left, right) =>
              left.manifest.updatedAt - right.manifest.updatedAt
            )
            .slice(0, Math.max(0, records.length - MAX_PROJECTS))) {
            store.delete(record.manifest.id);
          }
          await transactionDone(transaction);
        } finally {
          database.close();
        }
        selectedMedia.delete(input.media.source);
        return manifest;
      },
      catch: (cause) => repositoryError("create", cause),
    }),

  save: ({ project, expectedRevision }) =>
    Effect.tryPromise({
      try: async () => {
        const manifest: ProjectManifest = {
          ...project,
          revision: expectedRevision + 1,
          updatedAt: Date.now(),
        };
        await validateManifest(manifest);
        const database = await openDatabase();
        try {
          const transaction = database.transaction(STORE, "readwrite");
          const store = transaction.objectStore(STORE);
          const current = await idbRequest(
            store.get(project.id) as IDBRequest<WebProjectRecord | undefined>
          );
          if (!current) throw new Error(`Project ${project.id} does not exist`);
          if (current.manifest.revision !== expectedRevision) {
            throw new Error(
              `Revision conflict: expected ${expectedRevision}, found ${current.manifest.revision}`
            );
          }
          store.put({ manifest, media: current.media } satisfies WebProjectRecord);
          await transactionDone(transaction);
          return manifest;
        } finally {
          database.close();
        }
      },
      catch: (cause) => repositoryError("save", cause),
    }),

  remove: (id) =>
    Effect.tryPromise({
      try: async () => {
        const database = await openDatabase();
        try {
          const transaction = database.transaction(STORE, "readwrite");
          transaction.objectStore(STORE).delete(id);
          await transactionDone(transaction);
        } finally {
          database.close();
        }
      },
      catch: (cause) => repositoryError("remove", cause),
    }),
};

export const ProjectRepositoryWeb = Layer.succeed(ProjectRepository, service);

/** Resolve persisted browser media for preview; URLs remain a UI concern. */
export async function getWebProjectMedia(projectId: string): Promise<File | null> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE, "readonly");
    const record = await idbRequest(
      transaction.objectStore(STORE).get(projectId) as IDBRequest<
        WebProjectRecord | undefined
      >
    );
    await transactionDone(transaction);
    if (!record) return null;
    return new File([record.media], record.manifest.media.name, {
      type: record.manifest.media.mediaType,
      lastModified: record.manifest.updatedAt,
    });
  } finally {
    database.close();
  }
}
