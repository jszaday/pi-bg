import type { Clock, TimerHandle } from "../../src/contract.js";

interface ArmedTimer {
  id: number;
  due: number;
  fn: () => void;
}

interface TimerRef {
  id: number;
}

// Virtual clock: time moves only through advance(). Timers fire in due order;
// ties fire in the order they were armed. A timer armed by a callback during
// advance() fires in the same advance() if its due time falls inside the window.
export class FakeClock implements Clock {
  private time = 0;
  private nextId = 1;
  private timers: ArmedTimer[] = [];

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const ref: TimerRef = { id: this.nextId++ };
    this.timers.push({ id: ref.id, due: this.time + Math.max(0, ms), fn });
    return ref;
  }

  clearTimeout(h: TimerHandle): void {
    const id = (h as TimerRef | undefined)?.id;
    this.timers = this.timers.filter((t) => t.id !== id);
  }

  // Number of timers armed and not yet fired or cleared.
  pending(): number {
    return this.timers.length;
  }

  advance(ms: number): void {
    if (!(ms >= 0)) throw new Error(`FakeClock.advance needs a non-negative number of ms, got ${ms}; pass a delta, not a timestamp`);
    const target = this.time + ms;
    for (;;) {
      const next = this.nextDue(target);
      if (!next) break;
      this.time = next.due;
      this.timers = this.timers.filter((t) => t !== next);
      next.fn();
    }
    this.time = target;
  }

  private nextDue(limit: number): ArmedTimer | undefined {
    let best: ArmedTimer | undefined;
    for (const t of this.timers) {
      if (t.due > limit) continue;
      if (!best || t.due < best.due || (t.due === best.due && t.id < best.id)) best = t;
    }
    return best;
  }
}
