/** Z-Image-Turbo settings helpers (quant / size / steps). */

export type ImageGenQuant = 4 | 8 | 16;
export type ImageGenSize = 512 | 768 | 1024;

export const IMAGE_GEN_QUANTS: ImageGenQuant[] = [4, 8, 16];
export const IMAGE_GEN_SIZES: ImageGenSize[] = [512, 768, 1024];

export const DEFAULT_IMAGE_GEN_QUANT: ImageGenQuant = 8;
export const DEFAULT_IMAGE_GEN_SIZE: ImageGenSize = 1024;
export const DEFAULT_IMAGE_GEN_STEPS = 9;

/** Pick a quant that fits unified memory: 4-bit on small Macs, 8-bit mid, fp16 on 40 GB+. */
export function recommendedImageGenQuant(ramGb: number): ImageGenQuant {
  if (ramGb <= 18) return 4;
  if (ramGb <= 40) return 8;
  return 16;
}

export function clampImageGenQuant(raw: unknown): ImageGenQuant {
  const n = Number(raw);
  if (n === 4 || n === 8 || n === 16) return n;
  return DEFAULT_IMAGE_GEN_QUANT;
}

export function clampImageGenSize(raw: unknown): ImageGenSize {
  const n = Number(raw);
  if (n === 512 || n === 768 || n === 1024) return n;
  return DEFAULT_IMAGE_GEN_SIZE;
}

export function clampImageGenSteps(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_IMAGE_GEN_STEPS;
  return Math.max(1, Math.min(20, Math.round(n)));
}

export function imageGenDiskHintGb(quant: ImageGenQuant): string {
  if (quant === 4) return "~7";
  if (quant === 8) return "~12";
  return "~21";
}

/** Persist the seed in message content so it survives reload without a schema change. */
export const IMAGE_SEED_PREFIX = "seed:";

export function formatImageSeedContent(seed: number): string {
  return `${IMAGE_SEED_PREFIX}${Math.trunc(seed)}`;
}

/** Seed as its own message, or as the last line under a caption. */
export function parseImageSeed(content: string | undefined | null): number | null {
  const s = (content ?? "").trim();
  const m = s.match(/(?:^|\n)seed:(\d+)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function stripImageSeedLine(content: string): string {
  return content.replace(/(?:\n+)?seed:\d+\s*$/i, "").trimEnd();
}

export function withImageSeed(caption: string, seed: number): string {
  const body = caption.trim();
  const line = formatImageSeedContent(seed);
  return body ? `${body}\n\n${line}` : line;
}

const IMAGE_TOOL_NAMES = new Set([
  "generate_image",
  "generateimage",
  "image_gen",
  "imagegen",
]);

function isImageToolName(name: string): boolean {
  return IMAGE_TOOL_NAMES.has(name.trim().toLowerCase().replace(/-/g, "_"));
}

function promptFromArgs(args: Record<string, unknown>): string {
  const v =
    args.prompt ?? args.description ?? args.image_prompt ?? args.query ?? args.text ?? args.caption;
  if (typeof v === "string") return v.trim();
  if (v == null) return "";
  return String(v).trim();
}

function parseJsonObject(src: string): Record<string, unknown> | null {
  const start = src.indexOf("{");
  if (start === -1) return null;
  const rest = src.slice(start);
  const end = rest.lastIndexOf("}");
  const candidates: string[] = [];
  if (end > 0) candidates.push(rest.slice(0, end + 1));
  const opens = (rest.match(/{/g) ?? []).length;
  const closes = (rest.match(/}/g) ?? []).length;
  if (opens > closes) candidates.push(rest + "}".repeat(opens - closes));
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c) as unknown;
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        return obj as Record<string, unknown>;
      }
    } catch {
      /* next */
    }
  }
  return null;
}

function parseXmlImageCall(text: string): { prompt: string } | null {
  const open = text.indexOf("<tool_call>");
  if (open === -1) return null;
  let body = text.slice(open + "<tool_call>".length);
  const close = body.indexOf("</tool_call>");
  if (close !== -1) body = body.slice(0, close);
  body = body.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const obj = parseJsonObject(body);
  if (!obj || typeof obj.name !== "string" || !isImageToolName(obj.name)) return null;
  let args: unknown = obj.arguments ?? obj.parameters;
  if (!args || typeof args !== "object" || Object.keys(args as object).length === 0) {
    const { name: _n, arguments: _a, parameters: _p, ...rest } = obj;
    if (Object.keys(rest).length > 0) args = rest;
  }
  const prompt = promptFromArgs(
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {},
  );
  return prompt ? { prompt } : null;
}

function parseNativeImageCall(text: string): { prompt: string } | null {
  const open = text.indexOf("<|tool_call_start|>");
  const src = open === -1 ? text : text.slice(open);
  const m = src.match(
    /generate[_-]?image\s*\(\s*(?:prompt|description|text|query)\s*=\s*(['"])([\s\S]*?)\1/i,
  );
  if (!m?.[2]?.trim()) return null;
  return { prompt: m[2].trim() };
}

/** Pull a `generate_image` call out of a chat model's reply. */
export function parseGenerateImageCall(text: string): { prompt: string } | null {
  return parseXmlImageCall(text) ?? parseNativeImageCall(text);
}

/** Drop tool-call markup so the user never sees the protocol. */
export function stripGenerateImageMarkup(text: string): string {
  let cut = text.length;
  const xml = text.indexOf("<tool_call>");
  const native = text.indexOf("<|tool_call_start|>");
  if (xml !== -1) cut = Math.min(cut, xml);
  if (native !== -1) cut = Math.min(cut, native);
  return text.slice(0, cut).trimEnd();
}

/** Model-facing tool doc. Stays in the system prompt while Image gen is on
 *  so the prefix cache is not busted every turn. */
export const IMAGE_GEN_CHAT_TOOL_DOC = `You can make pictures with this tool. Call it when the user wants an image, illustration, poster, scene, or visual. Do not call it for ordinary questions.

<tool_call>{"name":"generate_image","arguments":{"prompt":"<detailed English diffusion prompt>"}}</tool_call>

Write the prompt yourself: subject, setting, style, lighting, composition, and any text that must appear (in quotes). One call, one image. After the call, stop.
You cannot edit the pixels of an attached photo. If they want a variant, describe the desired picture in the prompt.`;
