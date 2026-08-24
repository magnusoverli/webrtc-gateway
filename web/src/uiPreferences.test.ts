import { describe, expect, it } from "vitest";
import { railCollapsedKey, readRailCollapsed, writeRailCollapsed } from "./uiPreferences";

describe("rail preference", () => {
  it("loads and writes the versioned collapse value", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    expect(readRailCollapsed(storage)).toBe(false);
    writeRailCollapsed(true, storage);
    expect(values.get(railCollapsedKey)).toBe("true");
    expect(readRailCollapsed(storage)).toBe(true);
    writeRailCollapsed(false, storage);
    expect(readRailCollapsed(storage)).toBe(false);
  });

  it("falls back safely when browser storage is restricted", () => {
    const storage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    };
    expect(readRailCollapsed(storage)).toBe(false);
    expect(() => writeRailCollapsed(true, storage)).not.toThrow();
  });
});
