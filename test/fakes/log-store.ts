import type { LogReadResult, LogStore, LogWriter, StreamName, TaskId } from "../../src/contract.js";

interface Entry {
  stream: StreamName;
  bytes: Uint8Array;
}

// In-memory LogStore. Writes are kept per task in arrival order.
export class MemLogStore implements LogStore {
  private logs = new Map<TaskId, Entry[]>();
  private openError: string | null = null;
  private writeError: string | null = null;

  // The next open() returns { error: msg } instead of a writer. One shot.
  failNextOpen(msg: string): void {
    this.openError = msg;
  }

  // Writers report `degraded` = msg and drop later chunks. Applies to existing and future writers.
  failWrites(msg: string): void {
    this.writeError = msg;
  }

  // All bytes written for the task, decoded as UTF-8, in arrival order across streams.
  contents(id: TaskId): string {
    const dec = new TextDecoder();
    return (this.logs.get(id) ?? []).map((e) => dec.decode(e.bytes)).join("");
  }

  open(id: TaskId): LogWriter | { error: string } {
    if (this.openError !== null) {
      const error = this.openError;
      this.openError = null;
      return { error };
    }
    const entries = this.logs.get(id) ?? [];
    this.logs.set(id, entries);
    const self = this;
    return {
      path: `mem://${id}`,
      get degraded() {
        return self.writeError;
      },
      write(chunk: Uint8Array, stream: StreamName) {
        if (self.writeError !== null) return;
        entries.push({ stream, bytes: chunk.slice() });
      },
      async close() {},
    };
  }

  async read(id: TaskId, stream: StreamName, offset: number, maxBytes: number): Promise<LogReadResult | { error: string }> {
    const all = (this.logs.get(id) ?? [])
      .filter((e) => stream === "combined" || e.stream === stream || e.stream === "combined")
      .flatMap((e) => Array.from(e.bytes));
    const totalBytes = all.length;
    const start = Math.min(Math.max(0, offset), totalBytes);
    const end = Math.min(totalBytes, start + Math.max(0, maxBytes));
    return { bytes: Uint8Array.from(all.slice(start, end)), nextOffset: end, totalBytes };
  }

  async gc(): Promise<{ removed: string[] }> {
    return { removed: [] };
  }
}
