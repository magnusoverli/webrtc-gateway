export const overviewLayoutKey = "signal-desk.overview-layout.v1";
export const multiviewOrderKey = "signal-desk.multiview-order.v1";

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

export function readMultiviewOrder(storage?: StorageLike): string[] {
  try {
    const value: unknown = JSON.parse((storage ?? window.localStorage).getItem(multiviewOrderKey) ?? "[]");
    return Array.isArray(value) && value.every((id) => typeof id === "string" && id.length > 0)
      ? [...new Set(value)] : [];
  } catch {
    return [];
  }
}

export function writeMultiviewOrder(ids: string[], storage?: StorageLike) {
  try {
    (storage ?? window.localStorage).setItem(multiviewOrderKey, JSON.stringify(ids));
  } catch {
    // Keep the current arrangement usable when browser storage is restricted.
  }
}
