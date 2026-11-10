import type {
  ExitInfo,
  OutputSink,
  KillSignal,
  ProcessHandle,
  ProcessRunner,
  RunnerCapabilities,
  RunSpec,
  StreamName,
} from "../../src/contract.js";
import type { FakeClock } from "./clock.js";

// One scripted step, relative to the start of the process.
// `at` 0 (or less) fires synchronously inside start(); larger values need a FakeClock.
// A step with `exit` ends the process; output steps after exit are ignored.
export interface Step {
  at: number;
  chunk?: string;
  stream?: StreamName;
  exit?: ExitInfo;
}

export class FakeRunner implements ProcessRunner {
  readonly capabilities: RunnerCapabilities;
  // Every RunSpec passed to start(), in order.
  readonly started: RunSpec[] = [];
  // Every kill() call across all handles, in order.
  readonly kills: KillSignal[] = [];
  // Every writeStdin() call across all handles, in order (data decoded as UTF-8). Only handles started with RunSpec.stdin have the method.
  readonly writes: { data: string; eof: boolean }[] = [];
  private scripts: Step[][] = [];
  private nextPid = 10_000;

  constructor(caps: Partial<RunnerCapabilities> = {}, private readonly clock?: FakeClock) {
    this.capabilities = { pid: true, splitStreams: true, gracefulTerm: true, ...caps };
  }

  // Queues the steps for the next start() call. Each start() consumes one queued script.
  // A start() with no queued script runs silently until killed.
  script(steps: Step[]): void {
    for (const s of steps) {
      if (s.at > 0 && !this.clock) {
        throw new Error(`FakeRunner step at=${s.at} needs a clock; construct FakeRunner(caps, clock) so delayed steps can fire`);
      }
    }
    this.scripts.push(steps.map((s) => ({ ...s })));
  }

  start(spec: RunSpec, sink: OutputSink): ProcessHandle {
    this.started.push({ ...spec });
    const steps = this.scripts.shift() ?? [];
    const pid = this.capabilities.pid ? this.nextPid++ : undefined;
    let exitInfo: ExitInfo | undefined;
    let resolveExit!: (e: ExitInfo) => void;
    const exited = new Promise<ExitInfo>((r) => (resolveExit = r));

    const finish = (info: ExitInfo) => {
      if (exitInfo) return;
      exitInfo = info;
      resolveExit(info);
    };
    const fire = (s: Step) => {
      if (exitInfo) return;
      if (s.chunk !== undefined) sink(new TextEncoder().encode(s.chunk), s.stream ?? "combined");
      if (s.exit) finish(s.exit);
    };

    const handle: ProcessHandle = {
      pid,
      exited,
      kill: (sig) => {
        this.kills.push(sig);
        const signal = sig !== "kill" && this.capabilities.gracefulTerm ? `SIG${sig.toUpperCase()}` : "SIGKILL";
        finish({ code: null, signal });
      },
    };

    if (spec.stdin) {
      let closed = false;
      handle.writeStdin = (data, eof) => {
        if (closed || exitInfo) return { error: closed ? "stdin was already closed by an earlier write with eof true" : "the program closed its stdin or has exited" };
        this.writes.push({ data: new TextDecoder().decode(data), eof });
        if (eof) closed = true;
        return undefined;
      };
    }

    for (const s of steps) {
      if (s.at > 0) this.clock!.setTimeout(() => fire(s), s.at);
      else fire(s);
    }
    return handle;
  }
}
