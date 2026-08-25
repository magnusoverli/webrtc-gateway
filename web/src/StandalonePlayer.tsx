import { useEffect, useState } from "react";
import { channelHasFault, channelPlaybackReady, channelStateLabel, type Channel } from "./channel";
import { startSerialPolling } from "./polling";
import { requestJSON } from "./request";
import { useWHEPPlayer } from "./useWHEPPlayer";

export type StandaloneRoute =
  | { kind: "viewer" }
  | { kind: "embed"; channelID: string };

export function resolveStandaloneRoute(pathname: string): StandaloneRoute | null {
  if (/^\/view\/?$/.test(pathname)) {
    return { kind: "viewer" };
  }
  const match = pathname.match(/^\/(view|embed)\/([^/]+)\/?$/);
  if (!match) return null;
  try {
    const channelID = decodeURIComponent(match[2]);
    return match[1] === "view"
      ? { kind: "viewer" }
      : { kind: "embed", channelID };
  } catch {
    return null;
  }
}

export function initializeStandaloneRoute(pathname: string, root = document.documentElement) {
  const route = resolveStandaloneRoute(pathname);
  root.classList.toggle("embed-document", route?.kind === "embed");
  return route;
}

export function ChannelViewer() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let disposed = false;
    const load = async (signal: AbortSignal) => {
      try {
        const { response, body } = await requestJSON<unknown>("/api/v1/channels", { cache: "no-store", signal });
        if (!response.ok) throw new Error(apiErrorMessage(body, response.status, "Channel request failed"));
        if (!isChannelList(body)) throw new Error("Gateway channel response was malformed");
        if (disposed) return;
        setChannels(body.channels);
        setLoaded(true);
        setLoadError("");
      } catch (error) {
        if (!disposed && !signal.aborted) {
          setLoadError(error instanceof Error ? error.message : "Channel status is unavailable");
        }
        throw error;
      }
    };

    const stopPolling = startSerialPolling(load, 2_000);
    return () => {
      disposed = true;
      stopPolling();
    };
  }, []);

  const liveChannels = channels.filter(channelPlaybackReady).length;
  const summary = loadError
    ? "Channel status unavailable · existing sessions continue"
    : !loaded
      ? "Loading channel status"
      : channels.length === 0
        ? "No channels configured"
        : `${channels.length} ${channels.length === 1 ? "channel" : "channels"} · ${liveChannels} live`;
  return (
    <main className="standalone-player viewer-player multiview-player">
      <header className="viewer-header">
        <div className="viewer-brand"><span>SD</span><small>Signal Desk</small></div>
        <div>
          <h1>Channel multiview</h1>
          <p>{summary}</p>
        </div>
      </header>
      <div className="multiview-content">
        {loadError && <div className="multiview-notice" role="alert">{loadError}. Status polling will retry automatically.</div>}
        <MultiviewGrid channels={channels} loaded={loaded} />
      </div>
      <footer className="viewer-footer"><span className={liveChannels > 0 ? "signal online" : "signal"} />Live LAN WebRTC · {liveChannels} active</footer>
    </main>
  );
}

export function MultiviewGrid({ channels, loaded }: { channels: Channel[]; loaded: boolean }) {
  return (
    <section className="multiview-grid" aria-label="All channels">
      {channels.map((channel) => <MultiviewTile key={channel.id} channel={channel} />)}
      {loaded && channels.length === 0 && <div className="multiview-empty">Create a channel in Signal Desk. It will appear here automatically.</div>}
      {!loaded && channels.length === 0 && <div className="multiview-empty">Reading live output status.</div>}
    </section>
  );
}

export function StandalonePlayer({ channelID }: { channelID: string }) {
  const [channel, setChannel] = useState<Channel | null>(null);

  useEffect(() => {
    let disposed = false;
    const load = async (signal: AbortSignal) => {
      try {
        const { response, body } = await requestJSON<unknown>(`/api/v1/channels/${encodeURIComponent(channelID)}`, {
          cache: "no-store",
          signal,
        });
        if (response.status === 404 || response.status === 410) {
          if (!disposed) setChannel(null);
          return;
        }
        if (!response.ok) {
          throw new Error(apiErrorMessage(body, response.status, "Channel request failed"));
        }
        if (!isChannel(body)) throw new Error("Gateway channel response was malformed");
        if (disposed) return;
        setChannel(body);
      } catch (error) {
        if (disposed || signal.aborted) throw error;
        // Retain the last definitive state so an established WHEP session is not interrupted.
        throw error;
      }
    };

    const stopPolling = startSerialPolling(load, 2_000);
    return () => {
      disposed = true;
      stopPolling();
    };
  }, [channelID]);

  return <EmbeddedVideo channel={channel} />;
}

function MultiviewTile({ channel }: { channel: Channel }) {
  const playable = channelPlaybackReady(channel);
  const player = useWHEPPlayer({
    whepPath: channel?.whepPath ?? "",
    enabled: playable,
    retry: true,
  });
  const stateLabel = channelStateLabel(channel);
  const showAudioOnly = Boolean(playable && player.state === "playing" && player.hasAudio && !player.hasVideo);

  return (
    <article className={`multiview-tile${playable ? " live" : ""}`}>
      <header className="multiview-tile-header">
        <div><span className={channelHasFault(channel) ? "signal fault" : playable ? "signal online" : "signal"} /><h2>{channel.name}</h2></div>
        <small>{stateLabel}</small>
      </header>
      <section className="standalone-stage" aria-label={`${channel.name} player`}>
        <video ref={player.videoRef} autoPlay playsInline muted controls aria-label={`${channel.name} video`} />
        {showAudioOnly && <PlayerMessage code="AUD" title="Audio-only stream" detail="Audio is playing. This channel does not currently include a video track." />}
        {!playable && <PlayerMessage code={stateCode(channel)} title={stateLabel} detail={offlineDetail(channel)} error={channelHasFault(channel)} />}
        {playable && player.state === "connecting" && <PlayerMessage code="ICE" title="Connecting" detail="Establishing a WebRTC media session." pulse />}
        {playable && player.state === "error" && <PlayerMessage code="ERR" title="Playback interrupted" detail={`${player.error} Retrying automatically.`} error />}
        {playable && player.state === "playing" && !player.hasVideo && !player.hasAudio && <PlayerMessage code="LIVE" title="Connected" detail="Waiting for media tracks." pulse />}
      </section>
    </article>
  );
}

function EmbeddedVideo({ channel }: { channel: Channel | null }) {
  const player = useWHEPPlayer({
    whepPath: channel?.whepPath ?? "",
    enabled: channelPlaybackReady(channel),
    retry: true,
  });
  return (
    <main className="standalone-player embed-player" aria-label={channel ? `${channel.name} embedded player` : "Embedded channel player"}>
      <video ref={player.videoRef} autoPlay playsInline muted aria-label={channel ? `${channel.name} embedded video` : "Embedded channel video"} />
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
    <div className={`preview-message standalone-message${error ? " error-message" : ""}`} role={error ? "alert" : "status"} aria-live={error ? "assertive" : "polite"}>
      <span className={`preview-icon${pulse ? " pulse" : ""}`}>{code}</span>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

function stateCode(channel: Channel) {
  if (channelHasFault(channel)) return "ERR";
  if (channel.available && channel.online) return "PREP";
  return "OFF";
}

function offlineDetail(channel: Channel) {
  if (channel.applyState === "deleting") return "This channel is being deleted.";
  if (!channel.enabled) return "This channel is disabled.";
  if (channel.applyState === "error") return channel.applyError ?? "The channel configuration could not be applied.";
  if (channel.compatibility.state === "error") return channel.compatibility.lastError ?? "A browser-compatible output is unavailable.";
  if (channel.relay?.state === "retrying" || channel.relay?.state === "stopped") return channel.relay.lastError ?? "The SRT listener process is unavailable.";
  if (channel.available && channel.online) return "The encoder is connected and the browser-compatible output is being prepared.";
  return "The player will start automatically when output becomes ready.";
}

function isChannelList(value: unknown): value is { channels: Channel[] } {
  if (!value || typeof value !== "object" || !Array.isArray((value as { channels?: unknown }).channels)) return false;
  return (value as { channels: unknown[] }).channels.every(isChannel);
}

function isChannel(value: unknown): value is Channel {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Channel>;
  return typeof item.id === "string" && typeof item.revision === "number" && item.revision >= 1 &&
    typeof item.createdAt === "string" && typeof item.updatedAt === "string" && typeof item.name === "string" &&
    typeof item.whepPath === "string" && typeof item.enabled === "boolean" &&
    typeof item.outputReady === "boolean" && item.applyState !== undefined &&
    Boolean(item.input && typeof item.input.mode === "string") &&
    Boolean(item.compatibility && typeof item.compatibility.state === "string" && Array.isArray(item.compatibility.reasons) && item.compatibility.worker) &&
    Array.isArray(item.readers);
}

function apiErrorMessage(body: unknown, status: number, fallback: string) {
  if (typeof body === "string" && body) return body;
  if (body && typeof body === "object") {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string" && error) return error;
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message) return message;
    }
  }
  return `${fallback} with ${status}`;
}
