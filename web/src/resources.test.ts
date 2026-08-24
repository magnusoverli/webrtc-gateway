import { describe, expect, it } from "vitest";
import { formatCompactBytes, formatResourceMemory, formatResourcePercent, resourceStatusLabel } from "./App";

describe("resource presentation", () => {
  it("distinguishes warming and real zero CPU values", () => {
    expect(formatResourcePercent(null)).toBe("Warming");
    expect(formatResourcePercent(0)).toBe("0.0%");
    expect(formatResourcePercent(8.25)).toBe("8.3%");
    expect(formatResourcePercent(42.6)).toBe("43%");
  });

  it("formats binary memory with and without a finite limit", () => {
    expect(formatCompactBytes(512 * 1024 * 1024)).toBe("512 MiB");
    expect(formatResourceMemory(512 * 1024 * 1024, 8 * 1024 * 1024 * 1024)).toBe("512 MiB / 8.0 GiB");
    expect(formatResourceMemory(512 * 1024 * 1024, null)).toBe("512 MiB");
  });

  it("labels freshness states without turning missing data into zero", () => {
    expect(resourceStatusLabel("ok")).toBe("CURRENT");
    expect(resourceStatusLabel("warming")).toBe("WARMING");
    expect(resourceStatusLabel("stale")).toBe("STALE");
    expect(resourceStatusLabel("unavailable")).toBe("UNAVAILABLE");
    expect(resourceStatusLabel()).toBe("LOADING");
  });
});
