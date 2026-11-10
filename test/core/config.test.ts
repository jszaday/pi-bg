import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, parseConfig } from "../../src/core/config.js";

describe("parseConfig defaults and precedence", () => {
  it("no sources gives the documented defaults, no warnings, and a fresh copy", () => {
    const { config, warnings } = parseConfig({});
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings).toEqual([]);
    expect(config).not.toBe(DEFAULT_CONFIG);
    config.notify.wake = false;
    expect(DEFAULT_CONFIG.notify.wake).toBe(true);
  });
  it("defaults match DESIGN: 30 s, done, steer + wake", () => {
    expect(DEFAULT_CONFIG.bgTimeoutSeconds).toBe(30);
    expect(DEFAULT_CONFIG.notify).toMatchObject({ default: "done", delivery: "steer", wake: true });
  });
  it("global < project < flags, per key, with nested sections merged", () => {
    const { config, warnings } = parseConfig({
      global: { bgTimeoutSeconds: 20, notify: { default: "error", batchMs: 100 }, key: "ctrl+g" },
      project: { bgTimeoutSeconds: 25, notify: { default: "off" } },
      flags: { "bg-timeout": "40", "bg-notify": "done" },
    });
    expect(warnings).toEqual([]);
    expect(config.bgTimeoutSeconds).toBe(40);
    expect(config.notify.default).toBe("done");
    expect(config.notify.batchMs).toBe(100); // global survives where project is silent
    expect(config.key).toBe("ctrl+g");
  });
  it("project beats global when no flag", () => {
    const { config } = parseConfig({ global: { bgTimeoutSeconds: 20 }, project: { bgTimeoutSeconds: 25 } });
    expect(config.bgTimeoutSeconds).toBe(25);
  });
  it("--no-bg disables; flag value 0 is accepted for bg-timeout", () => {
    const { config, warnings } = parseConfig({ flags: { "no-bg": true, "bg-timeout": "0" } });
    expect(config.enabled).toBe(false);
    expect(config.bgTimeoutSeconds).toBe(0);
    expect(warnings).toEqual([]);
  });
  it("accepts every key with a valid value", () => {
    const full = {
      enabled: false, bgTimeoutSeconds: 0,
      notify: { default: "off", delivery: "nextTurn", wake: false, batchMs: 0 },
      key: "ctrl+x", hintAfterMs: 0,
      wait: { defaultTimeoutSeconds: 10, maxTimeoutSeconds: 20 },
      output: { tailLines: 5, maxBytes: 100, ringBytes: 200, maxLogBytes: 300, logRetentionDays: 0, logDir: "/tmp/x" },
      maxRunningTasks: 2, kill: { termGraceMs: 0 },
    };
    const { config, warnings } = parseConfig({ global: full });
    expect(warnings).toEqual([]);
    expect(config).toEqual(full);
  });
});

describe("parseConfig warnings", () => {
  const invalid: [string, unknown][] = [
    ["enabled", "yes"], ["bgTimeoutSeconds", -1], ["bgTimeoutSeconds", "30"],
    ["notify.default", "loud"], ["notify.delivery", "now"], ["notify.wake", 1], ["notify.batchMs", -5],
    ["key", ""], ["hintAfterMs", Number.NaN],
    ["wait.defaultTimeoutSeconds", 0], ["wait.maxTimeoutSeconds", -3],
    ["output.tailLines", 0], ["output.tailLines", 1.5], ["output.maxBytes", "big"], ["output.ringBytes", 0],
    ["output.maxLogBytes", -1], ["output.logRetentionDays", -1], ["output.logDir", ""], ["output.logDir", 5],
    ["maxRunningTasks", 0], ["kill.termGraceMs", -1],
  ];
  it.each(invalid)("invalid %s = %j warns with path, cause and action, and keeps the default", (path, value) => {
    const obj: Record<string, unknown> = {};
    const parts = path.split(".");
    if (parts.length === 1) obj[path] = value; else obj[parts[0]] = { [parts[1]]: value };
    const { config, warnings } = parseConfig({ global: obj });
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`"${path}"`);
    expect(warnings[0]).toContain("global");
    expect(warnings[0]).toMatch(/must be .*; keeping the previous value\. Fix /);
  });
  it("an invalid project value keeps the valid global one", () => {
    const { config, warnings } = parseConfig({ global: { bgTimeoutSeconds: 12 }, project: { bgTimeoutSeconds: "soon" } });
    expect(config.bgTimeoutSeconds).toBe(12);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("project");
  });
  it("unknown keys warn once each, at top level and in sections, and are ignored", () => {
    const { config, warnings } = parseConfig({ global: { bogus: 1, notify: { nope: true }, wait: { x: 1 } } });
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings).toHaveLength(3);
    expect(warnings.join("\n")).toContain('"bogus"');
    expect(warnings.join("\n")).toContain('"notify.nope"');
    expect(warnings.join("\n")).toContain('"wait.x"');
    expect(warnings.every((w) => w.includes("unknown key") && w.includes("Remove it"))).toBe(true);
  });
  it("a section that is not an object warns", () => {
    const { config, warnings } = parseConfig({ global: { notify: "done" } });
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"notify" must be an object');
  });
  it("a source that is not an object is ignored with one warning; null/undefined are silent", () => {
    for (const bad of ["text", 5, [1], true]) {
      const { config, warnings } = parseConfig({ project: bad });
      expect(config).toEqual(DEFAULT_CONFIG);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("must be a JSON object");
      expect(warnings[0]).toContain("project");
    }
    expect(parseConfig({ global: null, project: undefined }).warnings).toEqual([]);
  });
  it("invalid flags warn and are ignored; unknown flags warn", () => {
    const { config, warnings } = parseConfig({
      flags: { "bg-timeout": "abc", "bg-notify": "loud", "no-bg": "yes", "weird": true },
    });
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toContain("--bg-timeout");
    expect(warnings[1]).toContain("--bg-notify");
    expect(warnings[2]).toContain("--no-bg");
    expect(warnings[3]).toContain("unknown flag --weird");
    expect(warnings.every((w) => w.includes("ignor"))).toBe(true);
  });
  it("bg-timeout flag given as a bare switch or empty string is invalid; negatives too", () => {
    for (const v of [true, "", "-3"]) {
      const { config, warnings } = parseConfig({ flags: { "bg-timeout": v } });
      expect(config.bgTimeoutSeconds).toBe(30);
      expect(warnings).toHaveLength(1);
    }
  });
  it("no-bg false and undefined flag values are no-ops", () => {
    const { config, warnings } = parseConfig({ flags: { "no-bg": false, "bg-notify": undefined } });
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings).toEqual([]);
  });
  it("wait default above the maximum is clamped with a warning", () => {
    const { config, warnings } = parseConfig({ global: { wait: { defaultTimeoutSeconds: 500, maxTimeoutSeconds: 200 } } });
    expect(config.wait).toEqual({ defaultTimeoutSeconds: 200, maxTimeoutSeconds: 200 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("exceeds");
  });
});
