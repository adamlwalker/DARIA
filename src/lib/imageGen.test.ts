import { describe, expect, it } from "vitest";
import {
  clampImageGenQuant,
  clampImageGenSize,
  clampImageGenSteps,
  formatImageSeedContent,
  imageGenDiskHintGb,
  parseImageSeed,
  recommendedImageGenQuant,
} from "./imageGen";
import { matchingPersonality, PERSONALITY_PRESETS } from "./personalityPresets";
import en from "../locales/en.json";
import zh from "../locales/zh.json";

describe("image gen helpers", () => {
  it("recommends lower quants on smaller Macs", () => {
    expect(recommendedImageGenQuant(16)).toBe(4);
    expect(recommendedImageGenQuant(18)).toBe(4);
    expect(recommendedImageGenQuant(32)).toBe(8);
    expect(recommendedImageGenQuant(40)).toBe(8);
    expect(recommendedImageGenQuant(64)).toBe(16);
  });

  it("clamps quant / size / steps", () => {
    expect(clampImageGenQuant(4)).toBe(4);
    expect(clampImageGenQuant(8)).toBe(8);
    expect(clampImageGenQuant(16)).toBe(16);
    expect(clampImageGenQuant("nope")).toBe(8);
    expect(clampImageGenSize(512)).toBe(512);
    expect(clampImageGenSize(2048)).toBe(1024);
    expect(clampImageGenSteps(9)).toBe(9);
    expect(clampImageGenSteps(99)).toBe(20);
    expect(clampImageGenSteps(-3)).toBe(1);
  });

  it("gives disk-size hints per quant", () => {
    expect(imageGenDiskHintGb(4)).toContain("7");
    expect(imageGenDiskHintGb(8)).toContain("12");
    expect(imageGenDiskHintGb(16)).toContain("21");
  });

  it("round-trips a seed in message content", () => {
    expect(formatImageSeedContent(42)).toBe("seed:42");
    expect(parseImageSeed("seed:42")).toBe(42);
    expect(parseImageSeed("  seed:184928301  ")).toBe(184928301);
    expect(parseImageSeed("")).toBeNull();
    expect(parseImageSeed("nice picture")).toBeNull();
  });
});

describe("personality presets", () => {
  it("ships the seven built-in personalities", () => {
    expect(PERSONALITY_PRESETS.map((p) => p.id)).toEqual([
      "concise",
      "formal",
      "tutor",
      "comprehensive",
      "unhinged",
      "storyteller",
      "sexy",
    ]);
  });

  it("keeps the storyteller brief as specified", () => {
    const p = PERSONALITY_PRESETS.find((x) => x.id === "storyteller")!;
    expect(p.prompt).toContain("master storyteller");
    expect(p.prompt).toContain("Never stop telling the story");
    expect(p.prompt.toLowerCase()).not.toContain("grok");
  });

  it("matches an applied prompt", () => {
    expect(matchingPersonality(PERSONALITY_PRESETS[0].prompt)).toBe("concise");
    expect(matchingPersonality("custom stuff")).toBeNull();
  });
});

describe("image gen locales", () => {
  it("has matching English and Chinese keys", () => {
    const extraZh = Object.keys(zh).filter((k) => !(k in en));
    const extraEn = Object.keys(en).filter((k) => !(k in zh));
    expect(extraZh).toEqual([]);
    expect(extraEn).toEqual([]);
  });

  it("covers the image-gen strings", () => {
    for (const key of [
      "setCatImage",
      "toolImage",
      "imageGenConfirm",
      "openImagesDir",
      "imageGenQuant4",
    ]) {
      expect(en[key as keyof typeof en]).toBeTruthy();
      expect(zh[key as keyof typeof zh]).toBeTruthy();
    }
  });
});
