// Config parsing and merge (DESIGN section 6). Pure: file reading and the trust
// decision belong to the glue (an untrusted project file is simply not passed in).
// Precedence, lowest to highest: defaults, global file, project file, flags.
// Per-call and session overrides are applied later by timeout-policy.

import type { BgConfig } from "../contract.js";

export const DEFAULT_CONFIG: BgConfig = {
  enabled: true,
  bgTimeoutSeconds: 30,
  notify: { default: "done", delivery: "steer", wake: true, batchMs: 500 },
  key: "ctrl+b",
  hintAfterMs: 2000,
  wait: { defaultTimeoutSeconds: 120, maxTimeoutSeconds: 3600 },
  output: { tailLines: 50, maxBytes: 16_000, ringBytes: 65_536, maxLogBytes: 268_435_456, logRetentionDays: 7, logDir: null },
  maxRunningTasks: 16,
  kill: { termGraceMs: 3000 },
};

type Rule =
  | { kind: "bool" }
  | { kind: "num"; min: number; int?: boolean; minExclusive?: boolean }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "string" }
  | { kind: "nullableString" };

// One row per leaf key; the dotted path is both the file path and the warning text.
const RULES: Record<string, Rule> = {
  enabled: { kind: "bool" },
  bgTimeoutSeconds: { kind: "num", min: 0 },
  "notify.default": { kind: "enum", values: ["off", "error", "done"] },
  "notify.delivery": { kind: "enum", values: ["steer", "followUp", "nextTurn"] },
  "notify.wake": { kind: "bool" },
  "notify.batchMs": { kind: "num", min: 0 },
  key: { kind: "string" },
  hintAfterMs: { kind: "num", min: 0 },
  "wait.defaultTimeoutSeconds": { kind: "num", min: 0, minExclusive: true },
  "wait.maxTimeoutSeconds": { kind: "num", min: 0, minExclusive: true },
  "output.tailLines": { kind: "num", min: 1, int: true },
  "output.maxBytes": { kind: "num", min: 1, int: true },
  "output.ringBytes": { kind: "num", min: 1, int: true },
  "output.maxLogBytes": { kind: "num", min: 1, int: true },
  "output.logRetentionDays": { kind: "num", min: 0 },
  "output.logDir": { kind: "nullableString" },
  maxRunningTasks: { kind: "num", min: 1, int: true },
  "kill.termGraceMs": { kind: "num", min: 0 },
};

const SECTIONS = new Set(["notify", "wait", "output", "kill"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function describe(v: unknown): string {
  return typeof v === "string" ? JSON.stringify(v) : String(JSON.stringify(v) ?? v);
}

function expected(rule: Rule): string {
  switch (rule.kind) {
    case "bool": return "true or false";
    case "enum": return `one of ${rule.values.join(", ")}`;
    case "string": return "a non-empty string";
    case "nullableString": return "a non-empty string or null";
    case "num": {
      const base = rule.int ? "a whole number" : "a number";
      return `${base} ${rule.minExclusive ? ">" : ">="} ${rule.min}`;
    }
  }
}

// Returns the validated value, or undefined (with no warning) when invalid.
function check(rule: Rule, v: unknown): { ok: true; value: unknown } | { ok: false } {
  switch (rule.kind) {
    case "bool": return typeof v === "boolean" ? { ok: true, value: v } : { ok: false };
    case "enum": return typeof v === "string" && rule.values.includes(v) ? { ok: true, value: v } : { ok: false };
    case "string": return typeof v === "string" && v.length > 0 ? { ok: true, value: v } : { ok: false };
    case "nullableString":
      return v === null || (typeof v === "string" && v.length > 0) ? { ok: true, value: v } : { ok: false };
    case "num": {
      if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false };
      if (rule.int && !Number.isInteger(v)) return { ok: false };
      if (rule.minExclusive ? v <= rule.min : v < rule.min) return { ok: false };
      return { ok: true, value: v };
    }
  }
}

function setPath(cfg: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let o = cfg;
  for (const p of parts.slice(0, -1)) o = o[p] as Record<string, unknown>;
  o[parts[parts.length - 1]] = value;
}

function applyFile(cfg: BgConfig, raw: unknown, label: string, warnings: string[]): void {
  if (raw === undefined || raw === null) return;
  if (!isObject(raw)) {
    warnings.push(`pi-bg config (${label}) must be a JSON object, got ${Array.isArray(raw) ? "an array" : typeof raw}; ignoring the whole ${label} config. Fix the file so its top level is { ... }.`);
    return;
  }
  const bad = (path: string, v: unknown, rule: Rule) =>
    warnings.push(`pi-bg config (${label}): "${path}" is ${describe(v)} but must be ${expected(rule)}; keeping the previous value. Fix the key in the ${label} config.`);
  const unknown = (path: string) =>
    warnings.push(`pi-bg config (${label}): unknown key "${path}" ignored. Remove it or check the spelling against the documented keys.`);

  for (const [k, v] of Object.entries(raw)) {
    if (SECTIONS.has(k)) {
      if (!isObject(v)) {
        warnings.push(`pi-bg config (${label}): "${k}" must be an object of settings, got ${describe(v)}; keeping the previous values. Write "${k}": { ... }.`);
        continue;
      }
      for (const [sk, sv] of Object.entries(v)) {
        const path = `${k}.${sk}`;
        const rule = RULES[path];
        if (!rule) { unknown(path); continue; }
        const r = check(rule, sv);
        if (r.ok) setPath(cfg as unknown as Record<string, unknown>, path, r.value);
        else bad(path, sv, rule);
      }
      continue;
    }
    const rule = RULES[k];
    if (!rule) { unknown(k); continue; }
    const r = check(rule, v);
    if (r.ok) setPath(cfg as unknown as Record<string, unknown>, k, r.value);
    else bad(k, v, rule);
  }
}

function applyFlags(cfg: BgConfig, flags: Partial<Record<string, string | boolean>> | undefined, warnings: string[]): void {
  if (!flags) return;
  const bad = (flag: string, v: unknown, want: string) =>
    warnings.push(`pi-bg flag --${flag} is ${describe(v)} but must be ${want}; ignoring the flag. Pass a valid value.`);
  for (const [flag, v] of Object.entries(flags)) {
    if (v === undefined) continue;
    if (flag === "bg-timeout") {
      const n = typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
      if (Number.isFinite(n) && n >= 0) cfg.bgTimeoutSeconds = n;
      else bad(flag, v, "a number of seconds >= 0 (0 disables automatic handoff)");
    } else if (flag === "bg-notify") {
      if (v === "off" || v === "error" || v === "done") cfg.notify.default = v;
      else bad(flag, v, "one of off, error, done");
    } else if (flag === "no-bg") {
      if (typeof v === "boolean") { if (v) cfg.enabled = false; }
      else bad(flag, v, "a bare switch with no value");
    } else {
      warnings.push(`pi-bg: unknown flag --${flag} ignored. Use --bg-timeout, --bg-notify or --no-bg.`);
    }
  }
}

export function parseConfig(sources: {
  global?: unknown;
  project?: unknown;
  flags?: Partial<Record<string, string | boolean>>;
}): { config: BgConfig; warnings: string[] } {
  const config = structuredClone(DEFAULT_CONFIG);
  const warnings: string[] = [];
  applyFile(config, sources.global, "global", warnings);
  applyFile(config, sources.project, "project", warnings);
  applyFlags(config, sources.flags, warnings);
  // Cross-field: a default wait longer than the maximum is clamped to the maximum.
  if (config.wait.defaultTimeoutSeconds > config.wait.maxTimeoutSeconds) {
    warnings.push(`pi-bg config: wait.defaultTimeoutSeconds (${config.wait.defaultTimeoutSeconds}) exceeds wait.maxTimeoutSeconds (${config.wait.maxTimeoutSeconds}); using ${config.wait.maxTimeoutSeconds}. Lower the default or raise the maximum.`);
    config.wait.defaultTimeoutSeconds = config.wait.maxTimeoutSeconds;
  }
  return { config, warnings };
}
