import {
  DEFAULT_TRANSCRIPTION_MODEL,
  MODELS,
  isModelChoice,
  isParakeetModel,
  isTranscriptionModel,
  loadModelPreference,
} from "../lib/models";
import { wordsFromParakeet } from "../lib/parakeet";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

assert(
  DEFAULT_TRANSCRIPTION_MODEL === "parakeet-v2",
  "Parakeet v2 must be the default transcription model"
);
assert(
  loadModelPreference() === "parakeet-v2",
  "server/new-session preference must default to Parakeet v2"
);
assert(isParakeetModel("parakeet-v2"), "Parakeet v2 must be recognized");
assert(
  isTranscriptionModel("parakeet-v2") && isModelChoice("parakeet-v2"),
  "Parakeet v2 must be a runnable and persistable model choice"
);
assert(
  MODELS["parakeet-v2"].id === "parakeet-tdt-0.6b-v2",
  "Parakeet v2 must map to the parakeet.js model key"
);

const words = wordsFromParakeet(
  [
    { text: " Hello ", start_time: 0.1, end_time: 0.4 },
    { text: "", start_time: 0.4, end_time: 0.5 },
    { text: "world.", start_time: 0.4, end_time: 0.9 },
    { text: "outside", start_time: 20, end_time: 21 },
  ],
  12,
  30,
  5
);

assert(words.length === 2, `expected 2 valid timed words, got ${words.length}`);
assert(words[0]?.id === 5 && words[1]?.id === 6, "word ids must stay contiguous");
assert(
  words[0]?.text === "Hello" && words[0]?.start === 12.1 && words[0]?.end === 12.4,
  "slice-local timestamps must map onto the media timeline"
);
assert(
  words[1]?.text === "world." && words[1]?.start === 12.4 && words[1]?.end === 12.9,
  "later words must preserve text and mapped timestamps"
);

console.log("ALL PARAKEET TESTS PASSED");
