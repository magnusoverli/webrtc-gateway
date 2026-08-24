import { describe, expect, it } from "vitest";
import { formatBitrate, inputModeLabel } from "./presentation";

describe("formatBitrate", () => {
  it("reports an unavailable measurement", () => {
    expect(formatBitrate(null)).toBe("Measuring");
    expect(formatBitrate(undefined)).toBe("Measuring");
  });

  it("formats bps, kbps, and Mbps at the existing thresholds", () => {
    expect(formatBitrate(999.4)).toBe("999 bps");
    expect(formatBitrate(1000)).toBe("1.0 kbps");
    expect(formatBitrate(999_999)).toBe("1000.0 kbps");
    expect(formatBitrate(1_000_000)).toBe("1.00 Mbps");
    expect(formatBitrate(12_345_678)).toBe("12.35 Mbps");
  });
});

describe("inputModeLabel", () => {
  it("labels every supported input mode", () => {
    expect(inputModeLabel("srt-push")).toBe("SRT push");
    expect(inputModeLabel("srt-pull")).toBe("SRT pull");
    expect(inputModeLabel("rtp-unicast")).toBe("RTP unicast");
    expect(inputModeLabel("rtp-multicast")).toBe("RTP multicast");
  });
});
