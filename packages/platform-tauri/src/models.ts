import { invoke } from "@tauri-apps/api/core";
import { Effect, Layer, Schema } from "effect";
import {
  ModelDescriptorSchema,
  ModelRepository,
  ModelRepositoryError,
  type ModelDescriptor,
  type ModelRepositoryService,
} from "@rescript/core";

function modelError(
  operation: ModelRepositoryError["operation"],
  cause: unknown
) {
  return new ModelRepositoryError({
    operation,
    message:
      cause instanceof Error
        ? cause.message
        : typeof cause === "string"
          ? cause
          : "Native model operation failed",
    cause,
  });
}

const service: ModelRepositoryService = {
  list: Effect.tryPromise({
    try: async () =>
      (await Effect.runPromise(
        Schema.decodeUnknown(Schema.Array(ModelDescriptorSchema))(
          await invoke("list_native_models")
        )
      )) as readonly ModelDescriptor[],
    catch: (cause) => modelError("list", cause),
  }),
  remove: (model) =>
    Effect.tryPromise({
      try: () => invoke<void>("remove_native_model", { model }),
      catch: (cause) => modelError("remove", cause),
    }),
};

export const ModelRepositoryTauri = Layer.succeed(ModelRepository, service);
