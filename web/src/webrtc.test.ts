import { describe, expect, it } from "vitest";
import { codecWarnings, summarizeRTCStats } from "./webrtc";

function report(entries: Array<Record<string, unknown>>) {
  return {
    forEach(callback: (entry: RTCStats) => void) {
      entries.forEach((entry) => callback(entry as unknown as RTCStats));
    },
  } as RTCStatsReport;
}

describe("summarizeRTCStats", () => {
  it("calculates bitrate and video details", () => {
    const result = summarizeRTCStats(report([
      { id: "video", type: "inbound-rtp", kind: "video", timestamp: 2000, bytesReceived: 3000, packetsLost: 2, jitter: 0.004, framesPerSecond: 30, frameWidth: 1280, frameHeight: 720, framesDecoded: 80, framesDropped: 1, codecId: "codec" },
      { id: "audio", type: "inbound-rtp", kind: "audio", timestamp: 2000, bytesReceived: 1000, packetsLost: 1, jitter: 0.002 },
      { id: "codec", type: "codec", mimeType: "video/H264" },
    ]), { timestamp: 1000, bytesReceived: 2000 });

    expect(result.stats.bitrateBps).toBe(16000);
    expect(result.stats.codec).toBe("H264");
    expect(result.stats.width).toBe(1280);
    expect(result.stats.packetsLost).toBe(3);
    expect(result.stats.jitterMs).toBe(4);
  });
});

describe("codecWarnings", () => {
  it("warns only for codecs with uncertain browser support", () => {
    expect(codecWarnings([{ codec: "H264" }, { codec: "Opus" }])).toEqual([]);
    expect(codecWarnings([{ codec: "H265" }, { codec: "MPEG4Audio" }])).toHaveLength(2);
    expect(codecWarnings([{ codec: "H264", codecProps: { profile: "Main" } }, { codec: "MPEG-4 Audio" }])).toEqual([
      "H264 Main may contain B-frames; direct WebRTC requires H264 without B-frames.",
      "AAC is not broadly supported over WebRTC; compatibility mode will be required.",
    ]);
  });
});
