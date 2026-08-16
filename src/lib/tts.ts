import { synthesize, synthesizeEdge, type SynthAudio } from "./ipc";

export type TtsEngine = "kokoro" | "edge";

export const DEFAULT_EDGE_VOICE = "en-US-JennyNeural";

export interface SpeakSettings {
  ttsEngine: TtsEngine;
  voiceSid: number;
  voiceSpeed: number;
  edgeVoice: string;
  voicePitch: number;
  voiceVolume: number;
}

/** Synthesize with the user's selected read-aloud engine. Live chat must
 *  keep calling `synthesize` (Kokoro) directly — Edge is read-aloud only. */
export function speakWithSettings(settings: SpeakSettings, text: string): Promise<SynthAudio> {
  if (settings.ttsEngine === "edge") {
    return synthesizeEdge(
      text,
      settings.edgeVoice || DEFAULT_EDGE_VOICE,
      settings.voiceSpeed,
      settings.voicePitch,
      settings.voiceVolume,
    );
  }
  return synthesize(text, settings.voiceSpeed, settings.voiceSid);
}
