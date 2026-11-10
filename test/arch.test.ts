import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findIllegalCoreImports, type SourceFile } from "../src/arch-check.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function loadCore(): SourceFile[] {
  return walk(path.join(ROOT, "src/core"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ path: path.relative(ROOT, f).split(path.sep).join("/"), source: readFileSync(f, "utf8") }));
}

describe("core import architecture", () => {
  it("src/core imports only relative modules and ../contract", () => {
    expect(findIllegalCoreImports(loadCore())).toEqual([]);
  });

  it("flags the bad fixture when presented as a core file (negative control)", () => {
    const fixture = readFileSync(path.join(ROOT, "test/fixtures/bad-core-import.ts"), "utf8");
    const violations = findIllegalCoreImports([{ path: "src/core/bad.ts", source: fixture }]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: "src/core/bad.ts", specifier: "node:fs" });
    expect(violations[0].reason).toMatch(/port/);
  });

  it("flags bare package specifiers, dynamic imports and re-exports in core", () => {
    const files: SourceFile[] = [
      { path: "src/core/a.ts", source: 'import { x } from "@earendil-works/pi-coding-agent";' },
      { path: "src/core/b.ts", source: 'export * from "lodash";' },
      { path: "src/core/c.ts", source: 'const m = await import("node:path");' },
      { path: "src/core/d.ts", source: 'const r = require("chalk");' },
    ];
    expect(findIllegalCoreImports(files).map((v) => v.specifier)).toEqual([
      "@earendil-works/pi-coding-agent",
      "lodash",
      "node:path",
      "chalk",
    ]);
  });

  it("allows ../contract and relative core modules, and ignores non-core files", () => {
    const files: SourceFile[] = [
      { path: "src/core/ok.ts", source: 'import type { Task } from "../contract.js";\nimport { y } from "./task.js";' },
      { path: "src/adapters/x.ts", source: 'import fs from "node:fs";' },
    ];
    expect(findIllegalCoreImports(files)).toEqual([]);
  });

  it("rejects a relative import that escapes src/core", () => {
    const files: SourceFile[] = [{ path: "src/core/e.ts", source: 'import "../pi/bash-tool.js";' }];
    expect(findIllegalCoreImports(files)).toHaveLength(1);
  });
});
