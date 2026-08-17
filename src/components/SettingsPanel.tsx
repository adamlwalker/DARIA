import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n, type TKey } from "../lib/i18n";
import { useExitTransition } from "../lib/useExit";
import { Icon } from "./Icon";
import {
  openDataDir,
  openCanvasDir,
  openImagesDir,
  imagegenStatus,
  clearAllConversations,
  dataStats,
  listModels,
  ragStatus,
  ragClearAll,
  openModelsDir,
  openExternal,
  listEdgeVoices,
  openErrorLog,
  type EdgeVoice,
} from "../lib/ipc";
import { decodeAudio, playAudio } from "../lib/audio";
import { SAMPLING_PRESETS, matchingSamplingPreset, applySamplingPresetValues } from "../lib/samplingPresets";
import { speakWithSettings, DEFAULT_EDGE_VOICE, type TtsEngine } from "../lib/tts";
import { CODE_THEMES, type CodeTheme } from "../lib/codeTheme";
import { useConfirm } from "./ConfirmModal";
import { Select } from "./Select";
import { BUILTIN_SKILLS } from "../lib/skills";
import { loadMcpServers, saveMcpServers, syncMcpServers, type McpServerCfg } from "../lib/mcp";
import catalog from "../lib/mcpStore.catalog.json";
import { disabledSkills, officialSkills, setDisabledSkills } from "../lib/skillFiles";
import { fmtBytes } from "../lib/fmt";
import {
  IMAGE_GEN_QUANTS,
  IMAGE_GEN_SIZES,
  type ImageGenQuant,
  type ImageGenSize,
} from "../lib/imageGen";
import { matchingPersonality, PERSONALITY_PRESETS } from "../lib/personalityPresets";
import logoUrl from "../assets/logo.png";

export interface PromptPreset {
  name: string;
  prompt: string;
}

export type Theme = "dark" | "light" | "system";

export interface GenSettings {
  theme: Theme;
  systemPrompt: string;
  temperature: number;
  topP: number;
  /** Whether to cap the per-reply length at `maxTokens` (off = unlimited). */
  limitTokens: boolean;
  maxTokens: number;
  topK: number;
  minP: number;
  repeatPenalty: number;
  /** Newline/comma-separated stop sequences. */
  stop: string;
  /** Saved system-prompt presets. */
  presets: PromptPreset[];
  /** Kokoro voice id (0–10). */
  voiceSid: number;
  /** Speech rate multiplier (0.5–2.0). Shared by Kokoro and Edge TTS. */
  voiceSpeed: number;
  /** Read-aloud engine. Live voice chat always stays on Kokoro. */
  ttsEngine: TtsEngine;
  /** Microsoft Edge TTS short name (e.g. en-US-JennyNeural). */
  edgeVoice: string;
  /** Edge TTS pitch offset in Hz (−50…+50). Ignored by Kokoro. */
  voicePitch: number;
  /** Edge TTS volume offset in percent (−50…+50). Ignored by Kokoro. */
  voiceVolume: number;
  /** GPU offload: -1 = auto‑tune by VRAM, 0 = CPU only, >0 = that many layers. */
  gpuLayers: number;
  /** Context window to load the model with: 0 = memory-friendly default (≤8192),
   *  >0 = that many tokens (clamped to the model's trained length). */
  contextLength: number;
  /** Code mode: max agent steps per turn before it pauses. */
  codeMaxSteps: number;
  /** Code mode: default bash-command timeout in seconds. */
  codeBashTimeout: number;
  /** Code mode: sampling temperature for agent steps (0–1). */
  codeTemperature: number;
  /** Code mode: hard ceiling on thinking tokens per agent round (0 = auto).
   *  Over budget the think block closes gracefully — reasoning kept, model
   *  told to act on it. */
  codeThinkBudget: number;
  /** Code mode: per-round generation budget in tokens (0 = auto by think
   *  depth; always clamped to the context window). */
  codeMaxTokens: number;
  /** Code mode: file edits (write/edit/multi_edit) run without approval. */
  codeAutoApproveEdits: boolean;
  /** Code mode: obviously read-only bash commands run without approval. */
  codeAutoRunReadOnly: boolean;
  /** Code mode: run the agent's browser hidden (headless). */
  codeBrowserHeadless: boolean;
  codeMemory: boolean;
  /** Code mode: user-defined skills (named prompt templates, invoked via /). */
  codeSkills: PromptPreset[];
  /** Code mode: names of built-in skills the user turned off. */
  codeDisabledSkills: string[];
  /** Code mode: command prefixes that never need approval (e.g. "npm test"). */
  codeAllowedCommands: string[];
  /** Dark palette: warm charcoal (v1.5) or the cooler pre-v1.5 charcoal. */
  darkScheme: "warm" | "cool";
  /** Light palette: paper white or the softer warm cream. */
  lightScheme: "paper" | "cream";
  /** Code-block highlight palette (chat markdown). */
  codeTheme: "github-dark" | "atom-one-dark" | "monokai" | "nord";
  /** Chat: collapse long code blocks to a header, focus-follow while streaming. */
  chatCollapseCode: boolean;
  /** Canvas iterations: search/replace patches (fast, needs verbatim SEARCH
   *  echoes) or full-document rewrite (the system diffs the stream live —
   *  the reliable choice for smaller models). */
  canvasEditMode: "patch" | "rewrite";
  /** UI zoom (0.9–1.2). Applied via the native webview page zoom. */
  uiScale: number;
  /** Composer send key: plain Enter, or ⌘/Ctrl+Enter (Enter = newline). */
  sendKey: "enter" | "modEnter";
  /** Disable in-app animations regardless of the OS setting. */
  reduceMotion: boolean;
  /** Reading size for model answers. */
  answerSize: "sm" | "md" | "lg";
  /** Auto-generate conversation titles after the first reply. */
  autoTitle: boolean;
  /** Load the last-used model automatically on startup. */
  autoLoadLast: boolean;
  /** HuggingFace endpoint for search/downloads — the official host or a
   *  path-compatible mirror (e.g. https://hf-mirror.com for mainland China). */
  hfEndpoint: string;
  /** Z-Image-Turbo MLX quant: 4 / 8 / 16 (full). */
  imageGenQuant: ImageGenQuant;
  /** Square output size in pixels. */
  imageGenSize: ImageGenSize;
  /** Turbo denoising steps (8–9 is the distilled sweet spot). */
  imageGenSteps: number;
  /** Fixed seed, or empty for random. */
  imageGenSeed: string;
}

export const defaultSettings: GenSettings = {
  theme: "dark",
  systemPrompt: "",
  temperature: 0.7,
  topP: 0.95,
  limitTokens: false,
  maxTokens: 1024,
  topK: 40,
  minP: 0.05,
  repeatPenalty: 1.1,
  stop: "",
  presets: [],
  voiceSid: 0,
  voiceSpeed: 1.0,
  ttsEngine: "kokoro",
  edgeVoice: DEFAULT_EDGE_VOICE,
  voicePitch: 0,
  voiceVolume: 0,
  gpuLayers: -1,
  contextLength: 0,
  codeMaxSteps: 64,
  codeBashTimeout: 60,
  codeTemperature: 0.3,
  codeThinkBudget: 0,
  codeMaxTokens: 0,
  codeAutoApproveEdits: false,
  codeAutoRunReadOnly: true,
  codeBrowserHeadless: false,
  codeMemory: true,
  codeSkills: [],
  codeDisabledSkills: [],
  codeAllowedCommands: [],
  darkScheme: "warm",
  lightScheme: "paper",
  codeTheme: "github-dark",
  chatCollapseCode: true,
  canvasEditMode: "patch",
  uiScale: 1,
  sendKey: "enter",
  reduceMotion: false,
  answerSize: "md",
  autoTitle: true,
  autoLoadLast: true,
  hfEndpoint: "https://huggingface.co",
  imageGenQuant: 8,
  imageGenSize: 1024,
  imageGenSteps: 9,
  imageGenSeed: "",
};

/** The well-known HF endpoints offered as one-click choices. */
export const HF_ENDPOINT_OFFICIAL = "https://huggingface.co";
export const HF_ENDPOINT_MIRROR = "https://hf-mirror.com";

/** kokoro-en-v0_19 speakers, in sid order (the array index IS the speaker id,
 *  so the order must not change). This pack ships exactly these 11 voices;
 *  the larger Kokoro-82M set (af_heart, am_fenrir, …) needs a different model.
 *  Labels carry the Kokoro VOICES.md overall grade so users can pick good ones;
 *  ★ marks the best in each gender. */
export const VOICES = [
  "af · warm female · C+",
  "★ af_bella · female · A-",
  "af_nicole · female · B-",
  "af_sarah · female · C+",
  "af_sky · female · C-",
  "am_adam · male · F+",
  "★ am_michael · male · C+",
  "bf_emma · UK female · B-",
  "bf_isabella · UK female · C",
  "bm_george · UK male · C",
  "bm_lewis · UK male · D+",
];

/** Parse the stop-sequence textarea into a clean array for the backend. */
export function parseStops(raw: string): string[] {
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

type CatId = "general" | "chat" | "image" | "sampling" | "model" | "code" | "voice" | "data" | "about";

const CAT_ICONS: Record<CatId, string> = {
  general: "M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18",
  chat: "M21 12a8 8 0 01-8 8H5l-2 2V12a8 8 0 018-8h2a8 8 0 018 8z",
  image: "M4 6.5A2.5 2.5 0 016.5 4h11A2.5 2.5 0 0120 6.5v11a2.5 2.5 0 01-2.5 2.5h-11A2.5 2.5 0 014 17.5v-11zM8 14l2.2-2.8 2.3 2.8L16 10l4 6H4l4-2z",
  sampling: "M4 20V10M10 20V4M16 20v-8M22 20H2",
  model: "M4 7l8-4 8 4v10l-8 4-8-4zM4 7l8 4m0 0l8-4m-8 4v10",
  code: "M8 6l-6 6 6 6M16 6l6 6-6 6",
  voice: "M12 3a3 3 0 013 3v6a3 3 0 11-6 0V6a3 3 0 013-3zM19 11a7 7 0 11-14 0M12 18v3",
  data: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  about: "M12 3a9 9 0 100 18 9 9 0 000-18zM12 8h.01M12 12v5",
};

/** Modifier-key glyph for the current platform (send-shortcut labels). */
const MOD_KEY = /mac/i.test(navigator.platform ?? navigator.userAgent) ? "⌘" : "Ctrl +";



/** Aggregated numbers behind the Data-category statistics tiles. */
interface StatsView {
  convs: number;
  msgs: number;
  code: number;
  db: number;
  models: number;
  modelBytes: number;
  kbDocs: number;
  kbChunks: number;
}

/** LM-Studio-style row: label (+hint) left, control right. */
function SetRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="field field-row">
      <div className="field-row-text">
        <span>{label}</span>
        {hint && <span className="field-row-hint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Switch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} className={`set-switch ${on ? "on" : ""}`} onClick={onToggle}>
      <span className="set-knob" />
    </button>
  );
}

export function SettingsPanel({
  open,
  value,
  onChange,
  onClose,
  maxTokensLimit = 4096,
  ctxTrainLimit,
  onReloadModel,
  reloading = false,
  onDataCleared,
}: {
  open: boolean;
  value: GenSettings;
  onChange: (next: GenSettings) => void;
  onClose: () => void;
  /** Upper bound for the max-length slider — adapts to the loaded model's context. */
  maxTokensLimit?: number;
  /** The loaded model's trained context length, used as the slider ceiling. */
  ctxTrainLimit?: number | null;
  /** Reload the current model so context/GPU changes take effect. Absent = no model. */
  onReloadModel?: () => void;
  reloading?: boolean;
  /** Called after the user clears all conversations, so the app can reset. */
  onDataCleared?: () => void;
}) {
  const { t, lang, setLang } = useI18n();
  const confirm = useConfirm();
  const [cat, setCat] = useState<CatId>("general");
  const [presetName, setPresetName] = useState("");
  const set = <K extends keyof GenSettings>(key: K, v: GenSettings[K]) =>
    onChange({ ...value, [key]: v });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Mounted through the exit animation; fully unmounted after.
  const { mounted, closing } = useExitTransition(open);

  // ---- Data-category statistics ----
  const [stats, setStats] = useState<StatsView | null>(null);
  const refreshStats = () => {
    Promise.all([
      dataStats(),
      listModels().catch(() => []),
      ragStatus().catch(() => null),
    ])
      .then(([ds, models, rs]) =>
        setStats({
          convs: ds.conversations,
          msgs: ds.messages,
          code: ds.codeSessions,
          db: ds.dbBytes,
          models: models.length,
          modelBytes: models.reduce((a, m) => a + (m.sizeMb ?? 0) * 1e6, 0),
          kbDocs: rs?.docs ?? 0,
          kbChunks: rs?.chunks ?? 0,
        }),
      )
      .catch(console.error);
  };
  useEffect(() => {
    if (open && cat === "data") refreshStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cat]);

  const [imageRamHint, setImageRamHint] = useState<number>(8);
  useEffect(() => {
    if (!open || cat !== "image") return;
    void imagegenStatus()
      .then((s) => setImageRamHint(s.recommendedQuant || 8))
      .catch(() => {});
  }, [open, cat]);

  // ---- Voice preview ----
  const [voiceTesting, setVoiceTesting] = useState(false);
  const [edgeVoices, setEdgeVoices] = useState<EdgeVoice[]>([]);
  const [edgeVoicesErr, setEdgeVoicesErr] = useState("");
  const [edgeVoicesLoading, setEdgeVoicesLoading] = useState(false);
  const testVoice = () => {
    if (voiceTesting) return;
    setVoiceTesting(true);
    speakWithSettings(value, "Hi! This is how I sound. Nice to meet you.")
      .then((a) => playAudio(decodeAudio(a.audio), a.sampleRate).done)
      .catch((e) => {
        console.error(e);
        setEdgeVoicesErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setVoiceTesting(false));
  };
  useEffect(() => {
    if (!open || cat !== "voice" || value.ttsEngine !== "edge") return;
    let cancelled = false;
    setEdgeVoicesLoading(true);
    listEdgeVoices()
      .then((vs) => {
        if (cancelled) return;
        setEdgeVoices(vs);
        setEdgeVoicesErr("");
        if (vs.length && !vs.some((v) => v.shortName === value.edgeVoice)) {
          set("edgeVoice", vs[0].shortName);
        }
      })
      .catch((e) => {
        if (!cancelled) setEdgeVoicesErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setEdgeVoicesLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cat, value.ttsEngine]);

  const applySamplingPreset = (id: string) => {
    const p = SAMPLING_PRESETS.find((x) => x.id === id);
    if (!p) return;
    onChange(applySamplingPresetValues(value, p));
  };

  const savePreset = () => {
    const name = presetName.trim();
    const prompt = value.systemPrompt.trim();
    if (!name || !prompt) return;
    const presets = [...value.presets.filter((p) => p.name !== name), { name, prompt }];
    onChange({ ...value, presets });
    setPresetName("");
  };
  const deletePreset = (name: string) =>
    onChange({ ...value, presets: value.presets.filter((p) => p.name !== name) });

  const [skillName, setSkillName] = useState("");
  const [skillPrompt, setSkillPrompt] = useState("");
  const saveSkill = () => {
    // Skill names become /slash entries — keep them single-token.
    const name = skillName.trim().replace(/^\/+/, "").replace(/\s+/g, "-");
    const prompt = skillPrompt.trim();
    if (!name || !prompt) return;
    const codeSkills = [...value.codeSkills.filter((s) => s.name !== name), { name, prompt }];
    onChange({ ...value, codeSkills });
    setSkillName("");
    setSkillPrompt("");
  };
  const deleteSkill = (name: string) =>
    onChange({ ...value, codeSkills: value.codeSkills.filter((s) => s.name !== name) });

  const [allowInput, setAllowInput] = useState("");
  const [mcpServers, setMcpServers] = useState<McpServerCfg[]>(loadMcpServers);
  const [mcpStatus, setMcpStatus] = useState<Record<string, string>>({});
  const [mcpName, setMcpName] = useState("");
  const [mcpCmd, setMcpCmd] = useState("");
  const [mcpToken, setMcpToken] = useState("");
  /** Store entry pending placeholder/token input before it can be added. */
  const [skillOff, setSkillOff] = useState<string[]>(disabledSkills);
  const toggleSkill = (name: string) => {
    const next = skillOff.includes(name) ? skillOff.filter((n) => n !== name) : [...skillOff, name];
    setSkillOff(next);
    setDisabledSkills(next);
  };
  const [storeOpen, setStoreOpen] = useState<string | null>(null);
  const [storeInput, setStoreInput] = useState<Record<string, string>>({});
  const addFromStore = (entry: (typeof catalog)["entries"][number]) => {
    const values = storeInput;
    if (entry.transport === "http") {
      const token = (values.token ?? "").trim();
      if ((entry as { needsToken?: boolean }).needsToken && !token) return;
      applyMcp([
        ...mcpServers,
        {
          name: entry.id,
          enabled: true,
          transport: "http",
          url: (entry as { url?: string }).url ?? "",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        },
      ]);
    } else {
      const args = ((entry as { args?: string[] }).args ?? []).map((a) => {
        let out = a;
        for (const ph of (entry as { placeholders?: { key: string }[] }).placeholders ?? []) {
          out = out.split(`{${ph.key}}`).join((values[ph.key] ?? "").trim());
        }
        return out;
      });
      if (args.some((a) => /\{[a-z]+\}/.test(a))) return; // unfilled placeholder
      applyMcp([
        ...mcpServers,
        { name: entry.id, enabled: true, transport: "stdio", command: (entry as { command?: string }).command ?? "npx", args },
      ]);
    }
    setStoreOpen(null);
    setStoreInput({});
  };
  const applyMcp = (list: McpServerCfg[]) => {
    setMcpServers(list);
    saveMcpServers(list);
    void syncMcpServers(list).then((rs) => {
      setMcpStatus((prev) => {
        const st: Record<string, string> = { ...prev };
        for (const r of rs) st[r.server] = r.error ? `✗ ${r.error.slice(0, 90)}` : `✓ ${r.tools} tools`;
        return st;
      });
    });
  };
  const addMcp = () => {
    const name = mcpName.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 16);
    const cmd = mcpCmd.trim();
    if (!name || !cmd || mcpServers.some((x) => x.name === name)) return;
    const token = mcpToken.trim();
    const cfg: McpServerCfg = /^https?:\/\//.test(cmd)
      ? { name, enabled: true, transport: "http", url: cmd, headers: token ? { Authorization: `Bearer ${token}` } : {} }
      : { name, enabled: true, transport: "stdio", command: cmd.split(/\s+/)[0], args: cmd.split(/\s+/).slice(1) };
    applyMcp([...mcpServers, cfg]);
    setMcpName("");
    setMcpCmd("");
    setMcpToken("");
  };
  const addAllow = () => {
    const p = allowInput.trim();
    if (!p) return;
    if (!value.codeAllowedCommands.includes(p)) {
      set("codeAllowedCommands", [...value.codeAllowedCommands, p]);
    }
    setAllowInput("");
  };

  const cats: { id: CatId; label: string }[] = [
    { id: "general", label: t("setCatGeneral") },
    { id: "chat", label: t("setCatChat") },
    { id: "image", label: t("setCatImage") },
    { id: "sampling", label: t("setCatSampling") },
    { id: "model", label: t("setCatModel") },
    { id: "code", label: t("setCatCode") },
    // TTS is English-only, so the voice section only exists in English UI.
    ...(lang === "en" ? [{ id: "voice" as CatId, label: t("setCatVoice") }] : []),
    { id: "data", label: t("setCatData") },
    { id: "about", label: t("setCatAbout") },
  ];

  if (!mounted) return null;

  return createPortal(
    <div className={`settings-overlay ${closing ? "closing" : ""}`} onMouseDown={onClose}>
      <div className="settings-modal" onMouseDown={(e) => e.stopPropagation()}>
        <aside className="settings-nav">
          <div className="settings-nav-title">{t("settingsTitle")}</div>
          {cats.map((c) => (
            <button
              key={c.id}
              className={`settings-nav-item ${cat === c.id ? "active" : ""}`}
              onClick={() => setCat(c.id)}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d={CAT_ICONS[c.id]} />
              </svg>
              {c.label}
            </button>
          ))}
        </aside>

        <div className="settings-pane">
          {/* Fixed pane header: category title + close. Only the body scrolls. */}
          <div className="settings-pane-head">
            <span className="settings-pane-title">{cats.find((c) => c.id === cat)?.label}</span>
            <button className="settings-close" onClick={onClose} aria-label={t("cancel")}>
              <Icon name="x" size={11} strokeWidth={2.2} />
            </button>
          </div>

          <div className="settings-pane-body">
          {cat === "general" && (
            <>
              <SetRow label={t("language")}>
                <div className="lang-switch">
                  <button type="button" className={lang === "zh" ? "active" : ""} onClick={() => setLang("zh")}>中文</button>
                  <button type="button" className={lang === "en" ? "active" : ""} onClick={() => setLang("en")}>English</button>
                </div>
              </SetRow>
              <SetRow label={t("theme")}>
                <div className="lang-switch">
                  <button type="button" className={value.theme === "system" ? "active" : ""} onClick={() => set("theme", "system")}>{t("themeSystem")}</button>
                  <button type="button" className={value.theme === "light" ? "active" : ""} onClick={() => set("theme", "light")}>{t("themeLight")}</button>
                  <button type="button" className={value.theme === "dark" ? "active" : ""} onClick={() => set("theme", "dark")}>{t("themeDark")}</button>
                </div>
              </SetRow>
              <SetRow label={t("setDarkScheme")} hint={t("setDarkSchemeHint")}>
                <div className="lang-switch">
                  <button type="button" className={value.darkScheme === "warm" ? "active" : ""} onClick={() => set("darkScheme", "warm")}>
                    <span className="scheme-dot" style={{ background: "#201f1d" }} />
                    {t("schemeWarmCharcoal")}
                  </button>
                  <button type="button" className={value.darkScheme === "cool" ? "active" : ""} onClick={() => set("darkScheme", "cool")}>
                    <span className="scheme-dot" style={{ background: "#0e0f12" }} />
                    {t("schemeCoolCharcoal")}
                  </button>
                </div>
              </SetRow>
              <SetRow label={t("setLightScheme")} hint={t("setLightSchemeHint")}>
                <div className="lang-switch">
                  <button type="button" className={value.lightScheme === "paper" ? "active" : ""} onClick={() => set("lightScheme", "paper")}>
                    <span className="scheme-dot" style={{ background: "#faf9f7" }} />
                    {t("schemePaper")}
                  </button>
                  <button type="button" className={value.lightScheme === "cream" ? "active" : ""} onClick={() => set("lightScheme", "cream")}>
                    <span className="scheme-dot" style={{ background: "#f3eee4" }} />
                    {t("schemeCream")}
                  </button>
                </div>
              </SetRow>
              <SetRow label={t("setUiScale")} hint={t("setUiScaleHint")}>
                <div className="lang-switch">
                  {[0.9, 1, 1.1, 1.2].map((s) => (
                    <button key={s} type="button" className={Math.abs(value.uiScale - s) < 0.01 ? "active" : ""} onClick={() => set("uiScale", s)}>
                      {Math.round(s * 100)}%
                    </button>
                  ))}
                </div>
              </SetRow>
              <SetRow label={t("setSendKey")} hint={t("setSendKeyHint")}>
                <div className="lang-switch">
                  <button type="button" className={value.sendKey === "enter" ? "active" : ""} onClick={() => set("sendKey", "enter")}>Enter</button>
                  <button type="button" className={value.sendKey === "modEnter" ? "active" : ""} onClick={() => set("sendKey", "modEnter")}>{MOD_KEY} Enter</button>
                </div>
              </SetRow>
              <SetRow label={t("setReduceMotion")} hint={t("setReduceMotionHint")}>
                <Switch on={value.reduceMotion} onToggle={() => set("reduceMotion", !value.reduceMotion)} />
              </SetRow>
              <SetRow label={t("errorLog")} hint={t("errorLogHint")}>
                <div className="lang-switch">
                  <button type="button" onClick={() => { void openErrorLog().catch(() => {}); }}>
                    {t("errorLogOpen")}
                  </button>
                </div>
              </SetRow>
            </>
          )}

          {cat === "chat" && (
            <>
              <label className="field">
                <span>{t("systemPrompt")}</span>
                <textarea
                  rows={4}
                  placeholder={t("systemPromptPh")}
                  value={value.systemPrompt}
                  onChange={(e) => set("systemPrompt", e.target.value)}
                />
              </label>
              <div className="field">
                <span>{t("presets")}</span>
                <div className="settings-hint">{t("personalityHint")}</div>
                <div className="preset-chips">
                  {PERSONALITY_PRESETS.map((p) => {
                    const on = matchingPersonality(value.systemPrompt) === p.id;
                    return (
                      <span key={p.id} className={`preset-chip ${on ? "on" : ""}`}>
                        <button
                          type="button"
                          className="preset-apply"
                          title={p.prompt}
                          onClick={() => set("systemPrompt", on ? "" : p.prompt)}
                        >
                          {t(p.labelKey)}
                        </button>
                      </span>
                    );
                  })}
                </div>
                {value.presets.length > 0 && (
                  <div className="preset-chips">
                    {value.presets.map((p) => (
                      <span key={p.name} className="preset-chip">
                        <button type="button" className="preset-apply" title={p.prompt} onClick={() => set("systemPrompt", p.prompt)}>
                          {p.name}
                        </button>
                        <button type="button" className="preset-del" title={t("cancel")} onClick={() => deletePreset(p.name)}><Icon name="x" size={11} strokeWidth={2.2} /></button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="preset-add">
                  <input
                    type="text"
                    placeholder={t("presetNamePh")}
                    value={presetName}
                    onChange={(e) => setPresetName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        savePreset();
                      }
                    }}
                  />
                  <button type="button" onClick={savePreset} disabled={!presetName.trim() || !value.systemPrompt.trim()}>
                    {t("presetSave")}
                  </button>
                </div>
              </div>
              <SetRow label={t("setCodeTheme")} hint={t("setCodeThemeHint")}>
                <div className="lang-switch">
                  {(Object.keys(CODE_THEMES) as CodeTheme[]).map((k) => (
                    <button key={k} type="button" className={value.codeTheme === k ? "active" : ""} onClick={() => set("codeTheme", k)}>
                      {CODE_THEMES[k].label}
                    </button>
                  ))}
                </div>
              </SetRow>
              <SetRow label={t("chatCollapseCode")} hint={t("chatCollapseCodeHint")}>
                <Switch
                  on={value.chatCollapseCode}
                  onToggle={() => set("chatCollapseCode", !value.chatCollapseCode)}
                />
              </SetRow>
              <SetRow label={t("canvasEditModeLabel")} hint={t("canvasEditModeHint")}>
                <div className="lang-switch">
                  <button type="button" className={value.canvasEditMode === "patch" ? "active" : ""} onClick={() => set("canvasEditMode", "patch")}>{t("canvasEditModePatch")}</button>
                  <button type="button" className={value.canvasEditMode === "rewrite" ? "active" : ""} onClick={() => set("canvasEditMode", "rewrite")}>{t("canvasEditModeRewrite")}</button>
                </div>
              </SetRow>
              <SetRow label={t("setAnswerSize")} hint={t("setAnswerSizeHint")}>
                <div className="lang-switch">
                  <button type="button" className={value.answerSize === "sm" ? "active" : ""} onClick={() => set("answerSize", "sm")}>{t("sizeSm")}</button>
                  <button type="button" className={value.answerSize === "md" ? "active" : ""} onClick={() => set("answerSize", "md")}>{t("sizeMd")}</button>
                  <button type="button" className={value.answerSize === "lg" ? "active" : ""} onClick={() => set("answerSize", "lg")}>{t("sizeLg")}</button>
                </div>
              </SetRow>
              <SetRow label={t("setAutoTitle")} hint={t("setAutoTitleHint")}>
                <Switch on={value.autoTitle} onToggle={() => set("autoTitle", !value.autoTitle)} />
              </SetRow>
            </>
          )}

          {cat === "image" && (
            <>
              <div className="settings-hint">{t("imageGenHint")}</div>
              <div className="settings-hint">{t("imageGenPrivacy")}</div>
              <SetRow label={t("imageGenQuant")} hint={t("imageGenQuantHint", { n: imageRamHint })}>
                <div className="lang-switch">
                  {IMAGE_GEN_QUANTS.map((q) => (
                    <button
                      key={q}
                      type="button"
                      className={value.imageGenQuant === q ? "active" : ""}
                      onClick={() => set("imageGenQuant", q)}
                    >
                      {t(q === 4 ? "imageGenQuant4" : q === 8 ? "imageGenQuant8" : "imageGenQuant16")}
                    </button>
                  ))}
                </div>
              </SetRow>
              <SetRow label={t("imageGenSize")} hint={t("imageGenSizeHint")}>
                <div className="lang-switch">
                  {IMAGE_GEN_SIZES.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={value.imageGenSize === s ? "active" : ""}
                      onClick={() => set("imageGenSize", s)}
                    >
                      {s}px
                    </button>
                  ))}
                </div>
              </SetRow>
              <label className="field">
                <span>
                  {t("imageGenSteps")} <b>{value.imageGenSteps}</b>
                </span>
                <input
                  type="range"
                  min={4}
                  max={12}
                  step={1}
                  value={value.imageGenSteps}
                  onChange={(e) => set("imageGenSteps", Number(e.target.value))}
                />
              </label>
              <div className="settings-hint">{t("imageGenStepsHint")}</div>
              <SetRow label={t("imageGenSeed")} hint={t("imageGenSeedHint")}>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder={t("imageGenSeedRandom")}
                  value={value.imageGenSeed}
                  onChange={(e) => set("imageGenSeed", e.target.value.replace(/[^\d]/g, "").slice(0, 12))}
                  style={{ width: 120, textAlign: "right" }}
                />
              </SetRow>
              <SetRow label={t("imageGenFolder")} hint={t("imageGenFolderHint")}>
                <button type="button" className="data-btn" onClick={() => void openImagesDir().catch(console.error)}>
                  {t("openImagesDir")}
                </button>
              </SetRow>
            </>
          )}

          {cat === "sampling" && (
            <>
              <label className="field">
                <span>{t("samplingPreset")}</span>
                <Select
                  className="field-select"
                  value={matchingSamplingPreset(value)}
                  ariaLabel={t("samplingPreset")}
                  onChange={(id) => {
                    if (id) applySamplingPreset(id);
                  }}
                  options={[
                    { value: "", label: t("samplingPresetCustom") },
                    ...SAMPLING_PRESETS.map((p) => ({ value: p.id, label: t(p.labelKey as TKey), group: p.family })),
                  ]}
                />
              </label>
              <div className="settings-hint">{t("samplingPresetHint")}</div>
              <label className="field">
                <span>
                  <em className="has-tip" data-tip={t("tipTemperature")}>{t("temperature")}</em> <b>{value.temperature.toFixed(2)}</b>
                </span>
                <input type="range" min={0} max={1.5} step={0.05} value={value.temperature} onChange={(e) => set("temperature", Number(e.target.value))} />
              </label>
              <label className="field">
                <span>
                  <em className="has-tip" data-tip={t("tipTopP")}>Top-P</em> <b>{value.topP.toFixed(2)}</b>
                </span>
                <input type="range" min={0.1} max={1} step={0.01} value={value.topP} onChange={(e) => set("topP", Number(e.target.value))} />
              </label>
              <label className="field">
                <span><em className="has-tip" data-tip={t("tipMaxTokens")}>{t("maxTokens")}</em></span>
                <div className="lang-switch">
                  <button type="button" className={!value.limitTokens ? "active" : ""} onClick={() => set("limitTokens", false)}>{t("noLimit")}</button>
                  <button type="button" className={value.limitTokens ? "active" : ""} onClick={() => set("limitTokens", true)}>{t("gpuCustom")}</button>
                </div>
              </label>
              {value.limitTokens && (
                <label className="field">
                  <span>
                    {t("maxTokens")} <b>{value.maxTokens}</b>
                  </span>
                  <input
                    type="range"
                    min={128}
                    max={maxTokensLimit}
                    step={128}
                    value={Math.min(value.maxTokens, maxTokensLimit)}
                    onChange={(e) => set("maxTokens", Number(e.target.value))}
                  />
                </label>
              )}
              <label className="field">
                <span>
                  <em className="has-tip" data-tip={t("tipTopK")}>Top-K</em> <b>{value.topK === 0 ? t("off") : value.topK}</b>
                </span>
                <input type="range" min={0} max={100} step={1} value={value.topK} onChange={(e) => set("topK", Number(e.target.value))} />
              </label>
              <label className="field">
                <span>
                  <em className="has-tip" data-tip={t("tipMinP")}>Min-P</em> <b>{value.minP.toFixed(2)}</b>
                </span>
                <input type="range" min={0} max={0.5} step={0.01} value={value.minP} onChange={(e) => set("minP", Number(e.target.value))} />
              </label>
              <label className="field">
                <span>
                  <em className="has-tip" data-tip={t("tipRepeatPenalty")}>{t("repeatPenalty")}</em> <b>{value.repeatPenalty.toFixed(2)}</b>
                </span>
                <input type="range" min={1} max={1.5} step={0.01} value={value.repeatPenalty} onChange={(e) => set("repeatPenalty", Number(e.target.value))} />
              </label>
              <label className="field">
                <span><em className="has-tip" data-tip={t("tipStopSeqs")}>{t("stopSeqs")}</em></span>
                <textarea rows={2} placeholder={t("stopSeqsPh")} value={value.stop} onChange={(e) => set("stop", e.target.value)} />
              </label>
              <button
                className="settings-reset"
                onClick={() =>
                  onChange({
                    ...value,
                    temperature: defaultSettings.temperature,
                    topP: defaultSettings.topP,
                    limitTokens: defaultSettings.limitTokens,
                    maxTokens: defaultSettings.maxTokens,
                    topK: defaultSettings.topK,
                    minP: defaultSettings.minP,
                    repeatPenalty: defaultSettings.repeatPenalty,
                    stop: defaultSettings.stop,
                  })
                }
              >
                {t("resetDefaults")}
              </button>
              {onReloadModel && (
                <button className="settings-reload" onClick={onReloadModel} disabled={reloading}>
                  {reloading ? "…" : t("reloadApply")}
                </button>
              )}
            </>
          )}

          {cat === "model" && (
            <>
              <label className="field">
                <span><em className="has-tip" data-tip={t("tipGpuAccel")}>{t("gpuAccel")}</em></span>
                <div className="lang-switch">
                  <button type="button" className={value.gpuLayers < 0 ? "active" : ""} onClick={() => set("gpuLayers", -1)}>{t("gpuAuto")}</button>
                  <button type="button" className={value.gpuLayers === 0 ? "active" : ""} onClick={() => set("gpuLayers", 0)}>{t("gpuOff")}</button>
                  <button
                    type="button"
                    className={value.gpuLayers > 0 ? "active" : ""}
                    onClick={() => set("gpuLayers", value.gpuLayers > 0 ? value.gpuLayers : 20)}
                  >
                    {t("gpuCustom")}
                  </button>
                </div>
              </label>
              {value.gpuLayers > 0 && (
                <label className="field">
                  <span>
                    {t("gpuLayersLabel")} <b>{value.gpuLayers}</b>
                  </span>
                  <input type="range" min={1} max={80} step={1} value={value.gpuLayers} onChange={(e) => set("gpuLayers", Number(e.target.value))} />
                </label>
              )}
              <div className="settings-hint">{t("gpuHint")}</div>

              <label className="field">
                <span><em className="has-tip" data-tip={t("tipCtxLength")}>{t("ctxLength")}</em></span>
                <div className="lang-switch">
                  <button type="button" className={value.contextLength <= 0 ? "active" : ""} onClick={() => set("contextLength", 0)}>{t("ctxAuto")}</button>
                  <button
                    type="button"
                    className={value.contextLength > 0 ? "active" : ""}
                    onClick={() => set("contextLength", value.contextLength > 0 ? value.contextLength : 8192)}
                  >
                    {t("gpuCustom")}
                  </button>
                </div>
              </label>
              {value.contextLength > 0 &&
                (() => {
                  // Slider ceiling = the loaded model's trained context (fallback
                  // 32768 when nothing is loaded) — no point offering more.
                  const ctxMax = Math.max(4096, ctxTrainLimit ?? 32768);
                  return (
                    <label className="field">
                      <span>
                        {t("ctxTokens")} <b>{Math.min(value.contextLength, ctxMax)}</b>
                      </span>
                      <input
                        type="range"
                        min={2048}
                        max={ctxMax}
                        step={2048}
                        value={Math.min(value.contextLength, ctxMax)}
                        onChange={(e) => set("contextLength", Number(e.target.value))}
                      />
                    </label>
                  );
                })()}
              <div className="settings-hint">{t("ctxHint")}</div>
              {onReloadModel && (
                <button className="settings-reload" onClick={onReloadModel} disabled={reloading}>
                  {reloading ? "…" : t("reloadApply")}
                </button>
              )}
              <SetRow label={t("setAutoLoadLast")} hint={t("setAutoLoadLastHint")}>
                <Switch on={value.autoLoadLast} onToggle={() => set("autoLoadLast", !value.autoLoadLast)} />
              </SetRow>
              <SetRow label={t("modelsFolder")} hint={t("modelsFolderHint")}>
                <button type="button" className="data-btn" onClick={() => void openModelsDir().catch(console.error)}>
                  {t("openModelsDir")}
                </button>
              </SetRow>

              <label className="field">
                <span><em className="has-tip" data-tip={t("tipHfEndpoint")}>{t("hfEndpoint")}</em></span>
                <div className="lang-switch">
                  <button
                    type="button"
                    className={value.hfEndpoint === HF_ENDPOINT_OFFICIAL ? "active" : ""}
                    onClick={() => set("hfEndpoint", HF_ENDPOINT_OFFICIAL)}
                  >
                    {t("hfEndpointOfficial")}
                  </button>
                  <button
                    type="button"
                    className={value.hfEndpoint === HF_ENDPOINT_MIRROR ? "active" : ""}
                    onClick={() => set("hfEndpoint", HF_ENDPOINT_MIRROR)}
                  >
                    hf-mirror.com
                  </button>
                  <button
                    type="button"
                    className={
                      value.hfEndpoint !== HF_ENDPOINT_OFFICIAL && value.hfEndpoint !== HF_ENDPOINT_MIRROR
                        ? "active"
                        : ""
                    }
                    onClick={() => {
                      if (value.hfEndpoint === HF_ENDPOINT_OFFICIAL || value.hfEndpoint === HF_ENDPOINT_MIRROR) {
                        set("hfEndpoint", "https://");
                      }
                    }}
                  >
                    {t("hfEndpointCustom")}
                  </button>
                </div>
              </label>
              {value.hfEndpoint !== HF_ENDPOINT_OFFICIAL && value.hfEndpoint !== HF_ENDPOINT_MIRROR && (
                <div className="preset-add">
                  <input
                    type="text"
                    placeholder="https://…"
                    value={value.hfEndpoint}
                    onChange={(e) => set("hfEndpoint", e.target.value)}
                    spellCheck={false}
                  />
                </div>
              )}
              <div className="settings-hint">{t("hfEndpointHint")}</div>
            </>
          )}

          {cat === "code" && (
            <>
              <label className="field">
                <span>
                  {t("cmMaxSteps")} <b>{value.codeMaxSteps}</b>
                </span>
                <input
                  type="range"
                  min={8}
                  max={96}
                  step={4}
                  value={value.codeMaxSteps}
                  onChange={(e) => set("codeMaxSteps", Number(e.target.value))}
                />
              </label>
              <div className="settings-hint">{t("cmMaxStepsHint")}</div>

              <label className="field">
                <span>
                  {t("cmBashTimeout")} <b>{value.codeBashTimeout}s</b>
                </span>
                <input
                  type="range"
                  min={10}
                  max={300}
                  step={10}
                  value={value.codeBashTimeout}
                  onChange={(e) => set("codeBashTimeout", Number(e.target.value))}
                />
              </label>
              <div className="settings-hint">{t("cmBashTimeoutHint")}</div>

              <label className="field">
                <span>
                  {t("cmTemp")} <b>{value.codeTemperature.toFixed(2)}</b>
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={value.codeTemperature}
                  onChange={(e) => set("codeTemperature", Number(e.target.value))}
                />
              </label>
              <div className="settings-hint">{t("cmTempHint")}</div>

              <label className="field">
                <span>
                  {t("cmThinkBudget")}{" "}
                  <b>{value.codeThinkBudget > 0 ? value.codeThinkBudget : t("cmThinkBudgetOff")}</b>
                </span>
                <input
                  type="range"
                  min={0}
                  max={6000}
                  step={250}
                  value={value.codeThinkBudget}
                  onChange={(e) => set("codeThinkBudget", Number(e.target.value))}
                />
              </label>
              <div className="settings-hint">{t("cmThinkBudgetHint")}</div>

              <label className="field">
                <span>
                  {t("cmMaxTokens")}{" "}
                  <b>{value.codeMaxTokens > 0 ? value.codeMaxTokens : t("cmMaxTokensAuto")}</b>
                </span>
                <input
                  type="range"
                  min={0}
                  max={12288}
                  step={512}
                  value={value.codeMaxTokens}
                  onChange={(e) => set("codeMaxTokens", Number(e.target.value))}
                />
              </label>
              <div className="settings-hint">{t("cmMaxTokensHint")}</div>

              <SetRow label={t("cmAutoEdits")} hint={t("cmAutoEditsHint")}>
                <Switch
                  on={value.codeAutoApproveEdits}
                  onToggle={() => set("codeAutoApproveEdits", !value.codeAutoApproveEdits)}
                />
              </SetRow>
              <SetRow label={t("cmAutoReadOnly")} hint={t("cmAutoReadOnlyHint")}>
                <Switch
                  on={value.codeAutoRunReadOnly}
                  onToggle={() => set("codeAutoRunReadOnly", !value.codeAutoRunReadOnly)}
                />
              </SetRow>
              <SetRow label={t("cmHeadless")} hint={t("cmHeadlessHint")}>
                <Switch
                  on={value.codeBrowserHeadless}
                  onToggle={() => set("codeBrowserHeadless", !value.codeBrowserHeadless)}
                />
              </SetRow>
              <SetRow label={t("cmMemory")} hint={t("cmMemoryHint")}>
                <Switch
                  on={value.codeMemory}
                  onToggle={() => set("codeMemory", !value.codeMemory)}
                />
              </SetRow>

              <div className="field">
                <span>{t("cmAllowlist")}</span>
                {value.codeAllowedCommands.length > 0 && (
                  <div className="preset-chips">
                    {value.codeAllowedCommands.map((p) => (
                      <span key={p} className="preset-chip">
                        <span className="preset-apply allow-chip">{p}</span>
                        <button
                          type="button"
                          className="preset-del"
                          title={t("cancel")}
                          onClick={() =>
                            set("codeAllowedCommands", value.codeAllowedCommands.filter((x) => x !== p))
                          }
                        ><Icon name="x" size={11} strokeWidth={2.2} /></button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="preset-add">
                  <input
                    type="text"
                    placeholder={t("cmAllowlistPh")}
                    value={allowInput}
                    onChange={(e) => setAllowInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addAllow();
                      }
                    }}
                  />
                  <button type="button" onClick={addAllow} disabled={!allowInput.trim()}>
                    {t("presetSave")}
                  </button>
                </div>
              </div>
              <div className="settings-hint">{t("cmAllowlistHint")}</div>

              <div className="field">
                <span>{t("cmBuiltinSkills")}</span>
                <div className="skill-rows">
                  {BUILTIN_SKILLS.map((s) => {
                    const enabled = !value.codeDisabledSkills.includes(s.name);
                    return (
                      <button
                        key={s.name}
                        type="button"
                        className={`skill-row ${enabled ? "on" : ""}`}
                        onClick={() =>
                          set(
                            "codeDisabledSkills",
                            enabled
                              ? [...value.codeDisabledSkills, s.name]
                              : value.codeDisabledSkills.filter((n) => n !== s.name),
                          )
                        }
                      >
                        <span className="skill-row-name">/{s.name}</span>
                        <span className="skill-row-desc">{lang === "zh" ? s.desc.zh : s.desc.en}</span>
                        <span className="skill-row-toggle" aria-hidden="true">
                          <span className="skill-row-knob" />
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="field">
                <span>{t("cmSkills")}</span>
                {value.codeSkills.length > 0 && (
                  <div className="preset-chips">
                    {value.codeSkills.map((s) => (
                      <span key={s.name} className="preset-chip">
                        <button
                          type="button"
                          className="preset-apply"
                          title={s.prompt}
                          onClick={() => {
                            setSkillName(s.name);
                            setSkillPrompt(s.prompt);
                          }}
                        >
                          /{s.name}
                        </button>
                        <button type="button" className="preset-del" title={t("cancel")} onClick={() => deleteSkill(s.name)}><Icon name="x" size={11} strokeWidth={2.2} /></button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="preset-add">
                  <input
                    type="text"
                    placeholder={t("cmSkillNamePh")}
                    value={skillName}
                    onChange={(e) => setSkillName(e.target.value)}
                  />
                  <button type="button" onClick={saveSkill} disabled={!skillName.trim() || !skillPrompt.trim()}>
                    {t("presetSave")}
                  </button>
                </div>
                <textarea
                  rows={3}
                  placeholder={t("cmSkillPromptPh")}
                  value={skillPrompt}
                  onChange={(e) => setSkillPrompt(e.target.value)}
                />
              </div>
              <div className="settings-hint">{t("cmSkillsHint")}</div>

              <div className="field">
                <span>{t("cmMcp")}</span>
                {mcpServers.length > 0 && (
                  <div className="skill-rows">
                    {mcpServers.map((sv) => (
                      <div key={sv.name} className={`skill-row mcp-row ${sv.enabled ? "on" : ""}`}>
                        <button
                          type="button"
                          className="skill-row-toggle"
                          title={sv.enabled ? "on" : "off"}
                          onClick={() =>
                            applyMcp(mcpServers.map((x) => (x.name === sv.name ? { ...x, enabled: !x.enabled } : x)))
                          }
                        >
                          <span className="skill-row-knob" />
                        </button>
                        <span className="skill-row-name">{sv.name}</span>
                        <span className="skill-row-desc">
                          {sv.transport === "http" ? sv.url : [sv.command, ...(sv.args ?? [])].join(" ")}
                          {mcpStatus[sv.name] ? ` · ${mcpStatus[sv.name]}` : ""}
                        </span>
                        <label className="mcp-trust" title={t("cmMcpHint")}>
                          <input
                            type="checkbox"
                            checked={sv.trusted === true}
                            onChange={(e) =>
                              applyMcp(mcpServers.map((x) => (x.name === sv.name ? { ...x, trusted: e.target.checked } : x)))
                            }
                          />
                          {t("cmMcpTrusted")}
                        </label>
                        <button type="button" className="preset-del" title={t("cancel")} onClick={() => applyMcp(mcpServers.filter((x) => x.name !== sv.name))}>
                          <Icon name="x" size={11} strokeWidth={2.2} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="preset-add">
                  <input type="text" placeholder={t("cmMcpNamePh")} value={mcpName} onChange={(e) => setMcpName(e.target.value)} style={{ maxWidth: 120 }} />
                  <input type="text" placeholder={t("cmMcpCmdPh")} value={mcpCmd} onChange={(e) => setMcpCmd(e.target.value)} />
                  <button type="button" onClick={addMcp} disabled={!mcpName.trim() || !mcpCmd.trim()}>
                    {t("presetSave")}
                  </button>
                </div>
                {/^https?:\/\//.test(mcpCmd.trim()) && (
                  <input type="password" placeholder={t("cmMcpTokenPh")} value={mcpToken} onChange={(e) => setMcpToken(e.target.value)} />
                )}
              </div>
              <div className="settings-hint">{t("cmMcpHint")}</div>

              <div className="field">
                <span>{t("cmMcpStore")}</span>
                <div className="skill-rows">
                  {catalog.entries.map((en) => {
                    const installed = mcpServers.some((x) => x.name === en.id);
                    const needsInput =
                      (en as { needsToken?: boolean }).needsToken === true ||
                      ((en as { placeholders?: unknown[] }).placeholders?.length ?? 0) > 0;
                    const open = storeOpen === en.id;
                    return (
                      <div key={en.id} className="skill-row mcp-row on">
                        <span className="skill-row-name">{lang === "zh" ? en.title.zh : en.title.en}</span>
                        <span className="skill-row-desc" title={lang === "zh" ? en.permNote.zh : en.permNote.en}>
                          {lang === "zh" ? en.desc.zh : en.desc.en}
                        </span>
                        {en.probe != null && <span className="mcp-cert">✓ {t("cmMcpCertified")}</span>}
                        <button
                          type="button"
                          className="preset-apply"
                          disabled={installed}
                          onClick={() => {
                            if (installed) return;
                            if (needsInput && !open) {
                              setStoreOpen(en.id);
                              setStoreInput({});
                              return;
                            }
                            addFromStore(en);
                          }}
                        >
                          {installed ? t("cmMcpAdded") : t("cmMcpAddBtn")}
                        </button>
                        {open && !installed && (
                          <div className="mcp-store-inputs">
                            {((en as { placeholders?: { key: string; label: { zh: string; en: string } }[] }).placeholders ?? []).map((ph) => (
                              <input
                                key={ph.key}
                                type="text"
                                placeholder={lang === "zh" ? ph.label.zh : ph.label.en}
                                value={storeInput[ph.key] ?? ""}
                                onChange={(ev) => setStoreInput((v) => ({ ...v, [ph.key]: ev.target.value }))}
                              />
                            ))}
                            {(en as { needsToken?: boolean }).needsToken && (
                              <input
                                type="password"
                                placeholder={t("cmMcpTokenPh")}
                                value={storeInput.token ?? ""}
                                onChange={(ev) => setStoreInput((v) => ({ ...v, token: ev.target.value }))}
                              />
                            )}
                            <button type="button" className="preset-apply" onClick={() => addFromStore(en)}>
                              {t("cmMcpAddBtn")}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="settings-hint">{t("cmMcpStoreHint")}</div>

              <div className="field">
                <span>{t("cmSkillFiles")}</span>
                <div className="skill-rows">
                  {officialSkills().map((sk) => {
                    const on = !skillOff.includes(sk.name);
                    return (
                      <button
                        key={sk.name}
                        type="button"
                        className={`skill-row ${on ? "on" : ""}`}
                        onClick={() => toggleSkill(sk.name)}
                      >
                        <span className="skill-row-name">{sk.name}</span>
                        <span className="skill-row-desc">{sk.description}</span>
                        <span className="skill-row-toggle" aria-hidden="true">
                          <span className="skill-row-knob" />
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="settings-hint">{t("cmSkillFilesHint")}</div>

              <SetRow label={t("canvasFolder")} hint={t("canvasFolderHint")}>
                <button type="button" className="data-btn" onClick={() => void openCanvasDir().catch(console.error)}>
                  {t("openCanvasDir")}
                </button>
              </SetRow>
            </>
          )}

          {cat === "voice" && lang === "en" && (
            <>
              <label className="field">
                <span>{t("ttsEngine")}</span>
                <div className="lang-switch">
                  <button
                    type="button"
                    className={value.ttsEngine === "kokoro" ? "active" : ""}
                    onClick={() => set("ttsEngine", "kokoro")}
                  >
                    {t("ttsEngineKokoro")}
                  </button>
                  <button
                    type="button"
                    className={value.ttsEngine === "edge" ? "active" : ""}
                    onClick={() => set("ttsEngine", "edge")}
                  >
                    {t("ttsEngineEdge")}
                  </button>
                </div>
              </label>
              {value.ttsEngine === "edge" && (
                <div className="settings-warn" role="alert">
                  {t("ttsEdgePrivacyWarn")}
                </div>
              )}
              {value.ttsEngine === "kokoro" ? (
                <label className="field">
                  <span>{t("voice")}</span>
                  <Select
                    className="field-select"
                    value={value.voiceSid}
                    ariaLabel={t("voice")}
                    onChange={(v) => set("voiceSid", v)}
                    options={VOICES.map((name, i) => ({ value: i, label: name }))}
                  />
                </label>
              ) : (
                <label className="field">
                  <span>{t("edgeVoices")}</span>
                  {edgeVoicesLoading && !edgeVoices.length ? (
                    <div className="settings-hint">{t("edgeVoiceLoading")}</div>
                  ) : (
                    <Select
                      className="field-select"
                      value={value.edgeVoice}
                      ariaLabel={t("edgeVoices")}
                      onChange={(v) => set("edgeVoice", v)}
                      options={(edgeVoices.length
                        ? edgeVoices
                        : [{ shortName: value.edgeVoice || DEFAULT_EDGE_VOICE, friendlyName: value.edgeVoice || DEFAULT_EDGE_VOICE, locale: "", gender: "" }]
                      ).map((v) => ({
                        value: v.shortName,
                        label: v.gender ? `${v.friendlyName} · ${v.gender}` : v.friendlyName,
                        group: v.locale || undefined,
                      }))}
                    />
                  )}
                  {edgeVoicesErr && <div className="settings-hint">{t("edgeVoiceFailed")}</div>}
                </label>
              )}
              <label className="field">
                <span>
                  {t("voiceSpeed")} <b>{value.voiceSpeed.toFixed(2)}×</b>
                </span>
                <input type="range" min={0.5} max={2} step={0.05} value={value.voiceSpeed} onChange={(e) => set("voiceSpeed", Number(e.target.value))} />
              </label>
              {value.ttsEngine === "edge" && (
                <>
                  <label className="field">
                    <span>
                      <em className="has-tip" data-tip={t("tipPitch")}>{t("voicePitch")}</em>{" "}
                      <b>{value.voicePitch >= 0 ? "+" : ""}{value.voicePitch.toFixed(0)} Hz</b>
                    </span>
                    <input
                      type="range"
                      min={-50}
                      max={50}
                      step={1}
                      value={value.voicePitch}
                      onChange={(e) => set("voicePitch", Number(e.target.value))}
                    />
                  </label>
                  <label className="field">
                    <span>
                      <em className="has-tip" data-tip={t("tipVolume")}>{t("voiceVolume")}</em>{" "}
                      <b>{value.voiceVolume >= 0 ? "+" : ""}{value.voiceVolume.toFixed(0)}%</b>
                    </span>
                    <input
                      type="range"
                      min={-50}
                      max={50}
                      step={1}
                      value={value.voiceVolume}
                      onChange={(e) => set("voiceVolume", Number(e.target.value))}
                    />
                  </label>
                </>
              )}
              <SetRow label={t("voicePreview")} hint={t("voicePreviewHint")}>
                <button type="button" className="data-btn" disabled={voiceTesting} onClick={testVoice}>
                  {voiceTesting ? "…" : t("voicePreviewBtn")}
                </button>
              </SetRow>
              <div className="settings-hint">{value.ttsEngine === "edge" ? t("ttsEngineHint") : t("voiceEngineHint")}</div>
            </>
          )}

          {cat === "data" && (
            <>
              <div className="stats-grid">
                <div className="stat-tile">
                  <span className="stat-num">{stats ? stats.convs : "–"}</span>
                  <span className="stat-label">{t("statConvs")}</span>
                </div>
                <div className="stat-tile">
                  <span className="stat-num">{stats ? stats.msgs : "–"}</span>
                  <span className="stat-label">{t("statMsgs")}</span>
                </div>
                <div className="stat-tile">
                  <span className="stat-num">{stats ? stats.code : "–"}</span>
                  <span className="stat-label">{t("statCodeSessions")}</span>
                </div>
                <div className="stat-tile">
                  <span className="stat-num">
                    {stats ? stats.models : "–"}
                    {stats && stats.modelBytes > 0 && <em className="stat-sub">{fmtBytes(stats.modelBytes)}</em>}
                  </span>
                  <span className="stat-label">{t("statModels")}</span>
                </div>
                <div className="stat-tile">
                  <span className="stat-num">{stats ? stats.kbDocs : "–"}</span>
                  <span className="stat-label">{t("statKbDocs")}</span>
                </div>
                <div className="stat-tile">
                  <span className="stat-num">{stats ? stats.kbChunks : "–"}</span>
                  <span className="stat-label">{t("statKbChunks")}</span>
                </div>
              </div>
              <div className="settings-hint stats-db-line">
                {t("statDbSize")}: {stats ? fmtBytes(stats.db) : "–"}
              </div>
              <SetRow label={t("dataFolder")} hint={t("dataHint")}>
                <button type="button" className="data-btn" onClick={() => void openDataDir().catch(console.error)}>
                  {t("openDataDir")}
                </button>
              </SetRow>
              <SetRow label={t("clearAllChats")} hint={t("clearChatsHint")}>
                <button
                  type="button"
                  className="data-btn danger"
                  onClick={async () => {
                    if (
                      !(await confirm({
                        message: t("confirmClearChats"),
                        title: t("clearAllChats"),
                        confirmLabel: t("clearAllChats"),
                        danger: true,
                      }))
                    ) {
                      return;
                    }
                    clearAllConversations()
                      .then(() => {
                        onDataCleared?.();
                        refreshStats();
                      })
                      .catch(console.error);
                  }}
                >
                  {t("clearAllChats")}
                </button>
              </SetRow>
              <SetRow label={t("clearKb")} hint={t("clearKbHint")}>
                <button
                  type="button"
                  className="data-btn danger"
                  onClick={async () => {
                    if (
                      !(await confirm({
                        message: t("clearKbConfirm"),
                        title: t("clearKb"),
                        confirmLabel: t("clearKb"),
                        danger: true,
                      }))
                    ) {
                      return;
                    }
                    ragClearAll().then(refreshStats).catch(console.error);
                  }}
                >
                  {t("clearKb")}
                </button>
              </SetRow>
            </>
          )}

          {cat === "about" && (
            <div className="about-card">
              <img className="about-logo" src={logoUrl} alt="DARIA" draggable={false} />
              <div className="about-name">DARIA</div>
              <div className="about-version">v{__APP_VERSION__}</div>
              <div className="about-tagline">{t("aboutTagline")}</div>
              <div className="about-links">
                <button type="button" onClick={() => void openExternal("https://github.com/adamlwalker/DARIA").catch(console.error)}>
                  GitHub
                </button>
              </div>
            </div>
          )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
