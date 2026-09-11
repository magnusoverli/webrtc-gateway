const MEDIA_START_TIMEOUT_MS = 12_000;
const MEDIA_STALL_TIMEOUT_MS = 2_000;

type Progress = { identity: string; count: number; lastProgressAt: number; started: boolean };

/** Watches actual inbound media, not ontrack (WHEP can negotiate empty placeholders). */
export class MediaProgressWatchdog {
  private startedAt = 0;
  private video?: Progress;
  private audio?: Progress;

  reset(now: number) {
    this.startedAt = now;
    this.video = undefined;
    this.audio = undefined;
  }

  inspect(report: RTCStatsReport, now: number): string | null {
    const video: Array<{ id: string; count: number }> = [];
    const audio: Array<{ id: string; count: number }> = [];
    report.forEach((entry) => {
      const item = entry as RTCStats & Record<string, unknown>;
      if (item.type !== "inbound-rtp" || item.isRemote === true) return;
      const bytes = finiteCounter(item.bytesReceived);
      if (bytes === undefined || bytes === 0) return;
      const kind = item.kind ?? item.mediaType;
      if (kind === "video") {
        const frames = finiteCounter(item.framesDecoded);
        video.push({ id: `${item.id}:${frames === undefined ? "bytes" : "frames"}`, count: frames ?? bytes });
      } else if (kind === "audio") {
        audio.push({ id: item.id, count: bytes });
      }
    });
    const update = (previous: Progress | undefined, entries: typeof video): Progress | undefined => {
      if (!entries.length) return previous;
      const identity = entries.map((entry) => entry.id).sort().join(",");
      const count = entries.reduce((total, entry) => total + entry.count, 0);
      if (!previous || previous.identity !== identity || count < previous.count) {
        return { identity, count, lastProgressAt: now, started: count > 0 };
      }
      return count > previous.count
        ? { identity, count, lastProgressAt: now, started: true }
        : previous;
    };
    this.video = update(this.video, video);
    this.audio = update(this.audio, audio);
    // Audio continuing must not conceal a frozen video decoder. Conversely,
    // silent/DTX audio must not cause a restart while video is healthy.
    const media = this.video ?? this.audio;
    if (!media) {
      return now - this.startedAt >= MEDIA_START_TIMEOUT_MS ? "No media arrived after WebRTC connected." : null;
    }
    const timeout = media.started ? MEDIA_STALL_TIMEOUT_MS : MEDIA_START_TIMEOUT_MS;
    return now - media.lastProgressAt >= timeout
      ? `${this.video ? "Video decoding" : "Audio reception"} stopped progressing. Reconnecting the media session.`
      : null;
  }
}

function finiteCounter(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
