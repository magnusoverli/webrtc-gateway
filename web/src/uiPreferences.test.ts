import { describe, expect, it } from "vitest";
import { overviewLayoutKey, readOverviewLayout, writeOverviewLayout } from "./uiPreferences";

describe("overview layout preference", () => {
  it("loads and writes the versioned layout value", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    expect(readOverviewLayout(storage)).toBe("grid");
    writeOverviewLayout("list", storage);
    expect(values.get(overviewLayoutKey)).toBe("list");
    expect(readOverviewLayout(storage)).toBe("list");
    writeOverviewLayout("grid", storage);
    expect(readOverviewLayout(storage)).toBe("grid");
  });

  it("falls back to grid for invalid stored values", () => {
    const storage = {
      getItem: () => "tiles",
      setItem: () => undefined,
    };
    expect(readOverviewLayout(storage)).toBe("grid");
  });

  it("falls back safely when browser storage is restricted", () => {
    const storage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    };
    expect(readOverviewLayout(storage)).toBe("grid");
    expect(() => writeOverviewLayout("list", storage)).not.toThrow();
  });
});
