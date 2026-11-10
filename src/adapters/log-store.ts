import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogReadResult, LogStore, LogWriter, StreamName, TaskId } from "../contract.js";

/** Injectable low-level I/O (tests simulate write failures). */
export interface LogIo { writeSync(fd: number, buf: Uint8Array, offset: number, length: number): number; }

export function resolveBaseDir(logDir: string | null): string {
  if (logDir) return logDir;
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return join(tmpdir(), `pi-bg-${uid}`);
}

const ID_RE = /^[A-Za-z0-9_-]+$/;
const fileName = (id: string, s: StreamName) => (s === "combined" ? `${id}.log` : `${id}.${s}.log`);

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // existence probe only, no signal is delivered
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function createFsLogStore(opts: { baseDir: string; sessionId: string; maxLogBytes: number; io?: LogIo }): LogStore {
  const io: LogIo = opts.io ?? { writeSync: (fd, buf, off, len) => nodeFs.writeSync(fd, buf, off, len) };
  const sessionDir = join(opts.baseDir, opts.sessionId);
  let dirReady = false;

  function ensureDir(): string | undefined {
    if (dirReady) return undefined;
    try {
      for (const d of [opts.baseDir, sessionDir]) {
        nodeFs.mkdirSync(d, { recursive: true, mode: 0o700 });
      }
      nodeFs.chmodSync(sessionDir, 0o700);
      nodeFs.writeFileSync(join(sessionDir, "owner.pid"), String(process.pid), { mode: 0o600 });
      dirReady = true;
      return undefined;
    } catch (e) {
      return `Cannot create log directory ${sessionDir}: ${(e as Error).message}. Make it writable or set output.logDir to a writable directory.`;
    }
  }

  return {
    open(id: TaskId): LogWriter | { error: string } {
      if (!ID_RE.test(id)) return { error: `Invalid task id for a log file: ${id}. Use ids of the form bg<N>.` };
      const err = ensureDir();
      if (err) return { error: err };
      const fds = new Map<StreamName, number>();
      let degraded: string | null = null;
      let capped = false;
      let written = 0;
      const open = (s: StreamName): number | undefined => {
        let fd = fds.get(s);
        if (fd !== undefined) return fd;
        try {
          fd = nodeFs.openSync(join(sessionDir, fileName(id, s)), "a", 0o600);
          nodeFs.fchmodSync(fd, 0o600);
          fds.set(s, fd);
          return fd;
        } catch (e) {
          degraded = `Cannot open log file: ${(e as Error).message}. Output is kept in memory only; check disk space and permissions.`;
          return undefined;
        }
      };
      if (open("combined") === undefined) return { error: degraded! };
      const writeAll = (fd: number, buf: Uint8Array) => {
        let off = 0;
        let retried = false;
        while (off < buf.length) {
          try {
            off += io.writeSync(fd, buf, off, buf.length - off);
          } catch (e) {
            // Retry policy: one immediate retry for transient EAGAIN/EINTR; anything else degrades.
            const code = (e as NodeJS.ErrnoException).code;
            if (!retried && (code === "EAGAIN" || code === "EINTR")) { retried = true; continue; }
            throw e;
          }
        }
      };
      const writer: LogWriter = {
        path: join(sessionDir, fileName(id, "combined")),
        get degraded() { return degraded; },
        write(chunk, stream) {
          if (degraded || capped || chunk.length === 0) return;
          try {
            let data = chunk;
            if (written + data.length > opts.maxLogBytes) {
              data = data.subarray(0, Math.max(0, opts.maxLogBytes - written));
              capped = true;
            }
            const targets: StreamName[] = stream === "combined" ? ["combined"] : ["combined", stream];
            for (const t of targets) {
              const fd = open(t);
              if (fd === undefined) return;
              writeAll(fd, data);
            }
            written += data.length;
            if (capped) {
              const marker = Buffer.from(`\n[pi-bg: log size limit of ${opts.maxLogBytes} bytes reached; further output is not written to this file]\n`);
              for (const fd of fds.values()) writeAll(fd, marker);
            }
          } catch (e) {
            degraded = `Log write failed: ${(e as Error).message}. Output is kept in memory only; free disk space or fix permissions.`;
          }
        },
        async close() {
          for (const fd of fds.values()) {
            try { nodeFs.closeSync(fd); } catch { /* already closed */ }
          }
          fds.clear();
        },
      };
      return writer;
    },

    async read(id, stream, offset, maxBytes): Promise<LogReadResult | { error: string }> {
      if (!ID_RE.test(id)) return { error: `Invalid task id: ${id}.` };
      const p = join(sessionDir, fileName(id, stream));
      let fh: nodeFs.promises.FileHandle | undefined;
      try {
        fh = await nodeFs.promises.open(p, "r");
        const { size } = await fh.stat();
        const start = Math.min(Math.max(0, offset), size);
        const buf = Buffer.alloc(Math.max(0, Math.min(maxBytes, size - start)));
        const { bytesRead } = await fh.read(buf, 0, buf.length, start);
        return { bytes: buf.subarray(0, bytesRead), nextOffset: start + bytesRead, totalBytes: size };
      } catch (e) {
        return { error: `Cannot read ${stream} log for ${id}: ${(e as Error).message}. The task may not have produced a ${stream} log (only some runners split streams); try stream "combined".` };
      } finally {
        await fh?.close();
      }
    },

    async gc(olderThanMs) {
      const removed: string[] = [];
      let entries: string[];
      try {
        entries = nodeFs.readdirSync(opts.baseDir);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return { removed };
        throw new Error(`Cannot list log directory ${opts.baseDir}: ${(e as Error).message}`);
      }
      const cutoff = Date.now() - olderThanMs;
      for (const name of entries) {
        const dir = join(opts.baseDir, name);
        if (dir === sessionDir) continue;
        try {
          if (!nodeFs.statSync(dir).isDirectory()) continue;
          let newest = nodeFs.statSync(dir).mtimeMs;
          for (const f of nodeFs.readdirSync(dir)) newest = Math.max(newest, nodeFs.statSync(join(dir, f)).mtimeMs);
          if (newest >= cutoff) continue;
          // Only directories pi-bg created carry an owner.pid holding a pid (written by every version since v0.1.0); anything else in a shared logDir is not ours to delete.
          let ownerText: string;
          try { ownerText = nodeFs.readFileSync(join(dir, "owner.pid"), "utf8").trim(); } catch { continue; }
          if (!/^\d+$/.test(ownerText)) continue;
          const owner = Number(ownerText);
          if (owner === process.pid) continue;
          if (!(owner > 0 && Number.isSafeInteger(owner))) continue;
          if (pidAlive(owner)) continue;
          nodeFs.rmSync(dir, { recursive: true, force: true });
          removed.push(dir);
        } catch { /* skip entries we cannot inspect */ }
      }
      return { removed };
    },
  };
}
