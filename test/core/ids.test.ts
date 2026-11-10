import { describe, expect, it } from "vitest";
import { createIdAllocator, idNumber, seedFromBranch } from "../../src/core/ids.js";

describe("createIdAllocator", () => {
  it("allocates bg1, bg2, ... monotonically", () => {
    const a = createIdAllocator();
    expect([a.next(), a.next(), a.next()]).toEqual(["bg1", "bg2", "bg3"]);
    expect(a.seed).toBe(0);
  });
  it("starts above the seed and keeps the seed constant", () => {
    const a = createIdAllocator(7);
    expect(a.next()).toBe("bg8");
    expect(a.next()).toBe("bg9");
    expect(a.seed).toBe(7);
  });
  it("ignores an invalid seed (negative, fractional, NaN)", () => {
    for (const bad of [-3, 2.5, Number.NaN, Infinity]) {
      const a = createIdAllocator(bad);
      expect(a.next()).toBe("bg1");
      expect(a.seed).toBe(0);
    }
  });
  it("never reuses an id across allocators seeded from the previous maximum", () => {
    const first = createIdAllocator();
    const used = [first.next(), first.next(), first.next()];
    const second = createIdAllocator(seedFromBranch(used));
    expect(used).not.toContain(second.next());
  });
});

describe("seedFromBranch", () => {
  it("returns the highest N across texts", () => {
    expect(seedFromBranch(["moved to bg3 and bg12", "bg7"])).toBe(12);
  });
  it("returns 0 when no id is present", () => {
    expect(seedFromBranch([])).toBe(0);
    expect(seedFromBranch(["nothing here", "bg", "bgx9"])).toBe(0);
  });
  it("does not match ids embedded in longer words (negative control)", () => {
    expect(seedFromBranch(["abg5", "bg5x", "bg_5", "xbg99"])).toBe(0);
    expect(seedFromBranch(["(bg5)", "id=bg6,", "bg7."])).toBe(7);
  });
  it("skips numbers beyond the safe integer range", () => {
    expect(seedFromBranch(["bg99999999999999999999", "bg4"])).toBe(4);
  });
});

describe("idNumber", () => {
  it("parses only whole ids", () => {
    expect(idNumber("bg12")).toBe(12);
    expect(idNumber("bg")).toBeUndefined();
    expect(idNumber("x bg1")).toBeUndefined();
  });
});
