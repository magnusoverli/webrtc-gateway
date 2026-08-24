export const overviewLayoutKey = "signal-desk.overview-layout.v1";

type StorageLike = Pick<Storage, "getItem" | "setItem">;
type OverviewLayout = "grid" | "list";

export function readOverviewLayout(storage?: StorageLike): OverviewLayout {
  try {
    const layout = (storage ?? window.localStorage).getItem(overviewLayoutKey);
    return layout === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

export function writeOverviewLayout(layout: OverviewLayout, storage?: StorageLike) {
  try {
    (storage ?? window.localStorage).setItem(overviewLayoutKey, layout);
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}
