/** Transcription source choices offered on the upload screen. */
export type WhisperModel = "base" | "small";
export type ParakeetModel = "parakeet-v2";
export type TranscriptionModel = WhisperModel | ParakeetModel;
export type ModelChoice = TranscriptionModel | "import";

/** Default for fresh sessions and invalid/stale persisted choices. */
export const DEFAULT_TRANSCRIPTION_MODEL: TranscriptionModel = "parakeet-v2";

type DType = "fp32" | "fp16" | "q8" | "int8" | "uint8" | "q4" | "q4f16" | "bnb4";

interface BaseModelInfo {
  id: string;
  label: string;
  description: string;
  /** Approximate first-use download size shown in the UI. */
  size: string;
  engine: "whisper" | "parakeet";
  /** Kept common so model-regression checks can inspect every entry safely. */
  verbatimPrompt?: string;
}

export interface WhisperModelInfo extends BaseModelInfo {
  engine: "whisper";
  /** dtype configuration per device. */
  dtype: {
    webgpu: Record<string, DType>;
    wasm: Record<string, DType>;
  };
}

export interface ParakeetModelInfo extends BaseModelInfo {
  engine: "parakeet";
}

export type ModelInfo = WhisperModelInfo | ParakeetModelInfo;

/** Display order for local speech models in source dropdowns. */
export const TRANSCRIPTION_MODEL_ORDER: TranscriptionModel[] = [
  "parakeet-v2",
  "base",
  "small",
];

/** Display order for Whisper-only callers. */
export const WHISPER_ORDER: WhisperModel[] = ["base", "small"];

/** @deprecated Prefer TRANSCRIPTION_MODEL_ORDER. */
export const MODEL_ORDER = TRANSCRIPTION_MODEL_ORDER;

const WHISPER_DTYPE = {
  // q4 decoder: q8 fails session creation on onnxruntime-web 1.26
  // (Missing required scale … MatMulNBits).
  webgpu: { encoder_model: "fp32", decoder_model_merged: "q4" },
  wasm: { encoder_model: "fp32", decoder_model_merged: "q4" },
} satisfies WhisperModelInfo["dtype"];

export const WHISPER_MODELS: Record<WhisperModel, WhisperModelInfo> = {
  base: {
    engine: "whisper",
    id: "onnx-community/whisper-base_timestamped",
    label: "Whisper Base",
    description: "Faster download and transcription. Good for most clips.",
    size: "~200 MB",
    dtype: WHISPER_DTYPE,
    // Do not set verbatimPrompt: forcing a long <|startofprev|> prompt via
    // decoder_input_ids truncates long-form transcripts (e.g. drops the second
    // speaker on mixed clips). Prefer post-process / filler tools instead.
  },
  small: {
    engine: "whisper",
    id: "onnx-community/whisper-small_timestamped",
    label: "Whisper Small",
    description: "More accurate on longer or noisier audio. Larger download.",
    size: "~600 MB",
    dtype: WHISPER_DTYPE,
  },
};

export const PARAKEET_MODELS: Record<ParakeetModel, ParakeetModelInfo> = {
  "parakeet-v2": {
    engine: "parakeet",
    id: "parakeet-tdt-0.6b-v2",
    label: "Parakeet v2",
    description: "Best English accuracy with fast WebGPU transcription.",
    size: "~1.3 GB",
  },
};

/** Models that can run in the transcription worker. */
export const MODELS = {
  ...PARAKEET_MODELS,
  ...WHISPER_MODELS,
} satisfies Record<TranscriptionModel, ModelInfo>;

export function isWhisperModel(value: unknown): value is WhisperModel {
  return value === "base" || value === "small";
}

export function isParakeetModel(value: unknown): value is ParakeetModel {
  return value === "parakeet-v2";
}

export function isTranscriptionModel(value: unknown): value is TranscriptionModel {
  return isWhisperModel(value) || isParakeetModel(value);
}

export function isModelChoice(value: unknown): value is ModelChoice {
  return isTranscriptionModel(value) || value === "import";
}

const MODEL_STORAGE_KEY = "rescript.model";

/** Read the last-selected local speech model from localStorage. */
export function loadModelPreference(): TranscriptionModel {
  if (typeof window === "undefined") return DEFAULT_TRANSCRIPTION_MODEL;
  try {
    const raw = window.localStorage.getItem(MODEL_STORAGE_KEY);
    // Ignore a stale "import" preference — that choice is session-only until a
    // transcript file is picked again.
    if (isTranscriptionModel(raw)) return raw;
  } catch {
    // private mode / disabled storage
  }
  return DEFAULT_TRANSCRIPTION_MODEL;
}

/** Persist the selected speech model for the next visit. */
export function saveModelPreference(model: TranscriptionModel) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MODEL_STORAGE_KEY, model);
  } catch {
    // private mode / disabled storage
  }
}
