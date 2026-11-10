// Gated live-test harness: the REAL pi-bg extension (src/index.ts) loaded as an inline factory into a real Pi AgentSession with a scripted faux provider. No network, no real model.
// Faux-provider recipe (the `registerFauxProvider` from pi-ai `/compat` is not visible to ModelRuntime): `fauxProvider()` from `@earendil-works/pi-ai`, `ModelRuntime.create({agentDir})`, `registerNativeProvider(faux.provider)`, `setRuntimeApiKey(provider, "x")`, then pass `modelRuntime` and `model: faux.getModel()` to `createAgentSession` and call `session.bindExtensions({})`. A provider registered from an inline extension is only usable after `bindExtensions`. `tool_execution_start` fires before `execute()` runs, so wait for it and then for `execute` to begin. Calling the native bash `execute` directly needs a complete `ctx` (it reads `ctx.sessionManager.getSessionId()`).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Loaded by path (as Pi loads an installed package): real installs load by path, so the tests do the same (an inline factory reports `<inline:N>`, which the ownership check also treats as ours).
const EXTENSION_PATH = fileURLToPath(new URL("../../../src/index.ts", import.meta.url));

export const GATED = process.env.PI_BG_GATED === "1";

function resolvable(spec: string): boolean {
  try {
    return typeof import.meta.resolve(spec) === "string";
  } catch {
    return false;
  }
}
export const HAVE_SDK = resolvable("@earendil-works/pi-coding-agent") && resolvable("@earendil-works/pi-ai");

function findTmux(): string | undefined {
  for (const c of [process.env.TMUX_BIN ?? "tmux"]) {
    try {
      execFileSync(c, ["-V"], { stdio: "ignore" });
      return c;
    } catch {
      // try next candidate
    }
  }
  return undefined;
}
export const TMUX = findTmux();

/** Prints the reason once per file and returns true when the test must be skipped. */
export function skipReason(name: string, needs: { tmux?: boolean } = {}): string | undefined {
  const reason = !GATED ? "PI_BG_GATED is not 1" : !HAVE_SDK ? "Pi SDK (@earendil-works/pi-coding-agent, pi-ai) not installed" : needs.tmux && !TMUX ? "tmux not found" : undefined;
  if (reason) console.warn(`[gated:${name}] SKIPPED: ${reason}`);
  return reason;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(10);
  }
}
export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export interface ToolResult { id: string; name: string; isError: boolean; text: string; at: number }

export async function createLive(config: Record<string, unknown> = {}) {
  const sdk = await import("@earendil-works/pi-coding-agent");
  const ai = await import("@earendil-works/pi-ai");
  const root = mkdtempSync(join(tmpdir(), "pi-bg-gated-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  mkdirSync(agentDir);
  mkdirSync(cwd);
  const logDir = join(root, "logs");
  writeFileSync(join(agentDir, "pi-bg.json"), JSON.stringify({ output: { logDir }, ...config }));
  const prevEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const faux = ai.fauxProvider({});
  const settingsManager = sdk.SettingsManager.inMemory();
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd, agentDir, settingsManager, additionalExtensionPaths: [EXTENSION_PATH], noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const modelRuntime = await sdk.ModelRuntime.create({ agentDir } as never);
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey(faux.getModel().provider, "fake-key");
  const { session } = await sdk.createAgentSession({
    cwd, agentDir, modelRuntime, model: faux.getModel(), settingsManager, resourceLoader,
    sessionManager: sdk.SessionManager.inMemory(cwd),
  });
  await session.bindExtensions({});

  const events: any[] = [];
  session.subscribe((e: any) => events.push({ ...e, _at: Date.now() }));
  const toolResults = (): ToolResult[] =>
    events.filter((e) => e.type === "tool_execution_end").map((e) => ({ id: e.toolCallId, name: e.toolName, isError: e.isError, text: e.result?.content?.[0]?.text ?? "", at: e._at }));

  const call = (name: string, args: Record<string, unknown>, id: string) => ai.fauxToolCall(name, args as never, { id });
  const toolTurn = (...calls: ReturnType<typeof call>[]) => ai.fauxAssistantMessage(calls, { stopReason: "toolUse" });
  const text = (t: string) => ai.fauxAssistantMessage(t);

  const pids: number[] = [];
  return {
    session, faux, events, toolResults, call, toolTurn, text, agentDir, cwd, root, pids,
    async cleanup() {
      for (const pid of pids) {
        try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
      }
      try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" } as any); } catch { /* best effort */ }
      session.dispose();
      if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prevEnv;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
export type Live = Awaited<ReturnType<typeof createLive>>;

export const pidFrom = (text: string): number | undefined => {
  const m = /pid (\d+)/.exec(text);
  return m ? Number(m[1]) : undefined;
};
export const hasPath = (p: string) => existsSync(p);
