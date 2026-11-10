// Config loading glue (DESIGN section 6): reads the files and flags, applies the trust rule, delegates merging and validation to core parseConfig.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BgConfig, NotifyLevel } from "../contract.js";
import { parseConfig } from "../core/config.js";
import { bgCommandText, failure } from "../core/format.js";
import type { Services } from "./runtime.js";

const FILE_NAME = "pi-bg.json";

export function registerFlags(pi: ExtensionAPI): void {
  pi.registerFlag("bg-timeout", { type: "string", description: "pi-bg: seconds before a running bash command moves to the background (0 = never)" });
  pi.registerFlag("bg-notify", { type: "string", description: "pi-bg: notification level for background tasks: off, error or done" });
  pi.registerFlag("no-bg", { type: "boolean", description: "pi-bg: disable background tasks (bash runs unchanged)" });
}

// Missing file: undefined, no warning. Unreadable or invalid JSON: undefined plus a warning (never fatal).
function readJson(path: string, label: string, warnings: string[]): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(failure("config_unreadable", { file: path, label, error: (e as Error).message }));
    }
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    warnings.push(failure("config_bad_json", { file: path, error: (e as Error).message }));
    return undefined;
  }
}

/**
 * Warnings from parseConfig already name key, cause and action, so they pass through unchanged;
 * read and JSON errors use failure("bad_config"). The project file is read only when `ctx.isProjectTrusted` is a function returning true (S8: the SDK treats an absent flag as trusted, so trust is explicit).
 */
export function loadConfig(pi: ExtensionAPI, ctx: ExtensionContext): { config: BgConfig; warnings: string[] } {
  const warnings: string[] = [];
  const global = readJson(join(getAgentDir(), FILE_NAME), "global", warnings);
  const trusted = typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted();
  const project = trusted ? readJson(join(ctx.cwd, ".pi", FILE_NAME), "project", warnings) : undefined;
  const flags: Partial<Record<string, string | boolean>> = {};
  for (const name of ["bg-timeout", "bg-notify", "no-bg"]) {
    const v = pi.getFlag(name);
    if (v !== undefined) flags[name] = v;
  }
  const parsed = parseConfig({ global, project, flags });
  return { config: parsed.config, warnings: [...warnings, ...parsed.warnings] };
}

const LEVELS: readonly NotifyLevel[] = ["off", "error", "done"];

/** `/bg timeout <s>` and `/bg notify <level>`: validates, updates s.overrides, returns the confirmation or the error text. */
export function setSessionOverride(s: Services, key: "timeout" | "notify", value: string): string {
  const reject = () => failure("bad_override", { key, value });
  const v = value.trim();
  if (key === "timeout") {
    const n = v === "" ? Number.NaN : Number(v);
    if (!Number.isFinite(n) || n < 0) return reject();
    (s.overrides).bgTimeoutSeconds = n;
    return bgCommandText("timeout", { seconds: n });
  }
  if (!LEVELS.includes(v as NotifyLevel)) return reject();
  s.overrides.notifyLevel = v as NotifyLevel;
  return bgCommandText("notify", { level: v });
}
