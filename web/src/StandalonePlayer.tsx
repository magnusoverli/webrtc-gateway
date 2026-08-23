import { useEffect, useState } from "react";
import { channelStateLabel, type Channel } from "./channel";
import { useWHEPPlayer } from "./useWHEPPlayer";

export function StandalonePlayer({ channelID, embed }: { channelID: string; embed: boolean }) {
  const [channel, setChannel] = useState<Channel | null>(null);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let disposed = false;
    let loading = false;
    const abort = new AbortController();

    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const response = await fetch(`/api/v1/channels/${encodeURIComponent(channelID)}`, {
          cache: "no-store",
          signal: abort.signal,
        });
        if (!response.ok) {
          const result = await response.json().catch(() => ({})) as { error?: string };
          throw new Error(result.error ?? `Channel request failed with ${response.status}`);
        }
        const next = await response.json() as Channel;
        if (disposed) return;
        setChannel(next);
        setLoadError("");
      } catch (error) {
        if (disposed || abort.signal.aborted) return;
        setLoadError(error instanceof Error ? error.message : "Channel status is unavailable");
        setChannel((current) => current ? { ...current, available: false, online: false, outputReady: false } : null);
      } finally {
        loading = false;
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), 2_000);
    return () => {
      disposed = true;
      abort.abort();
      window.clearInterval(timer);
    };
  }, [channelID]);

  const player = useWHEPPlayer({
    whepPath: channel?.whepPath ?? "",
    enabled: Boolean(channel?.outputReady),
    retry: true,
  });
  const stateLabel = channel ? channelStateLabel(channel) : loadError || "Loading channel";
  const showAudioOnly = Boolean(channel?.outputReady && player.state === "playing" && player.hasAudio && !player.hasVideo);

  return (
    <main className={embed ? "standalone-player embed-player" : "standalone-player viewer-player"}>
      {!embed && (
        <header className="viewer-header">
          <div className="viewer-brand"><span>SD</span><small>Signal Desk</small></div>
          <div>
            <h1>{channel?.name ?? "Signal Desk viewer"}</h1>
            <p>{stateLabel}</p>
          </div>
        </header>
      )}
      <section className="standalone-stage" aria-label={channel ? `${channel.name} player` : "Channel player"}>
        <video ref={player.videoRef} autoPlay playsInline muted controls />
        <div className="scanline" />
        {showAudioOnly && <PlayerMessage code="AUD" title="Audio-only stream" detail="Audio is playing. This channel does not currently include a video track." />}
        {!channel && <PlayerMessage code={loadError ? "ERR" : "..."} title={loadError || "Loading channel"} detail={loadError ? "The player will keep retrying." : "Reading live output status."} error={Boolean(loadError)} />}
        {channel && loadError && <PlayerMessage code="ERR" title="Status unavailable" detail={`${loadError}. The player will keep retrying.`} error />}
        {channel && !loadError && !channel.outputReady && <PlayerMessage code={stateCode(channel)} title={stateLabel} detail={offlineDetail(channel)} error={channel.applyState === "error" || channel.compatibility.state === "error"} />}
        {channel?.outputReady && player.state === "connecting" && <PlayerMessage code="ICE" title="Connecting" detail="Establishing a WebRTC media session." pulse />}
        {channel?.outputReady && player.state === "error" && <PlayerMessage code="ERR" title="Playback interrupted" detail={`${player.error} Retrying automatically.`} error />}
        {channel?.outputReady && player.state === "playing" && !player.hasVideo && !player.hasAudio && <PlayerMessage code="LIVE" title="Connected" detail="Waiting for media tracks." pulse />}
      </section>
      {!embed && <footer className="viewer-footer"><span className={channel?.outputReady ? "signal online" : "signal"} />Live LAN WebRTC</footer>}
    </main>
  );
}

function PlayerMessage({ code, title, detail, error = false, pulse = false }: {
  code: string;
  title: string;
  detail: string;
  error?: boolean;
  pulse?: boolean;
}) {
  return (
    <div className={`preview-message standalone-message${error ? " error-message" : ""}`}>
      <span className={`preview-icon${pulse ? " pulse" : ""}`}>{code}</span>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

function stateCode(channel: Channel) {
  if (channel.applyState === "error" || channel.compatibility.state === "error") return "ERR";
  if (channel.available && channel.online) return "PREP";
  return "OFF";
}

function offlineDetail(channel: Channel) {
  if (channel.applyState === "error") return channel.applyError ?? "The channel configuration could not be applied.";
  if (channel.compatibility.state === "error") return channel.compatibility.lastError ?? "A browser-compatible output is unavailable.";
  if (channel.available && channel.online) return "The encoder is connected and the browser-compatible output is being prepared.";
  return "The player will start automatically when output becomes ready.";
}
