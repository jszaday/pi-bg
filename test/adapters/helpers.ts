import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExitInfo, ProcessHandle, ProcessRunner, RunSpec } from "../../src/contract.js";

const dirs: string[] = [];
const handles: ProcessHandle[] = [];

export function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "pi-bg-w4-"));
  dirs.push(d);
  return d;
}

/** Remove temp dirs and SIGKILL any process groups we started (only handles created through run()). */
export function cleanup(): void {
  for (const h of handles.splice(0)) h.kill("kill");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export interface RunResult { exit: ExitInfo; stdout: Buffer; stderr: Buffer; combined: Buffer; handle: ProcessHandle; ms: number }

export async function run(runner: ProcessRunner, spec: RunSpec, hook?: (h: ProcessHandle) => void): Promise<RunResult> {
  const out: Buffer[] = [], err: Buffer[] = [], all: Buffer[] = [];
  const t0 = Date.now();
  const h = runner.start(spec, (chunk, stream) => {
    const b = Buffer.from(chunk);
    all.push(b);
    if (stream === "stdout") out.push(b);
    if (stream === "stderr") err.push(b);
  });
  if ("startError" in h) throw new Error(h.startError);
  handles.push(h);
  hook?.(h);
  const exit = await h.exited;
  return { exit, stdout: Buffer.concat(out), stderr: Buffer.concat(err), combined: Buffer.concat(all), handle: h, ms: Date.now() - t0 };
}

export const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

export async function readPid(file: string): Promise<number> {
  await waitFor(() => existsSync(file) && readFileSync(file, "utf8").trim().length > 0);
  return Number(readFileSync(file, "utf8").trim());
}
