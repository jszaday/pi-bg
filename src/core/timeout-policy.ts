// Timeout policy (DESIGN section 6 precedence, section 11 timers). Pure.

import type { NotifyLevel, TaskSpec } from "../contract.js";

function validSeconds(n: number | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

// Seconds in, ms out. Precedence: call > session > config. An invalid value
// (NaN, negative, infinite) is skipped so the next layer applies; 0 means
// "never auto-handoff" and is returned as null.
export function effectiveBgTimeoutMs(p: {
  callSeconds?: number;
  sessionSeconds?: number;
  configSeconds: number;
}): number | null {
  const s = [p.callSeconds, p.sessionSeconds].find(validSeconds) ?? (validSeconds(p.configSeconds) ? p.configSeconds : 0);
  const ms = Math.ceil(s * 1000);
  return ms === 0 ? null : ms;
}

export function effectiveNotifyLevel(p: { call?: NotifyLevel; session?: NotifyLevel; config: NotifyLevel }): NotifyLevel {
  return p.call ?? p.session ?? p.config;
}

function positiveMs(n: number | null | undefined): number | null {
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return null;
  return Math.ceil(n);
}

// handoffInMs is null when handoff can never apply: no bg timeout, a task that
// starts in the background, or bgTimeoutMs >= hardTimeoutMs (the kill comes first
// or at the same time). Times are rounded up to whole ms so a timer never fires early.
export function planTimers(spec: TaskSpec): { handoffInMs: number | null; killInMs: number | null } {
  const killInMs = positiveMs(spec.hardTimeoutMs);
  let handoffInMs = spec.startInBackground ? null : positiveMs(spec.bgTimeoutMs);
  if (handoffInMs !== null && killInMs !== null && handoffInMs >= killInMs) handoffInMs = null;
  return { handoffInMs, killInMs };
}

/** Milliseconds until the automatic handoff of a task started at `startedAt`, or null when none is planned. Never negative. */
export function handoffRemainingMs(spec: TaskSpec, startedAt: number, now: number): number | null {
  const { handoffInMs } = planTimers(spec);
  return handoffInMs === null ? null : Math.max(0, startedAt + handoffInMs - now);
}
