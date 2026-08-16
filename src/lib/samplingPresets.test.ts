import { describe, expect, it } from "vitest";
import { applySamplingPresetValues, matchingSamplingPreset, SAMPLING_PRESETS } from "./samplingPresets";

const base = {
  temperature: 0.7,
  topP: 0.95,
  topK: 40,
  limitTokens: false,
  maxTokens: 1024,
  minP: 0.05,
  repeatPenalty: 1.1,
};

describe("sampling presets", () => {
  it("lists the CSV intent presets first", () => {
    expect(SAMPLING_PRESETS.slice(0, 4).map((p) => p.id)).toEqual([
      "intent-thinking",
      "intent-chat",
      "intent-default",
      "intent-fast",
    ]);
  });

  it("does not lock default sliders to a vendor preset", () => {
    expect(matchingSamplingPreset(base)).toBe("");
  });

  it("applies temp / top-p / top-k / repeat penalty and leaves length alone for -1", () => {
    const p = SAMPLING_PRESETS.find((x) => x.id === "intent-thinking")!;
    const next = applySamplingPresetValues({ ...base, limitTokens: false, maxTokens: 2048 }, p);
    expect(next.temperature).toBe(0.4);
    expect(next.topP).toBe(0.95);
    expect(next.topK).toBe(80);
    expect(next.repeatPenalty).toBe(1.2);
    expect(next.limitTokens).toBe(false);
    expect(next.maxTokens).toBe(2048);
  });

  it("caps length only for Fast Mode (numPredict 64)", () => {
    const p = SAMPLING_PRESETS.find((x) => x.id === "intent-fast")!;
    const next = applySamplingPresetValues({ ...base, limitTokens: false, maxTokens: 2048 }, p);
    expect(next.limitTokens).toBe(true);
    expect(next.maxTokens).toBe(64);
    expect(next.temperature).toBe(0);
    expect(next.topK).toBe(1);
  });

  it("recognizes every shipped preset after apply", () => {
    for (const p of SAMPLING_PRESETS) {
      const s = applySamplingPresetValues(base, p);
      expect(matchingSamplingPreset(s)).toBe(p.id);
    }
  });
});
