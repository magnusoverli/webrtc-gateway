import { describe, expect, it } from "vitest";
import { clampTileSize, packMultiview, reflowMultiview, multiviewColumnCount } from "./multiviewLayout";

describe("multiview cell packing", () => {
  const ids = Array.from({ length: 25 }, (_, i) => String(i));

  it("uses a readable minimum width to choose one through four columns", () => {
    expect([390, 650, 1000, 1440].map((width) => multiviewColumnCount(width))).toEqual([1, 2, 3, 4]);
    expect(multiviewColumnCount(0)).toBe(4);
  });

  it.each([1, 2, 3])("reflows %i columns without changing pages or saved sizes", (columns) => {
    const saved = { "0": { columns: 2.5, rows: 1.2 }, "10": { columns: 4, rows: 2 } };
    const original = packMultiview(ids, saved);
    const tiles = reflowMultiview(original, columns);
    expect(tiles.map(({ id, page }) => ({ id, page }))).toEqual(original.map(({ id, page }) => ({ id, page })));
    expect(tiles[0].columns).toBe(Math.min(columns, 2.5));
    const cells = new Set<string>();
    for (const tile of tiles) {
      expect(tile.column + Math.ceil(tile.columns)).toBeLessThanOrEqual(columns);
      for (let y = tile.row; y < tile.row + Math.ceil(tile.rows); y++) for (let x = tile.column; x < tile.column + Math.ceil(tile.columns); x++) {
        const key = `${tile.page}:${x}:${y}`;
        expect(cells.has(key)).toBe(false);
        cells.add(key);
      }
    }
    expect(saved["0"]).toEqual({ columns: 2.5, rows: 1.2 });
    expect(reflowMultiview(original, 4)).toEqual(original);
  });

  it("retains the original twelve-tile pages at default size", () => {
    const tiles = packMultiview(ids, {});
    tiles.forEach((tile, i) => expect(tile).toEqual({ id: String(i), page: Math.floor(i / 12), column: i % 4, row: Math.floor(i % 12 / 4), columns: 1, rows: 1 }));
  });

  it("displaces neighbors and carries overflow onto the following page", () => {
    const tiles = packMultiview(ids, { "0": { columns: 2, rows: 2 } });
    expect(tiles[0]).toMatchObject({ column: 0, row: 0, columns: 2, rows: 2 });
    expect(tiles[1]).toMatchObject({ column: 2, row: 0 });
    expect(tiles.filter((tile) => tile.page === 0)).toHaveLength(9);
    expect(tiles[9]).toMatchObject({ page: 1, column: 0, row: 0 });
  });

  it("retains fractional dimensions and reserves space as soon as a tile outgrows a cell", () => {
    const tiles = packMultiview(ids, { "0": { columns: 1.01, rows: 1.35 } });
    expect(tiles[0]).toMatchObject({ columns: 1.01, rows: 1.35, column: 0, row: 0 });
    expect(tiles[1]).toMatchObject({ column: 2, row: 0 });
    expect(tiles.filter((tile) => tile.page === 0)).toHaveLength(9);
    expect(clampTileSize({ columns: 2.357, rows: 1.123 })).toEqual({ columns: 2.357, rows: 1.123 });
  });

  it("never overlaps, loses a tile, or exceeds page bounds across mixed sizes", () => {
    for (let seed = 0; seed < 24; seed++) {
      const sizes = Object.fromEntries(ids.map((id, i) => [id, { columns: (i + seed) % 4 + 1, rows: (i * 7 + seed) % 3 + 1 }]));
      const tiles = packMultiview(ids, sizes);
      expect(tiles.map((tile) => tile.id)).toEqual(ids);
      const cells = new Set<string>();
      for (const tile of tiles) {
        expect(tile.column + tile.columns).toBeLessThanOrEqual(4);
        expect(tile.row + tile.rows).toBeLessThanOrEqual(3);
        for (let y = tile.row; y < tile.row + tile.rows; y++) for (let x = tile.column; x < tile.column + tile.columns; x++) {
          const key = `${tile.page}:${x}:${y}`;
          expect(cells.has(key)).toBe(false);
          cells.add(key);
        }
      }
    }
  });

  it("handles limits and channel IDs that match object prototype keys", () => {
    expect(clampTileSize({ columns: 99, rows: -1 })).toEqual({ columns: 4, rows: 1 });
    expect(clampTileSize({ columns: NaN, rows: Infinity })).toEqual({ columns: 1, rows: 1 });
    expect(packMultiview(["toString", "__proto__"], {}).map((tile) => tile.columns)).toEqual([1, 1]);
  });
});
