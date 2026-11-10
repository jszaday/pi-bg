// Real `pi` CLI in tmux with the real pi-bg extension, a loopback fake OpenAI endpoint (no network, no model), private agent dir and tmux socket.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { skipReason, sleep, TMUX, until } from "../support/harness.js";

const EXT = fileURLToPath(new URL("../../../src/index.ts", import.meta.url));
const PI_BIN = process.env.PI_BIN ?? [...(process.env.PATH ?? "").split(":")].map((d) => join(d, "pi")).find((p) => existsSync(p));
let skip = skipReason("key", { tmux: true });
if (!skip && !PI_BIN) {
  skip = "pi CLI not found (put pi on PATH or set PI_BIN)";
  console.warn(`[gated:key] SKIPPED: ${skip}`);
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

/** First request of a turn answers with a bash tool call; after a tool result, plain text. */
function stubServer(command: string): Promise<{ port: number; close(): void }> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (!req.url?.includes("chat/completions")) { res.writeHead(404).end(); return; }
        const msgs = JSON.parse(body).messages ?? [];
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (delta: unknown, finish?: string) =>
          res.write("data: " + JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "stub", choices: [{ index: 0, delta, finish_reason: finish ?? null }] }) + "\n\n");
        if (msgs[msgs.length - 1]?.role === "tool") {
          send({ role: "assistant", content: "stub: all done" });
          send({}, "stop");
        } else {
          send({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] });
          send({}, "tool_calls");
        }
        res.write("data: " + JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "stub", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + "\n\n");
        res.end("data: [DONE]\n\n");
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ port: (srv.address() as AddressInfo).port, close: () => srv.close() }));
  });
}

async function launch(command: string, extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-bg-key-"));
  const agentDir = join(root, "agent");
  const work = join(root, "work");
  mkdirSync(agentDir);
  mkdirSync(work);
  const stub = await stubServer(command);
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { stub: { baseUrl: `http://127.0.0.1:${stub.port}/v1`, api: "openai-completions", apiKey: "x", models: [{ id: "stub-1", name: "stub" }] } } }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "stub", defaultModel: "stub-1", quietStartup: true }));
  writeFileSync(join(agentDir, "pi-bg.json"), JSON.stringify({ bgTimeoutSeconds: 0, ...extra, output: { logDir: join(root, "logs") } })); // only the key can move the task
  const sock = `pibg-gated-${process.pid}`;
  const tmux = (...a: string[]) => execFileSync(TMUX!, ["-L", sock, ...a], { encoding: "utf8" });
  tmux("new-session", "-d", "-s", "k", "-x", "110", "-y", "30", "-c", work,
    `env PI_CODING_AGENT_DIR=${agentDir} PI_OFFLINE=1 ${PI_BIN} -e ${EXT} -ne -ns -np -nc --no-mcp --no-session`);
  const screen = () => { try { return tmux("capture-pane", "-p", "-t", "k"); } catch { return ""; } };
  cleanup = async () => {
    try { tmux("kill-server"); } catch { /* already gone */ }
    stub.close();
    await sleep(1500);
    const left = (() => { try { return execFileSync("pgrep", ["-f", "[s]leep 3137"], { encoding: "utf8" }).trim(); } catch { return ""; } })();
    if (left) {
      console.warn(`[gated:key] OBSERVATION: tool child survived tmux kill-server (SIGHUP to pi): pids ${left.split("\n").join(",")}`);
      spawn("pkill", ["-f", "[s]leep 3137"], { stdio: "ignore" });
    }
    rmSync(root, { recursive: true, force: true });
  };
  await until(() => /stub|ctrl|\$|>/.test(screen()) && screen().trim().length > 0, 20_000, "pi TUI to render");
  await sleep(1500);
  return { tmux, screen };
}

describe.skipIf(!!skip)("live move key (real pi CLI in tmux, real pi-bg)", () => {
  it("ctrl+b while a sleep 30 tool runs moves it to the background; the agent continues", async () => {
    const { tmux, screen } = await launch("sleep 3137; echo finished");
    tmux("send-keys", "-t", "k", "-l", "go");
    await sleep(300);
    tmux("send-keys", "-t", "k", "Enter");
    await until(() => /sleep 3137/.test(screen()), 20_000, "the bash tool call to appear");
    await sleep(1500);
    const t0 = Date.now();
    tmux("send-keys", "-t", "k", "C-b");
    await until(() => /stub: all done/.test(screen()), 15_000, "the turn to finish after the move");
    expect(Date.now() - t0).toBeLessThan(10_000); // far below the 30 s sleep
    expect(screen()).toMatch(/bg1/);
    expect(screen()).toMatch(/1 shell/); // footer counts the moved task
  }, 60_000);

  it("idle ctrl+b still moves the editor cursor (negative control)", async () => {
    const { tmux, screen } = await launch("sleep 30");
    tmux("send-keys", "-t", "k", "-l", "abc");
    await sleep(400);
    tmux("send-keys", "-t", "k", "C-b");
    await sleep(300);
    tmux("send-keys", "-t", "k", "-l", "X");
    await sleep(600);
    expect(screen()).toMatch(/abXc/);
  }, 60_000);

  it("a configured `key` (ctrl+g) moves the task; the default ctrl+b is then left alone (negative control)", async () => {
    const { tmux, screen } = await launch("sleep 3137; echo finished", { key: "ctrl+g" });
    tmux("send-keys", "-t", "k", "-l", "go");
    await sleep(300);
    tmux("send-keys", "-t", "k", "Enter");
    await until(() => /sleep 3137/.test(screen()), 20_000, "the bash tool call to appear");
    await sleep(1500);
    tmux("send-keys", "-t", "k", "C-b");
    await sleep(1500);
    expect(screen()).not.toMatch(/1 shell/); // ctrl+b did not move it
    tmux("send-keys", "-t", "k", "C-g");
    await until(() => /stub: all done/.test(screen()), 15_000, "the turn to finish after the move");
    expect(screen()).toMatch(/1 shell/);
  }, 60_000);

  it("Down from the empty editor focuses the footer, Enter opens the shells panel, x kills the selected shell, Esc closes it", async () => {
    const { tmux, screen } = await launch("sleep 3137; echo finished");
    tmux("send-keys", "-t", "k", "-l", "go");
    await sleep(300);
    tmux("send-keys", "-t", "k", "Enter");
    await until(() => /sleep 3137/.test(screen()), 20_000, "the bash tool call to appear");
    await sleep(1500);
    tmux("send-keys", "-t", "k", "C-b");
    await until(() => /stub: all done/.test(screen()) && /1 shell/.test(screen()), 15_000, "the move to the background to finish");
    expect(screen()).not.toMatch(/x kill/); // the panel is not open yet
    tmux("send-keys", "-t", "k", "Down");
    await sleep(500);
    tmux("send-keys", "-t", "k", "Enter");
    await until(() => /x kill/.test(screen()), 10_000, "the shells panel to open");
    expect(screen()).toMatch(/bg1\s+background/);
    tmux("send-keys", "-t", "k", "-l", "x");
    await until(() => /bg1\s+killed/.test(screen()), 15_000, "the selected shell to be killed");
    tmux("send-keys", "-t", "k", "Escape");
    await until(() => !/x kill/.test(screen()), 10_000, "the panel to close");
  }, 90_000);
});
