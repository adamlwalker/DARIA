/** Sampling starting points. CSV intent presets sit first; vendor
 *  recommendations from temps.txt follow. Selecting one fills temp / top-p /
 *  top-k / repeat penalty. Max-length is left alone unless a preset sets a
 *  positive numPredict (Fast Mode). */

export interface SamplingPreset {
  id: string;
  family: string;
  /** Locale key for the dropdown label. */
  labelKey: string;
  temperature: number;
  topP: number;
  topK: number;
  repeatPenalty: number;
  /** Positive = cap the reply at this many tokens. -1 / omitted = leave the
   *  current no-limit / custom length untouched. */
  numPredict?: number;
  minP?: number;
}

export const SAMPLING_PRESETS: SamplingPreset[] = [
  {
    id: "intent-thinking",
    family: "Intent",
    labelKey: "samplingIntentThinking",
    temperature: 0.4,
    topP: 0.95,
    topK: 80,
    repeatPenalty: 1.2,
    numPredict: -1,
  },
  {
    id: "intent-chat",
    family: "Intent",
    labelKey: "samplingIntentChat",
    temperature: 1.4,
    topP: 0.9,
    topK: 40,
    repeatPenalty: 1.0,
    numPredict: -1,
  },
  {
    id: "intent-default",
    family: "Intent",
    labelKey: "samplingIntentDefault",
    temperature: 0.8,
    topP: 0.9,
    topK: 40,
    repeatPenalty: 1.1,
    numPredict: -1,
  },
  {
    id: "intent-fast",
    family: "Intent",
    labelKey: "samplingIntentFast",
    temperature: 0.0,
    topP: 1.0,
    topK: 1,
    repeatPenalty: 1.0,
    numPredict: 64,
  },
  { id: "gemma-creative", family: "Gemma", labelKey: "samplingGemmaCreative", temperature: 0.9, topP: 0.9, topK: 50, repeatPenalty: 1.1 },
  { id: "gemma-factual", family: "Gemma", labelKey: "samplingGemmaFactual", temperature: 0.35, topP: 0.8, topK: 40, repeatPenalty: 1.1 },
  { id: "gemma-balanced", family: "Gemma", labelKey: "samplingGemmaBalanced", temperature: 0.7, topP: 0.9, topK: 50, repeatPenalty: 1.1 },
  { id: "qwen3-thinking", family: "Qwen3", labelKey: "samplingQwen3Thinking", temperature: 0.6, topP: 0.95, topK: 20, repeatPenalty: 1.1 },
  { id: "qwen3-chat", family: "Qwen3", labelKey: "samplingQwen3Chat", temperature: 0.7, topP: 0.8, topK: 20, repeatPenalty: 1.1 },
  { id: "qwq-32b", family: "Qwen", labelKey: "samplingQwq", temperature: 0.6, topP: 0.95, topK: 30, repeatPenalty: 1.1 },
  { id: "qwen3-instruct", family: "Qwen3", labelKey: "samplingQwen3Instruct", temperature: 0.7, topP: 0.8, topK: 20, repeatPenalty: 1.1, minP: 0 },
  { id: "llama-code", family: "LLaMA 3", labelKey: "samplingLlamaCode", temperature: 0.25, topP: 0.7, topK: 0, repeatPenalty: 1.0 },
  { id: "llama-balanced", family: "LLaMA 3", labelKey: "samplingLlamaBalanced", temperature: 0.6, topP: 0.8, topK: 0, repeatPenalty: 1.0 },
  { id: "llama-creative", family: "LLaMA 3", labelKey: "samplingLlamaCreative", temperature: 0.8, topP: 0.9, topK: 0, repeatPenalty: 1.0 },
];

const near = (a: number, b: number, eps = 0.021) => Math.abs(a - b) < eps;

/** Values to write when the user picks a preset. Length sliders stay as they
 *  are unless `numPredict` is a positive cap (Fast Mode). */
export function applySamplingPresetValues<T extends {
  temperature: number;
  topP: number;
  topK: number;
  repeatPenalty: number;
  limitTokens: boolean;
  maxTokens: number;
  minP: number;
}>(current: T, p: SamplingPreset): T {
  const next = {
    ...current,
    temperature: p.temperature,
    topP: p.topP,
    topK: p.topK,
    repeatPenalty: p.repeatPenalty,
  };
  if (p.minP != null) next.minP = p.minP;
  if (p.numPredict != null && p.numPredict > 0) {
    next.limitTokens = true;
    next.maxTokens = p.numPredict;
  }
  return next;
}

/** Return the preset whose knobs match `s`, or "" if the sliders are custom. */
export function matchingSamplingPreset(s: {
  temperature: number;
  topP: number;
  topK: number;
  limitTokens: boolean;
  maxTokens: number;
  minP: number;
  repeatPenalty: number;
}): string {
  let best = "";
  let bestScore = -1;
  for (const p of SAMPLING_PRESETS) {
    if (!near(s.temperature, p.temperature)) continue;
    if (!near(s.topP, p.topP)) continue;
    if (s.topK !== p.topK) continue;
    if (!near(s.repeatPenalty, p.repeatPenalty)) continue;
    if (p.minP != null && !near(s.minP, p.minP)) continue;
    if (p.numPredict != null && p.numPredict > 0) {
      if (!s.limitTokens || s.maxTokens !== p.numPredict) continue;
    }
    let score = 0;
    if (p.numPredict != null && p.numPredict > 0) score += 2;
    if (p.minP != null) score++;
    if (score > bestScore) {
      bestScore = score;
      best = p.id;
    }
  }
  return best;
}
