export type TileSize = { columns: number; rows: number };
export type TilePlacement = TileSize & { id: string; page: number; column: number; row: number };
export type TileSizes = Record<string, TileSize>;
export const defaultTileSize: TileSize = { columns: 1, rows: 1 };

export function multiviewColumnCount(width: number, gap = 10): number {
  return width > 0 ? Math.max(1, Math.min(4, Math.floor((width + gap) / (280 + gap)))) : 4;
}

// Responsive presentation never changes saved sizes, ordering, or page membership.
export function reflowMultiview(placements: TilePlacement[], columns: number): TilePlacement[] {
  columns = Math.max(1, Math.min(4, Math.floor(columns)));
  if (columns === 4) return placements;
  const occupied = new Map<number, Set<number>>();
  return placements.map((tile) => {
    const cells = occupied.get(tile.page) ?? new Set<number>();
    occupied.set(tile.page, cells);
    const width = Math.min(columns, tile.columns);
    for (let row = 0; ; row++) {
      for (let column = 0; column <= columns - Math.ceil(width); column++) {
        const footprint = Array.from({ length: Math.ceil(tile.rows) }, (_, y) =>
          Array.from({ length: Math.ceil(width) }, (_, x) => (row + y) * columns + column + x)).flat();
        if (footprint.some((cell) => cells.has(cell))) continue;
        footprint.forEach((cell) => cells.add(cell));
        return { ...tile, columns: width, column, row };
      }
    }
  });
}

export function sameTileFootprint(a: TileSize, b: TileSize): boolean {
  return Math.ceil(a.columns) === Math.ceil(b.columns) && Math.ceil(a.rows) === Math.ceil(b.rows);
}

export function clampTileSize(size: TileSize): TileSize {
  return {
    columns: Number.isFinite(size.columns) ? Math.round(Math.max(1, Math.min(4, size.columns)) * 1000) / 1000 : 1,
    rows: Number.isFinite(size.rows) ? Math.round(Math.max(1, Math.min(3, size.rows)) * 1000) / 1000 : 1,
  };
}

// Dimensions are continuous; reserve every grid cell the tile touches so its
// neighbours move as soon as it outgrows a slot, without snapping the tile itself.
// First-fit packing within each 4 × 3 page. Never revisit an earlier page:
// the saved order continues to define predictable pagination and move targets.
export function packMultiview(ids: string[], sizes: TileSizes): TilePlacement[] {
  let page = 0;
  let occupied = new Set<number>();
  return ids.map((id) => {
    const size = clampTileSize(Object.hasOwn(sizes, id) ? sizes[id] : defaultTileSize);
    const columns = Math.ceil(size.columns), rows = Math.ceil(size.rows);
    for (;;) {
      for (let row = 0; row <= 3 - rows; row++) {
        for (let column = 0; column <= 4 - columns; column++) {
          const cells = Array.from({ length: rows }, (_, y) =>
            Array.from({ length: columns }, (_, x) => (row + y) * 4 + column + x)).flat();
          if (cells.some((cell) => occupied.has(cell))) continue;
          cells.forEach((cell) => occupied.add(cell));
          return { id, page, column, row, ...size };
        }
      }
      page++;
      occupied = new Set();
    }
  });
}
