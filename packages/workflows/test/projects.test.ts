import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  FilePicker,
  ProjectRepository,
  type FilePickerService,
  type ProjectManifest,
  type ProjectRepositoryService,
} from "@rescript/core";
import {
  chooseMediaAndCreateProject,
  chooseTranscript,
  saveProject,
  withEditorDocument,
} from "../src/projects";

function project(revision = 0): ProjectManifest {
  return {
    schemaVersion: 1,
    id: "p1",
    revision,
    name: "clip.mov",
    media: {
      relativePath: "media/original.mov",
      name: "clip.mov",
      mediaType: "video/quicktime",
      mediaKind: "video",
      byteLength: 10,
    },
    duration: 2,
    model: "base",
    words: [],
    manualCuts: [],
    sceneBoundaries: [],
    showDeleted: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function repositoryLayer(
  overrides: Partial<ProjectRepositoryService> = {}
) {
  const service: ProjectRepositoryService = {
    list: Effect.succeed([]),
    read: () => Effect.succeed(Option.none()),
    create: () => Effect.succeed(project()),
    save: ({ project: value, expectedRevision }) =>
      Effect.succeed({ ...value, revision: expectedRevision + 1 }),
    remove: () => Effect.void,
    ...overrides,
  };
  return Layer.succeed(ProjectRepository, service);
}

function pickerLayer(overrides: Partial<FilePickerService> = {}) {
  const service: FilePickerService = {
    importMedia: Effect.succeed(Option.none()),
    importTranscript: Effect.succeed(Option.none()),
    exportDestination: () => Effect.succeed(Option.none()),
    ...overrides,
  };
  return Layer.succeed(FilePicker, service);
}

describe("project workflows", () => {
  it("treats a cancelled media picker as a successful no-op", async () => {
    const value = await Effect.runPromise(
      chooseMediaAndCreateProject({ model: "base" }).pipe(
        Effect.provide(Layer.merge(repositoryLayer(), pickerLayer()))
      )
    );
    expect(Option.isNone(value)).toBe(true);
  });

  it("creates a project from an opaque selected-media handle", async () => {
    let receivedName = "";
    const repository = repositoryLayer({
      create: (input) => {
        receivedName = input.name;
        return Effect.succeed(project());
      },
    });
    const picker = pickerLayer({
      importMedia: Effect.succeed(
        Option.some({
          source: "test:1",
          name: "clip.mov",
          mediaType: "video/quicktime",
          mediaKind: "video",
          byteLength: 10,
        })
      ),
    });
    const value = await Effect.runPromise(
      chooseMediaAndCreateProject({ model: "small" }).pipe(
        Effect.provide(Layer.merge(repository, picker))
      )
    );
    expect(Option.isSome(value)).toBe(true);
    expect(receivedName).toBe("clip.mov");
  });

  it("parses a selected transcript through the shared parser", async () => {
    const picker = pickerLayer({
      importTranscript: Effect.succeed(
        Option.some({
          name: "clip.srt",
          text: "1\n00:00:00,000 --> 00:00:01,000\nHello world\n",
        })
      ),
    });
    const value = await Effect.runPromise(
      chooseTranscript.pipe(Effect.provide(picker))
    );
    expect(Option.getOrThrow(value).map((word) => word.text)).toEqual([
      "Hello",
      "world",
    ]);
  });

  it("passes the current revision to optimistic saves", async () => {
    let expected = -1;
    const repository = repositoryLayer({
      save: ({ project: value, expectedRevision }) => {
        expected = expectedRevision;
        return Effect.succeed({ ...value, revision: expectedRevision + 1 });
      },
    });
    const saved = await Effect.runPromise(
      saveProject(project(4)).pipe(Effect.provide(repository))
    );
    expect(expected).toBe(4);
    expect(saved.revision).toBe(5);
  });

  it("projects shared editor state into a manifest", () => {
    const updated = withEditorDocument(
      project(),
      {
        duration: 2,
        words: [
          { id: 0, text: "hello", start: 0, end: 1, speaker: 0, deleted: false },
        ],
        manualCuts: [{ id: 1, start: 1, end: 1.2 }],
        sceneBoundaries: [],
        nextManualCutId: 2,
        nextBoundaryId: 1,
      },
      true
    );
    expect(updated.words).toHaveLength(1);
    expect(updated.showDeleted).toBe(true);
  });
});
