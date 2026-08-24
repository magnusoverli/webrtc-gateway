export const railCollapsedKey = "signal-desk.rail-collapsed.v1";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function readRailCollapsed(storage: StorageLike = window.localStorage) {
  try {
    return storage.getItem(railCollapsedKey) === "true";
  } catch {
    return false;
  }
}

export function writeRailCollapsed(collapsed: boolean, storage: StorageLike = window.localStorage) {
  try {
    storage.setItem(railCollapsedKey, String(collapsed));
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}
