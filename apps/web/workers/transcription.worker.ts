/**
 * Transcription worker: runs entirely in the browser.
 *
 * 1. Silero VAD (energy fallback) finds speech segments; silence is skipped.
 * 2. A Whisper-family model (see lib/models.ts) transcribes each segment with
 *    per-word timestamps, remapped onto the original timeline.
 * 3. Pyannote segmentation 3.0 assigns a speaker to each word.
 *
 * Models are fetched from the Hugging Face Hub on first use and cached in the
 * browser Cache Storage; every run after that is fully offline. The ONNX
 * runtime WASM binaries are served from /vendor/ort (same origin).
 */
import {
  pipeline,
  AutoProcessor,
  AutoModel,
  AutoModelForAudioFrameClassification,
  WhisperTextStreamer,
  Tensor,
  env,
  type AutomaticSpeechRecognitionPipeline,
} from "@huggingface/transformers";
import type { ParakeetModel as ParakeetRuntime } from "parakeet.js";
import type { Word, WorkerRequest, WorkerResponse } from "@/lib/types";
import {
  PARAKEET_MODELS,
  WHISPER_MODELS,
  isParakeetModel,
  type ParakeetModel,
  type TranscriptionModel,
  type WhisperModel,
} from "@/lib/models";
import { cleanTranscript } from "@/lib/hallucinations";
import {
  wordsFromParakeet,
  type ParakeetTimedWord,
} from "@/lib/parakeet";
import {
  VAD_FRAME_SIZE,
  VAD_SAMPLE_RATE,
  energySpeechFrames,
  speechSegmentsFromFrames,
  type SpeechSegment,
} from "@/lib/vad";

env.allowLocalModels = false;
// Serve onnxruntime-web WASM from our own origin (offline friendly).
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.wasmPaths = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/vendor/ort/`;
}

const DIARIZATION_MODEL = "onnx-community/pyannote-segmentation-3.0";
const VAD_MODEL = "onnx-community/silero-vad";
/** Gaps longer than this split speech into separate Whisper jobs. */
const SPEECH_MAX_GAP_S = 1.5;
/** Pad each speech region so phoneme edges are not clipped. */
const SPEECH_PAD_S = 0.4;
/**
 * Whisper often emits EOS after the first speaker when a VAD slice starts on
 * speech with no leading silence. Prepend this much zero-pad before decode
 * (timestamps are remapped so the pad does not shift the timeline).
 */
const WHISPER_LEAD_PAD_S = 0.5;

const post = (msg: WorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

/**
 * Aggregate model download progress into a single 0..1 value.
 *
 * Prefer transformers.js `progress_total` events: those are pre-seeded with
 * every expected file's size, so the bar does not jump to 100% after the first
 * ONNX file finishes while larger siblings are still downloading. Fall back to
 * per-file `progress` only when totals are unavailable, and rescale `best`
 * whenever the known byte total grows so the bar can move backwards honestly.
 */
function makeDownloadTracker(label: string) {
  const files = new Map<string, { loaded: number; total: number }>();
  let best = 0;
  let lastTotal = 0;
  let useTotalEvents = false;

  const report = (loaded: number, total: number) => {
    if (total <= 0) return;
    if (total > lastTotal && lastTotal > 0 && best > 0) {
      best *= lastTotal / total;
    }
    lastTotal = total;
    best = Math.max(best, Math.min(1, loaded / total));
    post({ type: "progress", message: label, value: best });
  };

  return (p: {
    status?: string;
    file?: string;
    loaded?: number;
    total?: number;
    progress?: number;
  }) => {
    if (p.status === "progress_total") {
      useTotalEvents = true;
      const total = p.total ?? 0;
      const loaded =
        total > 0 && typeof p.progress === "number"
          ? (p.progress / 100) * total
          : (p.loaded ?? 0);
      report(loaded, total);
      return;
    }

    // Per-file fallback when the library could not pre-seed expected files.
    if (useTotalEvents) return;
    if (p.status !== "progress" || !p.file || !p.total) return;
    files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    report(loaded, total);
  };
}

/**
 * Whether a model's weights are already in the transformers.js browser cache.
 * Used purely to label the progress UI accurately ("Loading … from cache"
 * instead of "Downloading …"): transformers.js emits identical progress
 * events when reading a cached model from disk as when downloading it.
 */
async function isModelCached(modelId: string): Promise<boolean> {
  try {
    const cache = await caches.open(env.cacheKey ?? "transformers-cache");
    const keys = await cache.keys();
    return keys.some((req) => req.url.includes(modelId) && req.url.includes(".onnx"));
  } catch {
    return false;
  }
}

async function pickDevice(): Promise<"webgpu" | "wasm"> {
  try {
    const gpu = (globalThis.navigator as Navigator & {
      gpu?: { requestAdapter: () => Promise<unknown | null> };
    })?.gpu;
    if (gpu && (await gpu.requestAdapter())) return "webgpu";
  } catch {
    // fall through to wasm
  }
  return "wasm";
}

// Keyed by model id so choices that share weights reuse one pipeline.
const asrPromises = new Map<string, Promise<AutomaticSpeechRecognitionPipeline>>();
async function getAsr(choice: WhisperModel) {
  const { id, dtype } = WHISPER_MODELS[choice];
  let promise = asrPromises.get(id);
  if (!promise) {
    const device = await pickDevice();
    const label = (await isModelCached(id))
      ? "Loading speech model from cache…"
      : "Downloading speech model…";
    promise = pipeline("automatic-speech-recognition", id, {
      dtype: dtype[device],
      device,
      progress_callback: makeDownloadTracker(label),
    }).catch((err) => {
      // WebGPU can fail on some drivers; retry once on plain WASM.
      if (device === "webgpu") {
        return pipeline("automatic-speech-recognition", id, {
          dtype: dtype.wasm,
          device: "wasm",
          progress_callback: makeDownloadTracker(label),
        });
      }
      throw err;
    }) as Promise<AutomaticSpeechRecognitionPipeline>;
    asrPromises.set(id, promise);
    promise.catch(() => asrPromises.delete(id));
  }
  return promise;
}

const parakeetPromises = new Map<string, Promise<ParakeetRuntime>>();

function makeParakeetDownloadTracker(label: string) {
  const files = new Map<string, { loaded: number; total: number }>();
  return (progress: { loaded: number; total: number; file: string }) => {
    files.set(progress.file, {
      loaded: progress.loaded,
      total: progress.total,
    });
    let loaded = 0;
    let total = 0;
    for (const file of files.values()) {
      loaded += file.loaded;
      total += file.total;
    }
    post({
      type: "progress",
      message: label,
      value: total > 0 ? Math.min(1, loaded / total) : null,
    });
  };
}

async function getParakeetAsr(choice: ParakeetModel): Promise<ParakeetRuntime> {
  const { id, label } = PARAKEET_MODELS[choice];
  let promise = parakeetPromises.get(id);
  if (!promise) {
    promise = (async () => {
      const { fromHub } = await import("parakeet.js");
      const device = await pickDevice();
      const wasmPaths = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/vendor/parakeet-ort/`;
      const progress = makeParakeetDownloadTracker(`Loading ${label}…`);
      if (device === "webgpu") {
        try {
          return await fromHub(id, {
            backend: "webgpu",
            encoderQuant: "fp16",
            decoderQuant: "int8",
            preprocessorBackend: "js",
            wasmPaths,
            progress,
          });
        } catch (error) {
          console.warn("Parakeet WebGPU initialization failed; retrying with WASM.", error);
        }
      }
      return fromHub(id, {
        backend: "wasm",
        encoderQuant: "int8",
        decoderQuant: "int8",
        preprocessorBackend: "js",
        wasmPaths,
        progress,
      });
    })();
    parakeetPromises.set(id, promise);
    promise.catch(() => parakeetPromises.delete(id));
  }
  return promise;
}

/**
 * Build decoder input tokens implementing Whisper's "initial prompt"
 * conditioning: `<|startofprev|> …prompt… <|startoftranscript|> <|lang|>
 * <|transcribe|>`. transformers.js documents `prompt_ids` but does not
 * implement it, so the tokens are constructed manually and passed as
 * `decoder_input_ids` (which `generate` honors for every chunk). Returns
 * null if any required token cannot be resolved.
 */
function buildPromptedDecoderIds(
  transcriber: AutomaticSpeechRecognitionPipeline,
  prompt: string,
  language: string
): number[] | null {
  try {
    // Tokenizer/config internals are untyped in transformers.js.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const tokenizer = transcriber.tokenizer as any;
    const genCfg = (transcriber.model as any).generation_config;
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const startOfPrev = tokenizer.encode("<|startofprev|>", { add_special_tokens: false });
    const promptIds = tokenizer.encode(" " + prompt.trim(), { add_special_tokens: false });
    const startId = genCfg?.decoder_start_token_id;
    const langId = genCfg?.lang_to_id?.[`<|${language}|>`];
    const taskId = genCfg?.task_to_id?.["transcribe"];
    if (
      startOfPrev?.length !== 1 ||
      !promptIds?.length ||
      startId == null ||
      langId == null ||
      taskId == null
    ) {
      return null;
    }
    return [startOfPrev[0], ...promptIds, startId, langId, taskId];
  } catch {
    return null;
  }
}

interface DiarizationSegment {
  id: number;
  start: number;
  end: number;
  confidence: number;
}

type Diarizer = {
  processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>;
  model: Awaited<ReturnType<typeof AutoModelForAudioFrameClassification.from_pretrained>>;
};

/**
 * Silero VAD: ~2 MB ONNX model that scores speech probability per 32 ms frame.
 * Used to find speech segments so Whisper never decodes long silence.
 * Falls back to energy VAD on failure.
 */
type VadModel = {
  (inputs: {
    input: InstanceType<typeof Tensor>;
    sr: InstanceType<typeof Tensor>;
    state: InstanceType<typeof Tensor>;
  }): Promise<{
    output: { data: ArrayLike<number> };
    stateN: InstanceType<typeof Tensor>;
  }>;
};

let vadPromise: Promise<VadModel | null> | null = null;
function getVad(): Promise<VadModel | null> {
  if (!vadPromise) {
    vadPromise = AutoModel.from_pretrained(VAD_MODEL, {
      // Silero ships as a custom ONNX graph without a transformers config.
      // @ts-expect-error transformers.js accepts model_type via config override
      config: { model_type: "custom" },
      dtype: "fp32",
    })
      .then((model) => model as unknown as VadModel)
      .catch((err) => {
        console.warn("Silero VAD failed to load; using energy-based silence detection.", err);
        return null;
      });
  }
  return vadPromise;
}

async function speechFramesWithSilero(
  model: VadModel,
  audio: Float32Array
): Promise<boolean[]> {
  const frameSize = VAD_FRAME_SIZE;
  const n = Math.ceil(audio.length / frameSize) || 0;
  const out: boolean[] = new Array(n);
  const sr = new Tensor("int64", [BigInt(VAD_SAMPLE_RATE)], []);
  let state = new Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
  // Fresh buffer each frame so ORT never sees a mutated shared view.
  const threshold = 0.35;

  for (let f = 0; f < n; f++) {
    const start = f * frameSize;
    const end = Math.min(audio.length, start + frameSize);
    const frameBuf = new Float32Array(frameSize);
    frameBuf.set(audio.subarray(start, end));
    const input = new Tensor("float32", frameBuf, [1, frameSize]);
    const { output, stateN } = await model({ input, sr, state });
    state = stateN;
    out[f] = Number(output.data[0] ?? 0) >= threshold;

    if (f > 0 && f % 512 === 0) {
      post({ type: "progress", message: "Detecting speech…", value: f / n });
    }
  }
  return out;
}

/** Turn speech-frame flags into segments, with a full-audio fallback. */
function segmentsOrFull(
  frames: boolean[],
  audio: Float32Array
): SpeechSegment[] {
  const segments = speechSegmentsFromFrames(frames, audio.length, {
    maxGapS: SPEECH_MAX_GAP_S,
    padS: SPEECH_PAD_S,
  });
  if (segments.length > 0) return segments;
  console.warn("VAD found no speech; falling back to full audio.");
  return [{ startSample: 0, endSample: audio.length }];
}

async function detectSpeechSegments(
  audio: Float32Array,
  vad: VadModel | null
): Promise<SpeechSegment[]> {
  try {
    const frames = vad
      ? await speechFramesWithSilero(vad, audio)
      : energySpeechFrames(audio);
    return segmentsOrFull(frames, audio);
  } catch (err) {
    console.warn("Speech segmentation failed; falling back to full audio.", err);
    return [{ startSample: 0, endSample: audio.length }];
  }
}

type AsrChunk = { text: string; timestamp: [number, number | null] };

/** Map Whisper word chunks from a segment onto the original media timeline. */
function wordsFromChunks(
  chunks: AsrChunk[],
  offsetS: number,
  segmentDuration: number,
  mediaDuration: number
): Word[] {
  const words: Word[] = [];
  for (const c of chunks) {
    const text = c.text.trim();
    if (!text) continue;
    const localStart = c.timestamp[0] ?? 0;
    const localEnd = c.timestamp[1] ?? Math.min(localStart + 0.5, segmentDuration);
    let start = offsetS + localStart;
    let end = offsetS + localEnd;
    if (mediaDuration > 0) {
      start = Math.min(start, mediaDuration);
      end = Math.min(end, mediaDuration);
    }
    words.push({
      id: words.length,
      text,
      start,
      end: Math.max(end, start + 0.02),
      speaker: 0,
      deleted: false,
    });
  }
  return words;
}

async function transcribeWithParakeet(
  transcriber: ParakeetRuntime,
  audio: Float32Array,
  duration: number,
  speechSegments: SpeechSegment[]
): Promise<Word[]> {
  const speechSamples = speechSegments.reduce(
    (total, segment) => total + segment.endSample - segment.startSample,
    0
  );
  let speechDone = 0;
  let partial = "";
  const words: Word[] = [];
  post({ type: "progress", message: "Transcribing with Parakeet…", value: 0 });

  for (const segment of speechSegments) {
    const slice = audio.slice(segment.startSample, segment.endSample);
    const result = await transcriber.transcribeLongAudio(slice, VAD_SAMPLE_RATE, {
      returnTimestamps: "word",
      enableProfiling: false,
    });
    const segmentWords = wordsFromParakeet(
      (result.words ?? []) as ParakeetTimedWord[],
      segment.startSample / VAD_SAMPLE_RATE,
      duration,
      words.length
    );
    words.push(...segmentWords);
    partial = [partial, result.text.trim()].filter(Boolean).join(" ");
    post({ type: "partial", text: partial });
    speechDone += segment.endSample - segment.startSample;
    post({
      type: "progress",
      message: "Transcribing with Parakeet…",
      value: speechSamples > 0 ? Math.min(1, speechDone / speechSamples) : 1,
    });
  }

  return words.map((word, id) => ({ ...word, id }));
}

/**
 * Load the diarization model. Started in the background while Whisper is
 * still transcribing, so the (small) speaker model is downloaded, cached,
 * and ready by the time the transcript lands — closing the tab right after
 * transcription no longer leaves it uncached for the next session. No
 * progress is posted here to avoid interleaving with transcription progress.
 */
let diarizerPromise: Promise<Diarizer> | null = null;
function getDiarizer(): Promise<Diarizer> {
  if (!diarizerPromise) {
    diarizerPromise = (async () => {
      const processor = await AutoProcessor.from_pretrained(DIARIZATION_MODEL, {});
      const model = await AutoModelForAudioFrameClassification.from_pretrained(
        DIARIZATION_MODEL,
        { dtype: "fp32" }
      );
      return { processor, model };
    })();
    diarizerPromise.catch(() => {
      diarizerPromise = null;
    });
  }
  return diarizerPromise;
}

async function diarize(audio: Float32Array): Promise<DiarizationSegment[]> {
  const { processor, model } = await getDiarizer();
  const inputs = await processor(audio);
  const { logits } = await model(inputs);
  // post_process_speaker_diarization is specific to the PyAnnote processor
  // and is not part of the generic Processor typings.
  const pyannote = processor as unknown as {
    post_process_speaker_diarization: (
      logits: unknown,
      numSamples: number
    ) => DiarizationSegment[][];
  };
  const result = pyannote.post_process_speaker_diarization(logits, audio.length);
  return result[0] ?? [];
}

/** Assign a speaker to each word from the diarization segments. */
function assignSpeakers(words: Word[], segments: DiarizationSegment[]) {
  // Segment id 0 is "no speaker" (silence/noise); ignore it.
  const speech = segments.filter((s) => s.id !== 0);
  if (speech.length === 0) {
    for (const w of words) w.speaker = 0;
    return;
  }
  const idMap = new Map<number, number>(); // pyannote id -> sequential index
  for (const w of words) {
    const mid = (w.start + w.end) / 2;
    let seg = speech.find((s) => mid >= s.start && mid < s.end);
    if (!seg) {
      // Fall back to the nearest speech segment.
      let best = Infinity;
      for (const s of speech) {
        const d = mid < s.start ? s.start - mid : mid - s.end;
        if (d < best) {
          best = d;
          seg = s;
        }
      }
    }
    const raw = seg ? seg.id : -1;
    if (raw >= 0 && !idMap.has(raw)) idMap.set(raw, idMap.size);
    w.speaker = raw >= 0 ? (idMap.get(raw) as number) : 0;
  }
}

async function completeTranscript(rawWords: Word[], audio: Float32Array) {
  // Post-process: collapse leftover n-gram loops and drop known hallucination
  // phrases ("I'm sorry", "thanks for watching", …) that slip past decoding.
  const words = cleanTranscript(rawWords);

  // Best-effort speaker diarization; a failure should not lose the transcript.
  try {
    post({ type: "progress", message: "Identifying speakers…", value: null });
    const segments = await diarize(audio);
    assignSpeakers(words, segments);
  } catch (err) {
    console.warn("Speaker diarization failed; using a single speaker.", err);
  }

  post({ type: "complete", words });
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { audio, duration, model, language } = event.data;
  try {
    const choice: TranscriptionModel = model ?? "base";

    // Overlap ASR + Silero downloads; diarizer warms in the background.
    getDiarizer().catch(() => {});

    if (isParakeetModel(choice)) {
      const [transcriber, vad] = await Promise.all([
        getParakeetAsr(choice),
        getVad(),
      ]);
      post({ type: "progress", message: "Detecting speech…", value: 0 });
      const speechSegments = await detectSpeechSegments(audio, vad);
      const rawWords = await transcribeWithParakeet(
        transcriber,
        audio,
        duration,
        speechSegments
      );
      await completeTranscript(rawWords, audio);
      return;
    }

    const whisperChoice: WhisperModel = choice;
    const [transcriber, vad] = await Promise.all([
      getAsr(whisperChoice),
      getVad(),
    ]);

    post({ type: "progress", message: "Detecting speech…", value: 0 });
    const speechSegments = await detectSpeechSegments(audio, vad);

    const { verbatimPrompt } = WHISPER_MODELS[whisperChoice];
    const promptedIds = verbatimPrompt
      ? buildPromptedDecoderIds(transcriber, verbatimPrompt, language ?? "en")
      : null;
    if (verbatimPrompt && !promptedIds) {
      console.warn("Could not build verbatim prompt tokens; using default decoding.");
    }

    const speechSamples = speechSegments.reduce(
      (n, s) => n + (s.endSample - s.startSample),
      0
    );

    post({ type: "progress", message: "Transcribing…", value: 0 });

    let partial = "";
    // Use 29s instead of 30: transformers.js has a known word-timestamp bug
    // at exactly chunk_length_s=30 (#1357 / #1358); 29 is the common workaround.
    const chunkLength = 29;
    const stride = 5;
    const timePrecision =
      // @ts-expect-error feature_extractor config is untyped
      (transcriber.processor.feature_extractor.config.chunk_length ?? 30) /
      // @ts-expect-error model config is untyped
      (transcriber.model.config.max_source_positions ?? 1500);

    const tokenizer = transcriber.tokenizer as ConstructorParameters<
      typeof WhisperTextStreamer
    >[0];

    let speechDone = 0;
    let transcribed = 0;
    let chunkFloor = 0;
    let chunkTokens = 0;
    let avgChunkDelta =
      speechSamples > 0
        ? Math.min(0.15, ((chunkLength - stride) * VAD_SAMPLE_RATE) / speechSamples)
        : 0.05;

    const reportProgress = (segmentLocalT: number, segmentSamples: number) => {
      const local = Math.min(
        segmentSamples,
        Math.max(0, segmentLocalT * VAD_SAMPLE_RATE)
      );
      const next = Math.max(
        transcribed,
        Math.min(1, speechSamples > 0 ? (speechDone + local) / speechSamples : 1)
      );
      const realDelta = next - chunkFloor;
      if (realDelta > 0) avgChunkDelta = avgChunkDelta * 0.5 + realDelta * 0.5;
      chunkFloor = next;
      chunkTokens = 0;
      transcribed = next;
      post({ type: "progress", message: "Transcribing…", value: transcribed });
    };

    /** Nudge the bar forward between chunk boundaries as tokens stream in. */
    const interpolateProgress = () => {
      chunkTokens++;
      // n/(n+8): 0.11 at token 1, 0.5 at token 8, 0.9 at token 72 — strictly
      // increasing, so it can never get stuck as long as tokens keep coming.
      const frac = chunkTokens / (chunkTokens + 8);
      const interpolated = Math.min(0.999, chunkFloor + frac * avgChunkDelta);
      if (interpolated > transcribed) {
        transcribed = interpolated;
        post({ type: "progress", message: "Transcribing…", value: transcribed });
      }
    };

    const asrOptions = {
      chunk_length_s: chunkLength,
      stride_length_s: stride,
      return_timestamps: "word" as const,
      // Anti-repetition: Whisper-base on multi-minute audio often falls into
      // loops like "little bit of a little bit of a…" near chunk boundaries
      // or silence. Keep penalty mild — 1.15 truncates multi-speaker clips
      // mid-utterance (second speaker dropped on continuous speech).
      no_repeat_ngram_size: 4,
      repetition_penalty: 1.05,
      ...(promptedIds ? { decoder_input_ids: promptedIds } : { language }),
    };

    const rawWords: Word[] = [];
    const leadPadSamples = Math.floor(WHISPER_LEAD_PAD_S * VAD_SAMPLE_RATE);
    for (const seg of speechSegments) {
      const segmentSamples = seg.endSample - seg.startSample;
      // Copy into a fresh buffer with leading silence. Views with a non-zero
      // byteOffset have caused incomplete ASR with onnxruntime-web; starting
      // mid-speech with no lead-in also drops later speakers on mixed clips.
      const slice = new Float32Array(leadPadSamples + segmentSamples);
      slice.set(audio.subarray(seg.startSample, seg.endSample), leadPadSamples);
      const sliceDuration = slice.length / VAD_SAMPLE_RATE;
      const offsetS = seg.startSample / VAD_SAMPLE_RATE - WHISPER_LEAD_PAD_S;

      // Each generate() window consumes `chunkLength - 2 * stride` seconds of
      // new audio, and the streamer's timestamps rewind to ~0 when the next
      // window starts. A timestamp lower than the last one seen marks that
      // boundary; accumulate the offset to recover segment-local time.
      const windowJumpS = chunkLength - 2 * stride;
      let windowOffsetS = 0;
      let lastChunkStartT = 0;

      const streamer = new WhisperTextStreamer(tokenizer, {
        skip_prompt: true,
        time_precision: timePrecision,
        on_chunk_start: (t: number) => {
          if (t < lastChunkStartT) windowOffsetS += windowJumpS;
          lastChunkStartT = t;
          reportProgress(
            Math.max(0, windowOffsetS + t - WHISPER_LEAD_PAD_S),
            segmentSamples
          );
        },
        callback_function: (text: string) => {
          partial += text;
          post({ type: "partial", text: partial });
          interpolateProgress();
        },
      });

      const output = await transcriber(slice, { ...asrOptions, streamer });
      const result = Array.isArray(output) ? output[0] : output;
      const chunks = (result.chunks ?? []) as AsrChunk[];
      rawWords.push(...wordsFromChunks(chunks, offsetS, sliceDuration, duration));

      speechDone += segmentSamples;
      reportProgress(0, 0);
    }

    await completeTranscript(rawWords, audio);
  } catch (err) {
    console.error(err);
    post({
      type: "error",
      message: err instanceof Error ? err.message : "Transcription failed.",
    });
  }
};
