import { describe, expect, it } from "vitest";
import { createTailBuffer, grepLines, normalizeForDisplay } from "../../src/core/tail.js";

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function chunked(data: Uint8Array, rnd: () => number, max: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < data.length; ) {
    const n = 1 + Math.floor(rnd() * max);
    out.push(data.subarray(i, i + n));
    i += n;
  }
  return out;
}

describe("normalizeForDisplay", () => {
  it("strips colors, cursor codes and OSC titles", () => {
    expect(normalizeForDisplay("\x1b[31mred\x1b[0m ok")).toBe("red ok");
    expect(normalizeForDisplay("a\x1b[2K\x1b[1Gb")).toBe("ab");
    expect(normalizeForDisplay("\x1b]0;title\x07text")).toBe("text");
    expect(normalizeForDisplay("\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\")).toBe("link");
  });
  it("collapses carriage-return progress to the last non-empty overwrite", () => {
    expect(normalizeForDisplay("10%\r50%\r100%")).toBe("100%");
    expect(normalizeForDisplay("done\r")).toBe("done");
    expect(normalizeForDisplay("a\r\nb\r\n")).toBe("a\nb\n");
    expect(normalizeForDisplay("p1\rp2\nnext\rnext2")).toBe("p2\nnext2");
  });
  it("drops bell, backspace and DEL but keeps tabs", () => {
    expect(normalizeForDisplay("a\x07b\x08c\x7fd\te")).toBe("abcd\te");
  });
  it("leaves plain text alone", () => {
    expect(normalizeForDisplay("héllo wörld ✓")).toBe("héllo wörld ✓");
    expect(normalizeForDisplay("")).toBe("");
  });
});

describe("createTailBuffer: lines", () => {
  it("returns complete lines and the unterminated partial", () => {
    const b = createTailBuffer(1024);
    b.push(bytes("one\ntwo\nthr"));
    expect(b.lines(10)).toEqual(["one", "two"]);
    expect(b.partial()).toBe("thr");
    b.push(bytes("ee\n"));
    expect(b.lines(10)).toEqual(["one", "two", "three"]);
    expect(b.partial()).toBe("");
  });
  it("lines(n) returns the last n; n <= 0 is empty", () => {
    const b = createTailBuffer(1024);
    b.push(bytes("a\nb\nc\nd\n"));
    expect(b.lines(2)).toEqual(["c", "d"]);
    expect(b.lines(0)).toEqual([]);
    expect(b.lines(-1)).toEqual([]);
    expect(b.lines(99)).toEqual(["a", "b", "c", "d"]);
  });
  it("keeps blank lines", () => {
    const b = createTailBuffer(1024);
    b.push(bytes("a\n\nb\n"));
    expect(b.lines(5)).toEqual(["a", "", "b"]);
  });
  it("lastLine prefers a non-empty partial, else the last complete line, else undefined", () => {
    const b = createTailBuffer(1024);
    expect(b.lastLine()).toBeUndefined();
    b.push(bytes("done\n"));
    expect(b.lastLine()).toBe("done");
    b.push(bytes("50%\r75%"));
    expect(b.lastLine()).toBe("75%");
  });
  it("normalizes for display, including CRLF", () => {
    const b = createTailBuffer(1024);
    b.push(bytes("\x1b[32mok\x1b[0m\r\nprog 1\rprog 2\n"));
    expect(b.lines(5)).toEqual(["ok", "prog 2"]);
  });
  it("totalBytes counts everything pushed, even evicted bytes", () => {
    const b = createTailBuffer(8);
    b.push(bytes("0123456789\n"));
    b.push(new Uint8Array(0));
    expect(b.totalBytes()).toBe(11);
  });
  it("totalLines counts every complete line ever pushed, even evicted ones, and ignores the partial", () => {
    const b = createTailBuffer(8);
    b.push(bytes("aaaa\nbbbb\n"));
    b.push(bytes("cc\ndd"));
    expect(b.lines(10)).toEqual(["cc"]);
    expect(b.totalLines()).toBe(3);
  });
  it("replaces invalid UTF-8 with U+FFFD without losing line structure", () => {
    const b = createTailBuffer(1024);
    b.push(Uint8Array.from([0x61, 0xff, 0xfe, 0x0a, 0x62, 0x0a]));
    expect(b.lines(5)).toEqual(["a\ufffd\ufffd", "b"]);
  });
  it("keeps a multibyte character intact across chunk boundaries", () => {
    const b = createTailBuffer(1024);
    const data = bytes("héllo ✓\n");
    for (const byte of data) b.push(Uint8Array.of(byte));
    expect(b.lines(1)).toEqual(["héllo ✓"]);
  });
});

describe("createTailBuffer: ring", () => {
  it("evicts the oldest bytes and drops a line cut by eviction", () => {
    const b = createTailBuffer(12);
    b.push(bytes("aaaa\nbbbb\ncccc\n")); // 15 bytes; window = "a\nbbbb\ncccc\n", cut inside "aaaa"
    expect(b.lines(10)).toEqual(["bbbb", "cccc"]);
    const c = createTailBuffer(9);
    c.push(bytes("aaaa\nbbbb\ncccc\n")); // window = "bbb\ncccc\n" (9 bytes), cut inside "bbbb"
    expect(c.lines(10)).toEqual(["cccc"]);
  });
  it("keeps a line that starts exactly at the window start", () => {
    const b = createTailBuffer(10);
    b.push(bytes("aaaa\nbbbb\n")); // exactly 10 bytes, nothing evicted
    expect(b.lines(5)).toEqual(["aaaa", "bbbb"]);
    b.push(bytes("cc\n")); // evicts "aaa" -> window "a\nbbbb\ncc\n"
    expect(b.lines(5)).toEqual(["bbbb", "cc"]);
    const c = createTailBuffer(10);
    c.push(bytes("aaaa\nbbbb\ncccc\n")); // window = "bbbb\ncccc\n" starts on a boundary
    expect(c.lines(5)).toEqual(["bbbb", "cccc"]);
  });
  it("a single chunk larger than the ring keeps only the last ringBytes", () => {
    const b = createTailBuffer(6);
    b.push(bytes("xxxxxxxxxx\nab\ncd\n")); // last 6 bytes: "ab\ncd\n" — starts on a boundary
    expect(b.lines(5)).toEqual(["ab", "cd"]);
    expect(b.totalBytes()).toBe(17);
  });
  it("skips the bytes of a UTF-8 character cut by eviction", () => {
    const b = createTailBuffer(5);
    b.push(bytes("✓✓")); // 6 bytes; window = last 5 starts mid-character
    expect(b.partial()).toBe("✓");
  });
  it("a partial line longer than the ring keeps its tail", () => {
    const b = createTailBuffer(4);
    b.push(bytes("abcdefgh"));
    expect(b.partial()).toBe("efgh");
    expect(b.lines(5)).toEqual([]);
  });
  it("ringBytes <= 0 degrades to a one-byte ring instead of failing", () => {
    const b = createTailBuffer(0);
    b.push(bytes("abc"));
    expect(b.partial()).toBe("c");
  });

  it("property: the ring never exceeds ringBytes and totalBytes is exact", () => {
    const rnd = mulberry32(11);
    for (let run = 0; run < 200; run++) {
      const cap = 1 + Math.floor(rnd() * 64);
      const b = createTailBuffer(cap);
      let total = 0;
      for (let i = 0; i < 20; i++) {
        const n = Math.floor(rnd() * 100);
        const chunk = Uint8Array.from({ length: n }, () => (rnd() < 0.15 ? 0x0a : 0x61 + Math.floor(rnd() * 26)));
        b.push(chunk);
        total += n;
        // Everything the buffer can report must fit in the ring (latin-1 test data: 1 byte per char, plus separators).
        const lines = b.lines(1_000_000);
        const held = lines.reduce((s, l) => s + l.length + 1, 0) + b.partial().length;
        expect(held).toBeLessThanOrEqual(cap);
        expect(b.totalBytes()).toBe(total);
      }
    }
  });

  it("property: the reported tail is always a suffix of the full output lines", () => {
    const rnd = mulberry32(12);
    for (let run = 0; run < 200; run++) {
      const cap = 8 + Math.floor(rnd() * 120);
      const text = Array.from({ length: 1 + Math.floor(rnd() * 40) }, () => "w".repeat(Math.floor(rnd() * 12)) + Math.floor(rnd() * 100)).join("\n") + "\n";
      const b = createTailBuffer(cap);
      for (const c of chunked(bytes(text), rnd, 30)) b.push(c);
      const all = text.split("\n").slice(0, -1);
      const got = b.lines(10_000);
      expect(all.slice(all.length - got.length)).toEqual(got);
      // and at least the last line survives when it fits (it is "<cap bytes" by construction below)
      if (all.length && all[all.length - 1].length + 1 <= cap) expect(got[got.length - 1]).toBe(all[all.length - 1]);
    }
  });
});

describe("createTailBuffer: chunk boundaries (property)", () => {
  it("any chunking yields the same lines as one push: no line lost or duplicated", () => {
    const rnd = mulberry32(21);
    for (let run = 0; run < 300; run++) {
      const lineCount = Math.floor(rnd() * 30);
      const lines = Array.from({ length: lineCount }, (_, i) => `line ${i} ${"é✓x".repeat(Math.floor(rnd() * 4))}`);
      const trailing = rnd() < 0.5 ? "" : "unterminated é";
      const data = bytes(lines.map((l) => l + "\n").join("") + trailing);
      const whole = createTailBuffer(1 << 20);
      whole.push(data);
      const split = createTailBuffer(1 << 20);
      for (const c of chunked(data, rnd, 1 + Math.floor(rnd() * 40))) split.push(c);
      expect(split.lines(1_000_000)).toEqual(lines);
      expect(split.lines(1_000_000)).toEqual(whole.lines(1_000_000));
      expect(split.partial()).toBe(trailing);
      expect(split.totalBytes()).toBe(data.length);
    }
  });
  it("negative control: the comparison catches a dropped chunk", () => {
    const a = createTailBuffer(1024);
    const b = createTailBuffer(1024);
    a.push(bytes("x\ny\nz\n"));
    b.push(bytes("x\n"));
    b.push(bytes("z\n")); // "y\n" lost
    expect(b.lines(10)).not.toEqual(a.lines(10));
  });
});

describe("grepLines", () => {
  const lines = ["a", "ERROR one", "b", "c", "d", "e", "ERROR two", "f"];
  it("returns matching lines", () => {
    expect(grepLines(lines, /ERROR/, 0)).toEqual(["ERROR one", "ERROR two"]);
  });
  it("adds context and separates disjoint groups with --", () => {
    expect(grepLines(lines, /ERROR/, 1)).toEqual(["a", "ERROR one", "b", "--", "e", "ERROR two", "f"]);
  });
  it("merges overlapping context without duplicates", () => {
    expect(grepLines(lines, /ERROR/, 2)).toEqual(["a", "ERROR one", "b", "c", "d", "e", "ERROR two", "f"]);
  });
  it("clips context at the ends", () => {
    expect(grepLines(["hit", "x"], /hit/, 5)).toEqual(["hit", "x"]);
  });
  it("returns [] when nothing matches", () => {
    expect(grepLines(lines, /nope/, 3)).toEqual([]);
    expect(grepLines([], /x/, 1)).toEqual([]);
  });
  it("is not confused by the g flag's lastIndex state", () => {
    expect(grepLines(["aa", "aa", "aa"], /a/g, 0)).toEqual(["aa", "aa", "aa"]);
    expect(grepLines(["aa", "aa"], /a/y, 0)).toEqual(["aa", "aa"]);
  });
  it("treats negative or fractional context as 0 or floor", () => {
    expect(grepLines(lines, /ERROR one/, -2)).toEqual(["ERROR one"]);
    expect(grepLines(lines, /ERROR one/, 1.9)).toEqual(["a", "ERROR one", "b"]);
  });
  it("honors the i flag", () => {
    expect(grepLines(["Error"], /error/i, 0)).toEqual(["Error"]);
  });
});
