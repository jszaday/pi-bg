// Task id allocation (DESIGN section 5): "bg<N>", monotonic per session, never reused.
import type { TaskId } from "../contract.js";

function cleanSeed(n: number): number {
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/** `seedAbove`: the highest N already used by an earlier run; the first id is bg<seedAbove+1>. */
export function createIdAllocator(seedAbove = 0): { next(): TaskId; readonly seed: number } {
  const seed = cleanSeed(seedAbove);
  let n = seed;
  return {
    next: () => `bg${++n}`,
    seed,
  };
}

const ID_RE = /(?<![A-Za-z0-9_])bg(\d+)(?![A-Za-z0-9_])/g;

/** Highest N found in "bg<N>" ids across the given texts; 0 when none. */
export function seedFromBranch(texts: string[]): number {
  let max = 0;
  for (const text of texts) {
    for (const m of text.matchAll(ID_RE)) {
      const n = Number(m[1]);
      if (Number.isSafeInteger(n) && n > max) max = n;
    }
  }
  return max;
}

/** Numeric part of "bg<N>", or undefined when the text is not a task id. */
export function idNumber(id: TaskId): number | undefined {
  const m = /^bg(\d+)$/.exec(id);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : undefined;
}
