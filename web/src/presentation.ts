import type { InputMode } from "./channel";

const inputModeLabels: Record<InputMode, string> = {
  "srt-push": "SRT push",
  "srt-pull": "SRT pull",
  "rtp-unicast": "RTP unicast",
  "rtp-multicast": "RTP multicast",
};

export function inputModeLabel(mode: InputMode) {
  return inputModeLabels[mode];
}

export function formatBitrate(bitsPerSecond: number | null | undefined) {
  if (bitsPerSecond === null || bitsPerSecond === undefined) return "Measuring";
  if (bitsPerSecond < 1000) return `${Math.round(bitsPerSecond)} bps`;
  if (bitsPerSecond < 1_000_000) return `${(bitsPerSecond / 1000).toFixed(1)} kbps`;
  return `${(bitsPerSecond / 1_000_000).toFixed(2)} Mbps`;
}
