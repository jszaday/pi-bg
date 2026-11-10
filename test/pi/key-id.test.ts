import { matchesKey, type KeyId } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { normalizeKey } from "../../src/pi/key-id.js";

describe("normalizeKey", () => {
  it.each([
    ["ctrl+b", "ctrl+b"],
    ["Ctrl+B", "ctrl+b"],
    ["CTRL-B", "ctrl+b"],
    ["ctrl-b", "ctrl+b"],
    ["ctrl + b", "ctrl+b"],
    ["  ctrl+b ", "ctrl+b"],
    ["shift+ctrl+p", "ctrl+shift+p"],
    ["Alt-Enter", "alt+enter"],
    ["ctrl+PageUp", "ctrl+pageUp"],
    ["ctrl--", "ctrl+-"],
    ["ctrl++", "ctrl++"],
    ["f5", "f5"],
    ["-", "-"],
  ])("%j normalises to %j", (raw, want) => {
    expect(normalizeKey(raw)).toBe(want);
  });

  it.each(["", "ctrl", "ctrl+", "ctrl+bb", "ctrl+ctrl+b", "ctrl+b+c", "ctr+b", "ctrl+nope", "meta+b", "ctrl--b", "ctrl b"])(
    "%j is rejected",
    (raw) => {
      expect(normalizeKey(raw)).toBeNull();
    },
  );

  it("every normalised id is understood by pi-tui: the raw typo forms never match, the normalised forms do", () => {
    const ctrlB = "\x02";
    for (const raw of ["ctrl-b", "ctrl + b", "CTRL+B"]) {
      const id = normalizeKey(raw)!;
      expect(matchesKey(ctrlB, id as KeyId)).toBe(true);
    }
    expect(matchesKey(ctrlB, "ctrl-b" as KeyId)).toBe(false); // why the normaliser exists
    expect(matchesKey(ctrlB, "ctrl+bb" as KeyId)).toBe(false);
  });
});
