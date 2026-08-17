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
