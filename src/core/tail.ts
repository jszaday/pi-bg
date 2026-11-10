// Bounded recent-output ring, incremental line splitting, display normalization and grep
// (DESIGN section 10). The ring holds raw bytes (a circular buffer of exactly `ringBytes`),
// so a chunk boundary can never split a line or a UTF-8 character: text is decoded only
// from the linearized window.
import type { TailBuffer } from "../contract.js";

// CSI sequences, OSC sequences (BEL or ST terminated), and other two-byte escapes.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g;
// Control characters other than tab, LF and CR (bell, backspace, form feed, DEL, ...).
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g;

/** Strips ANSI escapes and control characters; a carriage return keeps only the last non-empty overwrite per line. */
export function normalizeForDisplay(text: string): string {
  const clean = text.replace(ANSI_RE, "").replace(CTRL_RE, "").replace(/\x1b/g, "");
  return clean
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const parts = line.split("\r");
      for (let i = parts.length - 1; i >= 0; i--) if (parts[i] !== "") return parts[i];
      return "";
    })
    .join("\n");
}

const NL = 0x0a;

export function createTailBuffer(ringBytes: number): TailBuffer {
  const cap = Number.isSafeInteger(ringBytes) && ringBytes > 0 ? ringBytes : 1;
  const ring = new Uint8Array(cap);
  let head = 0; // index of the oldest byte
  let len = 0; // bytes held, never above cap
  let total = 0; // all bytes ever pushed
  let newlines = 0; // all LF bytes ever pushed: complete lines, including evicted ones
  let prevByte: number | undefined; // the last evicted byte (the byte just before the window)
  const decoder = new TextDecoder("utf-8"); // non-fatal: invalid UTF-8 becomes U+FFFD

  function push(chunk: Uint8Array): void {
    total += chunk.length;
    if (chunk.length === 0) return;
    for (let i = 0; i < chunk.length; i++) if (chunk[i] === NL) newlines++;
    if (chunk.length >= cap) {
      // The whole old window and the chunk's own head are evicted.
      prevByte = chunk.length > cap ? chunk[chunk.length - cap - 1] : len > 0 ? ring[(head + len - 1) % cap] : prevByte;
      ring.set(chunk.subarray(chunk.length - cap));
      head = 0;
      len = cap;
      return;
    }
    const overflow = Math.max(0, len + chunk.length - cap);
    if (overflow > 0) {
      prevByte = ring[(head + overflow - 1) % cap];
      head = (head + overflow) % cap;
      len -= overflow;
    }
    const tailPos = (head + len) % cap;
    const first = Math.min(chunk.length, cap - tailPos);
    ring.set(chunk.subarray(0, first), tailPos);
    if (first < chunk.length) ring.set(chunk.subarray(first), 0);
    len += chunk.length;
  }

  // Linearized window, minus any leading bytes of a UTF-8 character cut by eviction.
  function window(): { bytes: Uint8Array; midLine: boolean } {
    const out = new Uint8Array(len);
    const first = Math.min(len, cap - head);
    out.set(ring.subarray(head, head + first));
    if (first < len) out.set(ring.subarray(0, len - first), first);
    const evicted = total > len;
    let start = 0;
    if (evicted) while (start < out.length && (out[start] & 0xc0) === 0x80) start++;
    const midLine = evicted && prevByte !== NL;
    return { bytes: start ? out.subarray(start) : out, midLine };
  }

  // complete: finished lines (an eviction-truncated first line is dropped); partial: the unterminated rest.
  function split(): { complete: string[]; partial: string } {
    const { bytes, midLine } = window();
    const parts = decoder.decode(bytes).split("\n");
    const partial = parts.pop() ?? "";
    if (midLine && parts.length > 0) parts.shift();
    return { complete: parts.map(normalizeForDisplay), partial: normalizeForDisplay(partial) };
  }

  return {
    push,
    lines(n: number): string[] {
      if (!(n > 0)) return [];
      const { complete } = split();
      return complete.slice(-Math.floor(n));
    },
    partial: () => split().partial,
    lastLine(): string | undefined {
      const { complete, partial } = split();
      if (partial !== "") return partial;
      return complete[complete.length - 1];
    },
    totalBytes: () => total,
    totalLines: () => newlines,
  };
}

/** Lines matching `re`, each with `context` lines around it; disjoint groups are separated by "--" (as grep does). */
export function grepLines(lines: string[], re: RegExp, context: number): string[] {
  const plain = new RegExp(re.source, re.flags.replace(/[gy]/g, "")); // no lastIndex state
  const ctx = Number.isFinite(context) && context > 0 ? Math.floor(context) : 0;
  const keep: number[] = [];
  let last = -1; // highest index already scheduled
  lines.forEach((line, i) => {
    if (!plain.test(line)) return;
    for (let j = Math.max(last + 1, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++) keep.push(j);
    last = Math.max(last, Math.min(lines.length - 1, i + ctx));
  });
  const out: string[] = [];
  keep.forEach((idx, k) => {
    if (ctx > 0 && k > 0 && idx !== keep[k - 1] + 1) out.push("--");
    out.push(lines[idx]);
  });
  return out;
}
