// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { codecWarnings, preferOpusStereo, summarizeRTCStats, waitForICEGathering } from "./webrtc";

afterEach(() => vi.useRealTimers());

describe("preferOpusStereo", () => {
  it.each(["\r\n", "\n"])("requests receive stereo without changing sender declarations or other codecs (%j)", (nl) => {
    const video = ["v=0", "m=video 9 UDP/TLS/RTP/SAVPF 111", "a=rtpmap:111 H264/90000", "a=fmtp:111 profile-level-id=42e01f"].join(nl) + nl;
    const audio = ["m=audio 9 UDP/TLS/RTP/SAVPF 109 0", "a=recvonly", "a=rtpmap:109 opus/48000/2", "a=fmtp:109 minptime=10;stereo=0;useinbandfec=1;sprop-stereo=0", "a=rtpmap:0 PCMU/8000", ""].join(nl);
    const result = preferOpusStereo(video + audio);
    expect(result).toBe(video + audio.replace("stereo=0;", "").replace("sprop-stereo=0", "sprop-stereo=0;stereo=1"));
    expect(preferOpusStereo(result)).toBe(result);
    expect(preferOpusStereo(video)).toBe(video);
  });

  it("adds missing fmtp only to Opus audio and preserves section boundaries", () => {
    const sdp = "m=audio 9 UDP/TLS/RTP/SAVPF 112\r\na=rtpmap:112 opus/48000/2\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n";
    expect(preferOpusStereo(sdp)).toBe(sdp.replace("opus/48000/2\r\n", "opus/48000/2\r\na=fmtp:112 stereo=1\r\n"));
  });
});

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
    ]), { timestamp: 1000, bytesReceived: 2000, videoBytesReceived: 1500, audioBytesReceived: 500, videoFramesDecoded: 50 });

    expect(result.stats.bitrateBps).toBe(16000);
    expect(result.stats.video).toMatchObject({ codec: "H264", bitrateBps: 12000, width: 1280, height: 720, framesPerSecond: 30, packetsLost: 2, jitterMs: 4 });
    expect(result.stats.audio).toMatchObject({ codec: "opus", bitrateBps: 4000, packetsLost: 1, jitterMs: 2 });
    expect(result.sample).toEqual({ timestamp: 2000, bytesReceived: 4000, videoBytesReceived: 3000, audioBytesReceived: 1000, videoFramesDecoded: 80 });
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
    ]), { timestamp: 1000, bytesReceived: 2000, videoBytesReceived: 2000, audioBytesReceived: 0, videoFramesDecoded: 0 });
    expect(result.stats.video).toMatchObject({ codec: "H264", bitrateBps: 24000, packetsLost: 3 });
  });

  it("derives video frame rate from decoded-frame counters when the browser omits it", () => {
    const first = summarizeRTCStats(report([
      { id: "video", type: "inbound-rtp", kind: "video", timestamp: 1000, bytesReceived: 1000, framesDecoded: 60 },
    ]));
    const second = summarizeRTCStats(report([
      { id: "video", type: "inbound-rtp", kind: "video", timestamp: 2000, bytesReceived: 2000, framesDecoded: 90 },
    ]), first.sample);

    expect(first.stats.video?.framesPerSecond).toBe(0);
    expect(second.stats.video?.framesPerSecond).toBe(30);
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

describe("waitForICEGathering", () => {
  it("reports completion and removes its timeout", async () => {
    vi.useFakeTimers();
    const peer = new GatheringPeer();
    const result = waitForICEGathering(peer as unknown as RTCPeerConnection, 5000);

    peer.iceGatheringState = "complete";
    peer.dispatchEvent(new Event("icegatheringstatechange"));

    await expect(result).resolves.toBe("complete");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports timeout without treating gathering as complete", async () => {
    vi.useFakeTimers();
    const peer = new GatheringPeer();
    const result = waitForICEGathering(peer as unknown as RTCPeerConnection, { timeoutMs: 100 });

    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toBe("timeout");
    peer.iceGatheringState = "complete";
    peer.dispatchEvent(new Event("icegatheringstatechange"));
    await expect(result).resolves.toBe("timeout");
  });

  it("reports AbortSignal cancellation and cleans up its timer", async () => {
    vi.useFakeTimers();
    const peer = new GatheringPeer();
    const controller = new AbortController();
    const result = waitForICEGathering(peer as unknown as RTCPeerConnection, {
      timeoutMs: 5000,
      signal: controller.signal,
    });

    controller.abort();

    await expect(result).resolves.toBe("aborted");
    expect(vi.getTimerCount()).toBe(0);
  });
});

class GatheringPeer extends EventTarget {
  iceGatheringState: RTCIceGatheringState = "gathering";
}
