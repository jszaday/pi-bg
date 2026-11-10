import { statSync } from "node:fs";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { ExitInfo, OutputSink, ProcessHandle, ProcessRunner, RunSpec } from "../contract.js";

/**
 * Alternative runner over Pi's native operations. Limits: no pid, merged streams, kill is an abort (Pi SIGKILLs the tree, no grace).
 * `RunSpec.command` must already carry the command prefix (Pi's tool applies it before exec).
 */
export function createPiOpsRunner(ops: { exec: BashOperations["exec"] }): ProcessRunner {
  return {
    capabilities: { pid: false, splitStreams: false, gracefulTerm: false },
    start(spec: RunSpec, sink: OutputSink): ProcessHandle | { startError: string } {
      try {
        if (!statSync(spec.cwd).isDirectory()) throw new Error("not a directory");
      } catch {
        return { startError: `Working directory does not exist: ${spec.cwd}\nCannot execute bash commands. Run the command from an existing directory.` };
      }
      const ac = new AbortController();
      const exited: Promise<ExitInfo> = (async () => {
        try {
          const r = await ops.exec(spec.command, spec.cwd, {
            onData: (b) => sink(b, "combined"),
            signal: ac.signal,
            env: spec.env,
          });
          // Pi reports signal deaths as 128+n and cannot be told apart from a plain exit code here.
          return { code: r.exitCode, signal: null };
        } catch (e) {
          if (ac.signal.aborted) return { code: null, signal: "SIGKILL" };
          sink(Buffer.from(`pi-bg: ${(e as Error).message}\n`), "combined");
          return { code: null, signal: null };
        }
      })();
      return {
        exited,
        kill() {
          ac.abort();
        },
      };
    },
  };
}
