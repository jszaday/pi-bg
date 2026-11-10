// Architecture check for the pure core (DESIGN section 2 and TODO section 0).
// src/core may import only relative modules inside src/core and src/contract.ts.
// Anything else (node:*, bare specifiers such as Pi packages or third-party code)
// is an illegal import.

import path from "node:path";

export interface SourceFile {
  path: string; // path relative to the repository root, using "/" separators
  source: string;
}

export interface IllegalImport {
  file: string;
  specifier: string;
  reason: string;
}

const CORE_DIR = "src/core";
const CONTRACT = "src/contract";

// Matches static imports/exports with a module specifier, side-effect imports,
// dynamic import() and require().
const SPECIFIER_PATTERNS: RegExp[] = [
  /\b(?:import|export)\s+(?:type\s+)?[^"'`;]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function specifiersOf(source: string): string[] {
  const found: string[] = [];
  for (const re of SPECIFIER_PATTERNS) {
    for (const m of source.matchAll(re)) found.push(m[1]);
  }
  return found;
}

function isAllowed(file: string, specifier: string): boolean {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return false;
  const target = path.posix
    .normalize(path.posix.join(path.posix.dirname(file), specifier))
    .replace(/\.(?:js|ts)$/, "");
  if (target === CONTRACT) return true;
  return target === CORE_DIR || target.startsWith(CORE_DIR + "/");
}

export function findIllegalCoreImports(files: SourceFile[]): IllegalImport[] {
  const out: IllegalImport[] = [];
  for (const f of files) {
    const file = f.path.split(path.sep).join("/");
    if (!file.startsWith(CORE_DIR + "/")) continue;
    for (const specifier of specifiersOf(f.source)) {
      if (isAllowed(file, specifier)) continue;
      const reason = specifier.startsWith("node:")
        ? "Node built-ins are not allowed in src/core; move the call behind a port in src/adapters."
        : "Only relative imports inside src/core and ../contract are allowed in src/core; import through a port instead.";
      out.push({ file, specifier, reason });
    }
  }
  return out;
}
