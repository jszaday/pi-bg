import { delimiter, join } from "node:path";
import { getAgentDir, getShellConfig } from "@earendil-works/pi-coding-agent";

/**
 * Shell resolution is delegated to Pi's exported `getShellConfig` so the own-spawn runner picks exactly the shell the native tool would
 * (explicit `shellPath` -> /bin/bash -> bash on PATH -> sh). Pi's native bash tool ignores `shellPath` once custom operations are supplied,
 * hence the runner resolves it itself. A bad `shellPath` throws in Pi; here it becomes an `{error}` result.
 */
export function resolveShell(shellPath?: string): { shell: string; shellArgs: string[] } | { error: string } {
  try {
    const c = getShellConfig(shellPath);
    return { shell: c.shell, shellArgs: [...c.args] };
  } catch (e) {
    return { error: `${(e as Error).message}\nFix or remove shellPath in Pi settings.` };
  }
}

/** Equivalent of Pi's (unexported) `getShellEnv`: process.env with Pi's bin directory prepended to PATH when absent. */
export function piShellEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const pathKey = Object.keys(base).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const current = base[pathKey] ?? "";
  const binDir = join(getAgentDir(), "bin");
  const entries = current.split(delimiter).filter(Boolean);
  const path = entries.includes(binDir) ? current : [binDir, current].filter(Boolean).join(delimiter);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  env[pathKey] = path;
  return env;
}
