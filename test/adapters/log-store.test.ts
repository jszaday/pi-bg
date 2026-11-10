import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFsLogStore, resolveBaseDir } from "../../src/adapters/index.js";
import type { LogWriter } from "../../src/contract.js";
import { cleanup, tmp } from "./helpers.js";

afterEach(cleanup);
const mode = (p: string) => fs.statSync(p).mode & 0o777;
const open = (s: ReturnType<typeof createFsLogStore>, id = "bg1"): LogWriter => {
  const w = s.open(id);
  if ("error" in w) throw new Error(w.error);
  return w;
};
const text = async (s: ReturnType<typeof createFsLogStore>, id: string, st: "combined" | "stdout" | "stderr", off = 0, max = 1e6) => {
  const r = await s.read(id, st, off, max);
  if ("error" in r) throw new Error(r.error);
  return r;
};

describe("fs log store", () => {
  it("creates 0700 directories and 0600 files with owner.pid", async () => {
    const base = join(tmp(), "logs");
    const s = createFsLogStore({ baseDir: base, sessionId: "s1", maxLogBytes: 1e6 });
    const w = open(s);
    w.write(Buffer.from("hi\n"), "stdout");
    await w.close();
    expect(mode(base)).toBe(0o700);
    expect(mode(join(base, "s1"))).toBe(0o700);
    expect(mode(w.path)).toBe(0o600);
    expect(mode(join(base, "s1", "bg1.stdout.log"))).toBe(0o600);
    expect(mode(join(base, "s1", "owner.pid"))).toBe(0o600);
    expect(fs.readFileSync(join(base, "s1", "owner.pid"), "utf8")).toBe(String(process.pid));
  });

  it("writes combined always and split files per stream; reads by offset", async () => {
    const s = createFsLogStore({ baseDir: tmp(), sessionId: "s", maxLogBytes: 1e6 });
    const w = open(s);
    w.write(Buffer.from("out1\n"), "stdout");
    w.write(Buffer.from("err1\n"), "stderr");
    w.write(Buffer.from("out2\n"), "stdout");
    expect(Buffer.from((await text(s, "bg1", "combined")).bytes).toString()).toBe("out1\nerr1\nout2\n");
    expect(Buffer.from((await text(s, "bg1", "stdout")).bytes).toString()).toBe("out1\nout2\n");
    expect(Buffer.from((await text(s, "bg1", "stderr")).bytes).toString()).toBe("err1\n");
    const part = await text(s, "bg1", "combined", 5, 5);
    expect(Buffer.from(part.bytes).toString()).toBe("err1\n");
    expect(part.nextOffset).toBe(10);
    expect(part.totalBytes).toBe(15);
    const past = await text(s, "bg1", "combined", 999);
    expect(past.bytes.length).toBe(0);
    expect(past.nextOffset).toBe(15);
    await w.close();
  });

  it("a combined-only task has no stdout log: read answers cause and action", async () => {
    const s = createFsLogStore({ baseDir: tmp(), sessionId: "s", maxLogBytes: 1e6 });
    open(s).write(Buffer.from("x"), "combined");
    const r = await s.read("bg1", "stdout", 0, 10);
    expect((r as { error: string }).error).toMatch(/Cannot read stdout log for bg1.*try stream "combined"/);
  });

  it("honors TMPDIR through resolveBaseDir", () => {
    const old = process.env.TMPDIR;
    const t = tmp();
    process.env.TMPDIR = t;
    try {
      expect(resolveBaseDir(null).startsWith(t)).toBe(true);
      expect(resolveBaseDir("/x/y")).toBe("/x/y");
    } finally {
      if (old === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = old;
    }
  });

  it("unwritable directory: open returns an error with cause and action", () => {
    if (process.getuid?.() === 0) return; // root ignores modes
    const base = tmp();
    fs.chmodSync(base, 0o500);
    const s = createFsLogStore({ baseDir: join(base, "sub"), sessionId: "s", maxLogBytes: 100 });
    const r = s.open("bg1");
    expect((r as { error: string }).error).toMatch(/Cannot create log directory .*Make it writable or set output\.logDir/);
    fs.chmodSync(base, 0o700);
  });

  it("write failure degrades the writer (ring-only), keeps earlier bytes, never throws", async () => {
    let fail = false;
    const s = createFsLogStore({ baseDir: tmp(), sessionId: "s", maxLogBytes: 1e6, io: { writeSync: (fd: number, b: Uint8Array, o: number, l: number) => { if (fail) throw Object.assign(new Error("ENOSPC: no space"), { code: "ENOSPC" }); return fs.writeSync(fd, b, o, l); } } });
    const w = open(s);
    w.write(Buffer.from("ok\n"), "combined");
    expect(w.degraded).toBeNull();
    fail = true;
    expect(() => w.write(Buffer.from("lost\n"), "combined")).not.toThrow();
    expect(w.degraded).toMatch(/Log write failed: ENOSPC.*free disk space/);
    fail = false;
    w.write(Buffer.from("after\n"), "combined"); // stays degraded
    expect(Buffer.from((await text(s, "bg1", "combined")).bytes).toString()).toBe("ok\n");
  });

  it("a transient EAGAIN is retried once without degrading", () => {
    let n = 0;
    const s = createFsLogStore({ baseDir: tmp(), sessionId: "s", maxLogBytes: 1e6, io: { writeSync: (fd: number, b: Uint8Array, o: number, l: number) => { if (n++ === 0) throw Object.assign(new Error("again"), { code: "EAGAIN" }); return fs.writeSync(fd, b, o, l); } } });
    const w = open(s);
    w.write(Buffer.from("x"), "combined");
    expect(w.degraded).toBeNull();
  });

  it("maxLogBytes stops writing, appends a marker once, and does not degrade", async () => {
    const s = createFsLogStore({ baseDir: tmp(), sessionId: "s", maxLogBytes: 10 });
    const w = open(s);
    w.write(Buffer.from("0123456789ABC"), "combined");
    w.write(Buffer.from("more"), "combined");
    const body = Buffer.from((await text(s, "bg1", "combined")).bytes).toString();
    expect(body.startsWith("0123456789\n[pi-bg: log size limit of 10 bytes")).toBe(true);
    expect(body.match(/log size limit/g)!.length).toBe(1);
    expect(w.degraded).toBeNull();
  });

  it("10 MB through the writer is stored without loss", async () => {
    const s = createFsLogStore({ baseDir: tmp(), sessionId: "s", maxLogBytes: 1e9 });
    const w = open(s);
    const chunk = Buffer.alloc(64 * 1024, "z");
    for (let i = 0; i < 160; i++) w.write(chunk, "stdout");
    await w.close();
    expect(fs.statSync(w.path).size).toBe(160 * 64 * 1024);
  });

  it("rejects ids that could escape the session directory", async () => {
    const s = createFsLogStore({ baseDir: tmp(), sessionId: "s", maxLogBytes: 10 });
    expect((s.open("../evil") as { error: string }).error).toMatch(/Invalid task id/);
    expect(((await s.read("../evil", "combined", 0, 1)) as { error: string }).error).toMatch(/Invalid task id/);
  });

  describe("gc", () => {
    const aged = (dir: string, ageMs: number) => {
      const t = new Date(Date.now() - ageMs);
      for (const f of fs.readdirSync(dir)) fs.utimesSync(join(dir, f), t, t);
      fs.utimesSync(dir, t, t);
    };
    const mk = (base: string, name: string, owner: number | null, ageMs: number) => {
      const d = join(base, name);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(join(d, "bg1.log"), "x");
      if (owner !== null) fs.writeFileSync(join(d, "owner.pid"), String(owner));
      aged(d, ageMs);
      return d;
    };
    it("removes old dirs of dead owners only; keeps young, live-owned and own session", async () => {
      const base = tmp();
      const s = createFsLogStore({ baseDir: base, sessionId: "mine", maxLogBytes: 1e6 });
      open(s).write(Buffer.from("x"), "combined");
      aged(join(base, "mine"), 10 * 864e5);
      const dead = mk(base, "dead", 2 ** 22 + 12345, 10 * 864e5); // pid beyond pid_max default: not alive
      const noOwner = mk(base, "noowner", null, 10 * 864e5);
      const live = mk(base, "live", process.ppid, 10 * 864e5);
      const young = mk(base, "young", 2 ** 22 + 12345, 1000);
      const r = await s.gc(7 * 864e5);
      expect(r.removed).toEqual([dead]);
      for (const keep of [live, young, join(base, "mine")]) expect(fs.existsSync(keep)).toBe(true);
    });
    it("never removes old directories without pi-bg evidence (no owner.pid, or an owner.pid that is not a pid)", async () => {
      const base = tmp();
      const s = createFsLogStore({ baseDir: base, sessionId: "mine", maxLogBytes: 1e6 });
      const unrelated = mk(base, "photos", null, 10 * 864e5);
      const emptyDir = join(base, "empty");
      fs.mkdirSync(emptyDir);
      fs.utimesSync(emptyDir, new Date(0), new Date(0));
      const junk = mk(base, "junk", null, 10 * 864e5);
      fs.writeFileSync(join(junk, "owner.pid"), "not a pid");
      aged(junk, 10 * 864e5);
      const ours = mk(base, "ours", 2 ** 22 + 12345, 10 * 864e5); // positive control: evidence present, owner dead
      expect((await s.gc(7 * 864e5)).removed).toEqual([ours]);
      for (const keep of [unrelated, emptyDir, junk]) expect(fs.existsSync(keep)).toBe(true);
    });
    it("a missing base directory is not an error", async () => {
      const s = createFsLogStore({ baseDir: join(tmp(), "nope"), sessionId: "s", maxLogBytes: 1 });
      expect(await s.gc(0)).toEqual({ removed: [] });
    });
  });
});
