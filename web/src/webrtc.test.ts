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
      { id: "video", type: "inbound-rtp", kind: "video", timestamp: 2000, bytesReceived: 3000, packetsLost: 2, jitter: 0.004, framesPerSecond: 30, frameWidth: 1280, frameHeight: 720, framesDecoded: 80, framesDropped: 1, codecId: "video-codec" },
      { id: "audio", type: "inbound-rtp", kind: "audio", timestamp: 2000, bytesReceived: 1000, packetsLost: 1, jitter: 0.002, codecId: "audio-codec" },
      { id: "video-codec", type: "codec", mimeType: "video/H264" },
      { id: "audio-codec", type: "codec", mimeType: "audio/opus" },
    ]), { timestamp: 1000, bytesReceived: 2000, videoBytesReceived: 1500, audioBytesReceived: 500 });

    expect(result.stats.bitrateBps).toBe(16000);
    expect(result.stats.video).toMatchObject({ codec: "H264", bitrateBps: 12000, width: 1280, height: 720, framesPerSecond: 30, packetsLost: 2, jitterMs: 4 });
    expect(result.stats.audio).toMatchObject({ codec: "opus", bitrateBps: 4000, packetsLost: 1, jitterMs: 2 });
    expect(result.sample).toEqual({ timestamp: 2000, bytesReceived: 4000, videoBytesReceived: 3000, audioBytesReceived: 1000 });
  });

  it("reports audio-only receiver details", () => {
    const result = summarizeRTCStats(report([
      { id: "audio", type: "inbound-rtp", kind: "audio", timestamp: 2000, bytesReceived: 2000, codecId: "codec" },
      { id: "codec", type: "codec", mimeType: "audio/opus" },
    ]));
    expect(result.stats.video).toBeUndefined();
    expect(result.stats.audio?.codec).toBe("opus");
    expect(result.stats.audio?.bitrateBps).toBeNull();
  });

  it("aggregates multiple inbound streams of the same media kind", () => {
    const result = summarizeRTCStats(report([
      { id: "video-1", type: "inbound-rtp", kind: "video", timestamp: 2000, bytesReceived: 3000, packetsLost: 1, codecId: "codec" },
      { id: "video-2", type: "inbound-rtp", kind: "video", timestamp: 2000, bytesReceived: 2000, packetsLost: 2, codecId: "codec" },
      { id: "codec", type: "codec", mimeType: "video/H264" },
    ]), { timestamp: 1000, bytesReceived: 2000, videoBytesReceived: 2000, audioBytesReceived: 0 });
    expect(result.stats.video).toMatchObject({ codec: "H264", bitrateBps: 24000, packetsLost: 3 });
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
