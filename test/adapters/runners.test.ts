import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { createOwnSpawnRunner, createPiOpsRunner, piShellEnv, resolveShell } from "../../src/adapters/index.js";
import type { ProcessRunner } from "../../src/contract.js";
import { alive, cleanup, readPid, run, sha, tmp, waitFor } from "./helpers.js";

afterEach(cleanup);

const shell = resolveShell();
if ("error" in shell) throw new Error(shell.error);
const env = () => piShellEnv();
const own = (termGraceMs = 300, extra: object = {}) => createOwnSpawnRunner({ ...shell, env, termGraceMs, ...extra });
const piOps = () => createPiOpsRunner(createLocalBashOperations());

// Conformance list from TODO S3: both runners must agree on these.
const both: [string, () => ProcessRunner][] = [["own-spawn", () => own()], ["pi-ops", piOps]];

describe.each(both)("conformance: %s", (_n, make) => {
  const spec = (command: string, extra: object = {}) => ({ command, cwd: tmp(), env: env(), ...extra });

  it("quoting", async () => {
    const r = await run(make(), spec(`printf '%s|' "a b" 'c"d' $'e\\tf'; echo "it's"`));
    expect(r.combined.toString()).toBe(`a b|c"d|e\tf|it's\n`);
  });
  it("env passed explicitly", async () => {
    const r = await run(make(), spec("echo $FOO", { env: { ...env(), FOO: "bar" } }));
    expect(r.combined.toString()).toBe("bar\n");
  });
  it("cwd", async () => {
    const d = tmp();
    const r = await run(make(), { command: "pwd -P", cwd: d, env: env() });
    expect(r.combined.toString().trim()).toBe(fs.realpathSync(d));
  });
  it("exit codes", async () => {
    expect((await run(make(), spec("exit 7"))).exit.code).toBe(7);
    expect((await run(make(), spec("true"))).exit.code).toBe(0);
  });
  it("closed stdin reads EOF", async () => {
    const r = await run(make(), spec("read x; echo rc=$?"));
    expect(r.combined.toString()).toBe("rc=1\n");
  });
  it("TMPDIR honored", async () => {
    const t = tmp();
    const r = await run(make(), spec("echo $TMPDIR", { env: { ...env(), TMPDIR: t } }));
    expect(r.combined.toString().trim()).toBe(t);
  });
  it("10 MB output without loss", async () => {
    const r = await run(make(), spec("head -c 10485760 /dev/zero | tr '\\0' 'x'"));
    expect(r.combined.length).toBe(10 * 1024 * 1024);
    expect(sha(r.combined)).toBe(sha(Buffer.alloc(10 * 1024 * 1024, "x")));
  });
  it("missing cwd is a startError naming cause and action", () => {
    const h = make().start({ command: "true", cwd: "/nonexistent-pi-bg-dir", env: env() }, () => {});
    expect(h).toHaveProperty("startError");
    expect((h as { startError: string }).startError).toMatch(/Working directory does not exist: \/nonexistent-pi-bg-dir\nCannot execute bash commands\. Run/);
  });
  it("kill reaches a grandchild in the group", async () => {
    const d = tmp();
    let gc = 0;
    await run(make(), { command: `sleep 60 & echo $! > ${d}/gc; wait`, cwd: d, env: env() }, (h) => {
      void readPid(`${d}/gc`).then((p) => { gc = p; h.kill("kill"); });
    });
    expect(gc).toBeGreaterThan(0);
    expect(await waitFor(() => !alive(gc), 3000)).toBe(true);
  });
  it("output reaches the sink in 'combined' or split form per capabilities", async () => {
    const r = await run(make(), spec("echo out; echo err >&2"));
    if (make().capabilities.splitStreams) {
      expect(r.stdout.toString()).toBe("out\n");
      expect(r.stderr.toString()).toBe("err\n");
    } else {
      expect(r.combined.toString()).toContain("out\n");
      expect(r.combined.toString()).toContain("err\n");
    }
  });
  it("returns promptly when an escaped process holds the pipe (exit + 100 ms grace)", async () => {
    const r = await run(make(), spec("(sleep 2 >&1 &) ; echo done"));
    expect(r.combined.toString()).toBe("done\n");
    expect(r.ms).toBeLessThan(1000);
  }, 10_000);
});

describe("own-spawn specifics", () => {
  it("reports a pid equal to the group id and the shell's $$", async () => {
    const r = await run(own(), { command: "echo $$", cwd: tmp(), env: env() });
    expect(r.handle.pid).toBe(Number(r.combined.toString().trim()));
    expect(own().capabilities).toEqual({ pid: true, splitStreams: true, gracefulTerm: true });
  });
  it("signal exit reports the signal, not a code", async () => {
    const r = await run(own(), { command: "kill -9 $$", cwd: tmp(), env: env() });
    expect(r.exit).toEqual({ code: null, signal: "SIGKILL" });
  });
  it("applies commandPrefix as 'prefix\\ncommand'", async () => {
    const r = await run(own(300, { commandPrefix: "f() { echo from-fn; }" }), { command: "f", cwd: tmp(), env: env() });
    expect(r.combined.toString()).toBe("from-fn\n");
  });
  it("without commandPrefix the command is untouched (caller already prefixed)", async () => {
    const r = await run(own(), { command: "f() { echo x; }\nf", cwd: tmp(), env: env() });
    expect(r.combined.toString()).toBe("x\n");
  });
  it("env falls back to the runner's env() when RunSpec.env is absent", async () => {
    const r = await run(own(300, { env: () => ({ PATH: process.env.PATH ?? "", ONLY: "1" }) }), { command: "echo $ONLY", cwd: tmp() });
    expect(r.combined.toString()).toBe("1\n");
  });
  it("SIGTERM lets a handler run, then the process exits (no SIGKILL needed)", async () => {
    const d = tmp();
    const r = await run(own(2000), { command: `trap 'echo got-term; exit 0' TERM; echo ready > ${d}/r; while :; do sleep 0.05; done`, cwd: d, env: env() }, (h) => {
      void waitFor(() => fs.existsSync(`${d}/r`)).then(() => h.kill("term"));
    });
    expect(r.combined.toString()).toContain("got-term");
    expect(r.exit.code).toBe(0);
    expect(r.ms).toBeLessThan(1900);
  });
  it("SIGTERM ignored: escalates to SIGKILL after termGraceMs (not before)", async () => {
    const d = tmp();
    let t0 = 0;
    const r = await run(own(400), { command: `trap '' TERM; echo ready > ${d}/r; while :; do sleep 0.05; done`, cwd: d, env: env() }, (h) => {
      void waitFor(() => fs.existsSync(`${d}/r`)).then(() => { t0 = Date.now(); h.kill("term"); h.kill("term"); });
    });
    const took = Date.now() - t0;
    expect(r.exit.signal).toBe("SIGKILL");
    expect(took).toBeGreaterThanOrEqual(380);
    expect(took).toBeLessThan(1500);
  });
  it("escalation also kills a grandchild that ignored SIGTERM after the leader died", async () => {
    const d = tmp();
    const r = await run(own(300), { command: `(trap '' TERM; exec sleep 60) & echo $! > ${d}/gc; wait`, cwd: d, env: env() }, (h) => {
      void waitFor(() => fs.existsSync(`${d}/gc`)).then(() => setTimeout(() => h.kill("term"), 100));
    });
    const gc = await readPid(`${d}/gc`);
    expect(gc).toBeGreaterThan(0); // alive(0) signals our own group and is always true
    expect(r.exit.signal).toBe("SIGTERM");
    expect(await waitFor(() => !alive(gc), 2000)).toBe(true);
  });
  it("kill('kill') is immediate and idempotent; kill after exit is a no-op", async () => {
    const r = await run(own(60_000), { command: "sleep 60", cwd: tmp(), env: env() }, (h) => { setTimeout(() => { h.kill("kill"); h.kill("kill"); }, 100); });
    expect(r.exit.signal).toBe("SIGKILL");
    expect(r.ms).toBeLessThan(1500);
    expect(() => r.handle.kill("term")).not.toThrow();
  });
  it("missing shell is a startError naming the shell", () => {
    const h = createOwnSpawnRunner({ shell: "/nonexistent/sh", shellArgs: ["-c"], env, termGraceMs: 100 }).start({ command: "true", cwd: tmp() }, () => {});
    expect((h as { startError: string }).startError).toMatch(/Shell not found or not executable: \/nonexistent\/sh\. Set/);
  });
});

describe("pi-ops specifics", () => {
  it("advertises no pid, merged streams, no graceful term", () => {
    expect(piOps().capabilities).toEqual({ pid: false, splitStreams: false, gracefulTerm: false });
  });
  it("kill aborts: exits with SIGKILL, grandchild gone, 'term' acts as 'kill'", async () => {
    const d = tmp();
    const r = await run(piOps(), { command: `sleep 60 & echo $! > ${d}/gc; wait`, cwd: d, env: env() }, (h) => {
      void waitFor(() => fs.existsSync(`${d}/gc`) && fs.readFileSync(`${d}/gc`, "utf8").trim() !== "").then(() => h.kill("term"));
    });
    const gc = Number(fs.readFileSync(`${d}/gc`, "utf8"));
    expect(r.exit).toEqual({ code: null, signal: "SIGKILL" });
    expect(await waitFor(() => !alive(gc), 2000)).toBe(true);
  });
  it("exec failure is reported on the sink and resolves without rejecting", async () => {
    const r = await run(createPiOpsRunner({ exec: async () => { throw new Error("boom"); } }), { command: "x", cwd: tmp() });
    expect(r.exit).toEqual({ code: null, signal: null });
    expect(r.combined.toString()).toContain("pi-bg: boom");
  });
  it("negative control: a mirrored-bug exec (always exit 0) is caught by the exit-code check", async () => {
    const r = await run(createPiOpsRunner({ exec: async () => ({ exitCode: 0 }) }), { command: "exit 7", cwd: tmp() });
    expect(r.exit.code).not.toBe(7);
  });
});

describe("shell resolution", () => {
  it("explicit bad shellPath returns an error with cause and action", () => {
    const r = resolveShell("/nonexistent/shell");
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toMatch(/Custom shell path not found: \/nonexistent\/shell\nFix or remove shellPath/);
  });
  it("explicit shellPath is used", () => {
    expect(resolveShell("/bin/sh")).toEqual({ shell: "/bin/sh", shellArgs: ["-c"] });
  });
  it("piShellEnv prepends Pi's bin dir to PATH once", () => {
    const e = piShellEnv({ PATH: "/usr/bin" });
    const first = e.PATH.split(":")[0];
    expect(first).toMatch(/\/bin$/);
    expect(piShellEnv({ PATH: e.PATH }).PATH).toBe(e.PATH);
  });
});
