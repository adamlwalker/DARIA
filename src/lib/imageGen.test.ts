import { describe, expect, it } from "vitest";
import {
  clampImageGenQuant,
  clampImageGenSize,
  clampImageGenSteps,
  formatImageSeedContent,
  imageGenDiskHintGb,
  IMAGE_GEN_CHAT_TOOL_DOC,
  parseGenerateImageCall,
  parseImageSeed,
  recommendedImageGenQuant,
  stripGenerateImageMarkup,
  stripImageSeedLine,
  withImageSeed,
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

  it("reads a seed under a caption and can strip it for display", () => {
    const stored = withImageSeed("Here you go.", 9);
    expect(stored).toBe("Here you go.\n\nseed:9");
    expect(parseImageSeed(stored)).toBe(9);
    expect(stripImageSeedLine(stored)).toBe("Here you go.");
  });
});

describe("chat generate_image tool", () => {
  it("documents the XML tool protocol", () => {
    expect(IMAGE_GEN_CHAT_TOOL_DOC).toContain("<tool_call>");
    expect(IMAGE_GEN_CHAT_TOOL_DOC).toContain("generate_image");
    expect(IMAGE_GEN_CHAT_TOOL_DOC).toContain("prompt");
  });

  it("parses a closed tool_call JSON block", () => {
    const text =
      'Sure.\n<tool_call>{"name":"generate_image","arguments":{"prompt":"a red cube on marble"}}</tool_call>';
    expect(parseGenerateImageCall(text)).toEqual({ prompt: "a red cube on marble" });
    expect(stripGenerateImageMarkup(text)).toBe("Sure.");
  });

  it("parses when the closer was trimmed by the stop sequence", () => {
    const text =
      '<tool_call>{"name":"generate_image","arguments":{"prompt":"neon diner at night, sign reads OPEN"}}';
    expect(parseGenerateImageCall(text)?.prompt).toContain("neon diner");
  });

  it("accepts a flat prompt field and name aliases", () => {
    expect(
      parseGenerateImageCall('<tool_call>{"name":"image_gen","prompt":"oil painting of a fox"}'),
    ).toEqual({ prompt: "oil painting of a fox" });
  });

  it("parses the LFM native call shape", () => {
    const text =
      "<|tool_call_start|>[generate_image(prompt='a watercolor lighthouse')]<|tool_call_end|>";
    expect(parseGenerateImageCall(text)).toEqual({ prompt: "a watercolor lighthouse" });
    expect(stripGenerateImageMarkup(text)).toBe("");
  });

  it("ignores other tools and empty prompts", () => {
    expect(
      parseGenerateImageCall('<tool_call>{"name":"web_search","arguments":{"query":"cats"}}</tool_call>'),
    ).toBeNull();
    expect(
      parseGenerateImageCall('<tool_call>{"name":"generate_image","arguments":{"prompt":"  "}}</tool_call>'),
    ).toBeNull();
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
      "inputPhImageTool",
      "toolImageAsk",
      "toolImageDirect",
      "imageGenChipDirect",
    ]) {
      expect(en[key as keyof typeof en]).toBeTruthy();
      expect(zh[key as keyof typeof zh]).toBeTruthy();
    }
  });
});
