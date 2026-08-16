/** use_skill on a knowledge-only official skill returns the procedure and
 *  writes nothing. A user skill with the same name keeps its own body. */
import { afterEach, describe, expect, it } from "vitest";

const g = globalThis as Record<string, unknown>;
g.window = globalThis;
g.localStorage ??= {
  getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
};
g.navigator ??= { userAgent: "chaty-test" };

const { mockIPC, clearMocks } = await import("@tauri-apps/api/mocks");
const { runAgentTurn } = await import("./agentLoop");
const { officialSkills, parseSkill } = await import("./skillFiles");

type Ev = { type: string; [k: string]: unknown };
type Chan = { onmessage?: (ev: Ev) => void };

const call = (name: string, args: Record<string, unknown>) =>
  `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;

async function runTurn(
  rounds: string[],
  skills: ReturnType<typeof officialSkills>,
  files: Map<string, string>,
): Promise<{ writes: string[]; results: string[] }> {
  const script = [...rounds];
  const writes: string[] = [];
  const results: string[] = [];
  mockIPC(async (cmd, args) => {
    if (cmd === "generate") {
      const ch = (args as { onEvent: Chan }).onEvent;
      ch.onmessage?.({ type: "token", text: script.shift() ?? "Done." });
      ch.onmessage?.({ type: "done", stats: { completionTokens: 8, tokensPerSecond: 50, promptTokens: 100 } });
      return null;
    }
    if (cmd === "agent_write_file") {
      const a = args as { path?: string; content?: string };
      writes.push(String(a.path));
      files.set(String(a.path), String(a.content ?? ""));
      return "written";
    }
    if (cmd === "agent_read_file") {
      const p = String((args as { path?: string }).path);
      if (files.has(p)) return files.get(p);
      throw new Error("no such file");
    }
    if (cmd === "agent_bash") return { stdout: "ok", stderr: "", code: 0, timedOut: false, bgId: null };
    if (cmd === "agent_list_files") return [];
    return null;
  });
  await runAgentTurn(
    "help me ship this",
    [],
    "/tmp/ws",
    "en",
    {
      thinkMode: "off", maxSteps: 8,
      skills,
      signal: { cancelled: false },
      approve: async () => true,
      approveDir: async () => false,
      approveSudo: async () => ({ ok: false }),
    } as never,
    {
      onThinking: () => {}, onAssistantText: () => {}, onStep: (s: { result?: string }) => { if (s.result) results.push(s.result); },
      onFinal: () => {},
      onError: (m: string) => { throw new Error(`loop errored: ${m}`); },
      onTrace: () => {},
    },
  );
  return { writes, results };
}

describe("knowledge-only official skill use", () => {
  afterEach(() => clearMocks());

  it("use_skill on a bundled .md skill writes no support files", async () => {
    const files = new Map<string, string>();
    const skills = officialSkills();
    const name = skills.find((s) => s.name === "mac-app")?.name
      ?? skills.find((s) => s.name === "verify-before-push")?.name
      ?? skills[0]?.name;
    expect(name).toBeTruthy();
    const first = await runTurn([call("use_skill", { name }), "Done."], skills, files);
    expect(first.writes.filter((p) => p.startsWith(".chaty/skills/"))).toHaveLength(0);
    expect(first.results.some((r) => r.length > 20)).toBe(true);
  });

  it("a shadowing user skill keeps its own files — no official materialization", async () => {
    const files = new Map<string, string>();
    const mine = parseSkill(
      "---\nname: verify-before-push\ndescription: my own\n---\nMy own steps, my own scripts.",
      ".chaty/skills/verify-before-push.md",
      "project",
    )!;
    const merged = [mine, ...officialSkills().filter((s) => s.name !== "verify-before-push")];
    const run = await runTurn([call("use_skill", { name: "verify-before-push" }), "Done."], merged, files);
    expect(run.writes.filter((p) => p.startsWith(".chaty/skills/"))).toHaveLength(0);
    expect(run.results.find((r) => r.includes("My own steps"))).toBeTruthy();
  });
});
