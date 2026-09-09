// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { multiviewOrderKey, overviewLayoutKey, readMultiviewOrder, readOverviewLayout, writeMultiviewOrder, writeOverviewLayout, multiviewSizesKey, readMultiviewSizes, writeMultiviewSizes } from "./uiPreferences";

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("multiview size preferences", () => {
  it("round-trips sizes independently of saved order", () => {
    writeMultiviewOrder(["north", "south"]);
    writeMultiviewSizes({ north: { columns: 1.375, rows: 2.125 } });
    expect(readMultiviewSizes()).toEqual({ north: { columns: 1.375, rows: 2.125 } });
    expect(readMultiviewOrder()).toEqual(["north", "south"]);
  });

  it.each(["null", "[]", "broken", "42", '{"north":null}', '{"north":{"columns":5,"rows":1}}', '{"north":{"columns":1,"rows":0}}', '{"north":{"columns":"1.5","rows":1}}'])
    ("ignores invalid size data %s", (value) => {
      localStorage.setItem(multiviewSizesKey, value);
      expect(readMultiviewSizes()).toEqual({});
    });

  it("works with blocked storage", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new Error("blocked"); });
    expect(readMultiviewSizes()).toEqual({});
    expect(() => writeMultiviewSizes({ north: { columns: 2, rows: 2 } })).not.toThrow();
  });
});

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

describe("multiview order preference", () => {
  it("round-trips channel IDs under its own versioned browser key", () => {
    expect(readMultiviewOrder()).toEqual([]);
    writeOverviewLayout("list");
    const ids = ["channel-12", "channel-2", "channel-1"];
    writeMultiviewOrder(ids);
    expect(localStorage.getItem(multiviewOrderKey)).toBe(JSON.stringify(ids));
    expect(readMultiviewOrder()).toEqual(ids);
    expect(readOverviewLayout()).toBe("list");
    writeMultiviewOrder([]);
    expect(readMultiviewOrder()).toEqual([]);
    expect(localStorage.getItem(multiviewOrderKey)).toBe("[]");
  });

  it("supports injected storage without touching browser preferences", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    expect(readMultiviewOrder(storage)).toEqual([]);
    writeMultiviewOrder(["south", "north"], storage);
    expect(values.get(multiviewOrderKey)).toBe('["south","north"]');
    expect(readMultiviewOrder(storage)).toEqual(["south", "north"]);
    expect(localStorage.getItem(multiviewOrderKey)).toBeNull();
  });

  it.each(["", "{broken", "null", "true", "42", '"channel-1"', '{}', '{"ids":["channel-1"]}', '["valid",null]', '["valid",1]', '["valid",false]', '["valid",{}]', '["valid",[]]', '["valid",""]'])
    ("ignores invalid persisted order %s without overwriting it", (value) => {
      localStorage.setItem(multiviewOrderKey, value);
      expect(readMultiviewOrder()).toEqual([]);
      expect(localStorage.getItem(multiviewOrderKey)).toBe(value);
    });

  it("deduplicates IDs in first-occurrence order without mutating stored data", () => {
    const saved = '["south","north","south","east","north"]';
    localStorage.setItem(multiviewOrderKey, saved);
    const order = readMultiviewOrder();
    expect(order).toEqual(["south", "north", "east"]);
    order.reverse();
    expect(readMultiviewOrder()).toEqual(["south", "north", "east"]);
    expect(localStorage.getItem(multiviewOrderKey)).toBe(saved);
  });

  it("falls back safely when injected storage is restricted", () => {
    const storage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("quota exceeded"); },
    };
    expect(readMultiviewOrder(storage)).toEqual([]);
    expect(() => writeMultiviewOrder(["north"], storage)).not.toThrow();
  });

  it("handles a browser that denies access to localStorage itself", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    expect(readMultiviewOrder()).toEqual([]);
    expect(() => writeMultiviewOrder(["north"])).not.toThrow();
  });
});
