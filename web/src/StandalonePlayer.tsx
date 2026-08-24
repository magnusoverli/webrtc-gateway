import { useEffect, useState, type ReactNode } from "react";
import { channelHasFault, channelStateLabel, type Channel } from "./channel";
import { startSerialPolling } from "./polling";
import { useWHEPPlayer } from "./useWHEPPlayer";

export type StandaloneRoute =
  | { kind: "viewer"; initialChannelID: string }
  | { kind: "embed"; channelID: string };

export function resolveStandaloneRoute(pathname: string, search = ""): StandaloneRoute | null {
  if (/^\/view\/?$/.test(pathname)) {
    return { kind: "viewer", initialChannelID: new URLSearchParams(search).get("channel") ?? "" };
  }
  const match = pathname.match(/^\/(view|embed)\/([^/]+)\/?$/);
  if (!match) return null;
  try {
    const channelID = decodeURIComponent(match[2]);
    return match[1] === "view"
      ? { kind: "viewer", initialChannelID: channelID }
      : { kind: "embed", channelID };
  } catch {
    return null;
  }
}

export function selectViewerChannelID(channels: ReadonlyArray<Pick<Channel, "id">>, current: string) {
  return current || channels[0]?.id || "";
}

export function channelPlaybackReady(channel: Pick<Channel, "enabled" | "applyState" | "outputReady"> | null) {
  return Boolean(channel?.enabled && channel.applyState !== "deleting" && channel.outputReady);
}

export function ChannelViewer({ initialChannelID = "" }: { initialChannelID?: string }) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedID, setSelectedID] = useState(initialChannelID);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let disposed = false;
    const load = async (signal: AbortSignal) => {
      try {
        const response = await fetch("/api/v1/status", { cache: "no-store", signal });
        if (!response.ok) throw new Error(`Gateway status request failed with ${response.status}`);
        const next = await response.json() as { channels: Channel[] };
        if (!Array.isArray(next.channels)) throw new Error("Gateway status did not include channels");
        if (disposed) return;
        setChannels(next.channels);
        setSelectedID((current) => selectViewerChannelID(next.channels, current));
        setLoaded(true);
        setLoadError("");
      } catch (error) {
        if (!disposed && !signal.aborted) {
          setLoadError(error instanceof Error ? error.message : "Channel status is unavailable");
        }
      }
    };

    const stopPolling = startSerialPolling(load, 2_000);
    return () => {
      disposed = true;
      stopPolling();
    };
  }, []);

  useEffect(() => {
    if (!selectedID) return;
    const location = `/view?channel=${encodeURIComponent(selectedID)}`;
    if (`${window.location.pathname}${window.location.search}` !== location) {
      window.history.replaceState(null, "", location);
    }
  }, [selectedID]);

  const selected = channels.find((channel) => channel.id === selectedID) ?? null;
  return (
    <PlayerFrame
      channel={selected}
      loadError={loadError}
      empty={loaded && channels.length === 0 && !selectedID}
      missing={loaded && Boolean(selectedID) && !selected}
      navigation={
        <ChannelNavigation
          channels={channels}
          selectedID={selectedID}
          loaded={loaded}
          loadError={loadError}
          onSelect={setSelectedID}
        />
      }
    />
  );
}

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

  return <PlayerFrame channel={channel} loadError={loadError} embed={embed} />;
}

function ChannelNavigation({ channels, selectedID, loaded, loadError, onSelect }: {
  channels: Channel[];
  selectedID: string;
  loaded: boolean;
  loadError: string;
  onSelect: (channelID: string) => void;
}) {
  return (
    <nav className="viewer-channel-nav" aria-label="Select channel">
      <span className="viewer-channel-label">Channels</span>
      <div className="viewer-channel-options">
        {channels.map((channel) => {
          const state = channelStateLabel(channel);
          const signal = channelHasFault(channel) ? "signal fault" : channelPlaybackReady(channel) ? "signal online" : "signal";
          return (
            <button
              key={channel.id}
              className={`viewer-channel-option${channel.id === selectedID ? " active" : ""}`}
              type="button"
              aria-label={`${channel.name}, ${state}`}
              aria-pressed={channel.id === selectedID}
              title={`${channel.name} - ${state}`}
              onClick={() => onSelect(channel.id)}
            >
              <span className={signal} />
              <span>{channel.name}</span>
            </button>
          );
        })}
        {channels.length === 0 && (
          <span className="viewer-channel-empty">
            {loadError || (loaded ? "No channels configured" : "Loading channels")}
          </span>
        )}
      </div>
    </nav>
  );
}

function PlayerFrame({ channel, loadError, embed = false, empty = false, missing = false, navigation }: {
  channel: Channel | null;
  loadError: string;
  embed?: boolean;
  empty?: boolean;
  missing?: boolean;
  navigation?: ReactNode;
}) {
  const playable = channelPlaybackReady(channel);
  const player = useWHEPPlayer({
    whepPath: channel?.whepPath ?? "",
    enabled: playable,
    retry: true,
  });
  const stateLabel = channel
    ? channelStateLabel(channel)
    : loadError || (missing ? "Channel unavailable" : empty ? "No channels configured" : "Loading channel");
  const showAudioOnly = Boolean(playable && player.state === "playing" && player.hasAudio && !player.hasVideo);

  return (
    <main className={embed ? "standalone-player embed-player" : `standalone-player viewer-player${navigation ? " multi-viewer-player" : ""}`}>
      {!embed && (
        <header className="viewer-header">
          <div className="viewer-brand"><span>SD</span><small>Signal Desk</small></div>
          <div>
            <h1>{channel?.name ?? "Signal Desk viewer"}</h1>
            <p>{stateLabel}</p>
          </div>
        </header>
      )}
      {navigation}
      <section className="standalone-stage" aria-label={channel ? `${channel.name} player` : "Channel player"}>
        <video ref={player.videoRef} autoPlay playsInline muted controls />
        {showAudioOnly && <PlayerMessage code="AUD" title="Audio-only stream" detail="Audio is playing. This channel does not currently include a video track." />}
        {!channel && <PlayerMessage
          code={loadError ? "ERR" : missing ? "MISS" : empty ? "NONE" : "..."}
          title={loadError || (missing ? "Channel unavailable" : empty ? "No channels configured" : "Loading channel")}
          detail={loadError
            ? "The player will keep retrying."
            : missing
              ? "The selected channel does not exist. Choose another channel above."
              : empty
                ? "Create a channel in Signal Desk. It will appear here automatically."
                : "Reading live output status."}
          error={Boolean(loadError)}
        />}
        {channel && loadError && <PlayerMessage code="ERR" title="Status unavailable" detail={`${loadError}. The player will keep retrying.`} error />}
        {channel && !loadError && !playable && <PlayerMessage code={stateCode(channel)} title={stateLabel} detail={offlineDetail(channel)} error={channelHasFault(channel)} />}
        {playable && player.state === "connecting" && <PlayerMessage code="ICE" title="Connecting" detail="Establishing a WebRTC media session." pulse />}
        {playable && player.state === "error" && <PlayerMessage code="ERR" title="Playback interrupted" detail={`${player.error} Retrying automatically.`} error />}
        {playable && player.state === "playing" && !player.hasVideo && !player.hasAudio && <PlayerMessage code="LIVE" title="Connected" detail="Waiting for media tracks." pulse />}
      </section>
      {!embed && <footer className="viewer-footer"><span className={playable ? "signal online" : "signal"} />Live LAN WebRTC</footer>}
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
