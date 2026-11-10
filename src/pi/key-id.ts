// Normalises the `key` config value to a pi-tui KeyId (DESIGN section 7). pi-tui's matchesKey lowercases its argument, requires "+" between
// modifiers and rejects unknown keys by never matching; this copy of the grammar (modifiers ctrl, shift, alt, super, then one base key)
// turns those silent misses into a config warning. The lists are typed against pi-tui's KeyId so a removed key fails the typecheck.
import type { KeyId } from "@earendil-works/pi-tui";

const MODIFIERS = ["ctrl", "shift", "alt", "super"] as const;

const BASE_KEYS: readonly KeyId[] = [
  ..."abcdefghijklmnopqrstuvwxyz0123456789".split("") as KeyId[],
  ..."`-=[]\;',./!@#$%^&*()_+|~{}:<>?".split("") as KeyId[],
  "escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear", "home", "end",
  "pageUp", "pageDown", "up", "down", "left", "right",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
];
const CANONICAL = new Map(BASE_KEYS.map((k) => [k.toLowerCase(), k]));

/** Accepted form, for messages. */
export const KEY_FORM = 'modifiers ctrl, shift, alt or super joined to one key with "+", such as ctrl+b, ctrl+shift+p or alt+enter';

/**
 * Case-insensitive; "+" or "-" may follow a modifier, with optional spaces ("Ctrl-B", "ctrl + b"). Unambiguous because only the four modifier
 * names are stripped as prefixes, so "ctrl--" is ctrl plus the "-" key. Returns the canonical id (modifiers in ctrl, shift, alt, super order), or null.
 */
export function normalizeKey(raw: string): string | null {
  let rest = raw.trim();
  const seen = new Set<string>();
  for (;;) {
    const m = /^(ctrl|shift|alt|super)\s*[+-]\s*/i.exec(rest);
    if (!m) break;
    const mod = m[1].toLowerCase();
    if (seen.has(mod)) return null;
    seen.add(mod);
    rest = rest.slice(m[0].length);
  }
  const base = CANONICAL.get(rest.trim().toLowerCase());
  if (base === undefined) return null;
  return [...MODIFIERS.filter((m) => seen.has(m)), base].join("+");
}
