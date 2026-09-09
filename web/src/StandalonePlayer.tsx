import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  channelHasFault,
  channelPlaybackReady,
  channelStateLabel,
  mergeChannelRuntime,
  mergeChannelRuntimes,
  primaryChannelIssue,
  readChannelRuntime,
  readChannelRuntimes,
  readChannelSnapshot,
  readChannelSnapshots,
  type Channel,
} from "./channel";
import { startSerialPolling } from "./polling";
import { requestJSON } from "./request";
import { useWHEPPlayer } from "./useWHEPPlayer";
import { ArrowLeftIcon, GripIcon } from "./Icons";
import { ModalShell } from "./Modal";
import { HelpTip } from "./Tooltip";
import { readMultiviewOrder, writeMultiviewOrder } from "./uiPreferences";
import { AudioMeter, useAudioMeterContext } from "./AudioMeter";

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
    let initialized = false;
    let snapshot: Channel[] | null = null;

    const loadFull = async (signal: AbortSignal) => {
      const { response, body } = await requestJSON<unknown>("/api/v1/channels", { cache: "no-store", signal });
      if (!response.ok) throw new Error(apiErrorMessage(body, response.status, "Channel request failed"));
      const channels = readChannelSnapshots(body);
      if (!channels) throw new Error("Gateway channel response was malformed");
      return channels;
    };

    const load = async (signal: AbortSignal) => {
      try {
        let next: Channel[];
        if (!initialized || !snapshot) {
          next = await loadFull(signal);
        } else {
          const { response, body } = await requestJSON<unknown>("/api/v1/channels/runtime", { cache: "no-store", signal });
          if (!response.ok) throw new Error(apiErrorMessage(body, response.status, "Channel request failed"));
          const runtime = readChannelRuntimes(body);
          if (!runtime) throw new Error("Gateway runtime channel response was malformed");
          next = mergeChannelRuntimes(snapshot, runtime) ?? await loadFull(signal);
        }
        if (disposed) return;
        initialized = true;
        snapshot = next;
        setChannels(next);
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
        : `${channels.length} ${channels.length === 1 ? "channel" : "channels"} · ${liveChannels} ready`;
  return (
    <main className="standalone-player viewer-player multiview-player">
      <div className="multiview-content">
        {loadError && <div className="multiview-notice" role="alert">{loadError}. Status polling will retry automatically.</div>}
        <MultiviewGrid channels={channels} loaded={loaded} summary={summary} />
      </div>
    </main>
  );
}

export function MultiviewGrid({ channels, loaded, summary }: { channels: Channel[]; loaded: boolean; summary?: string }) {
  const audioMeters = useAudioMeterContext();
  const [order, setOrder] = useState(readMultiviewOrder);
  const [page, setPage] = useState(0);
  const [drag, setDrag] = useState<{ id: string; target: string | null } | null>(null);
  const [moveID, setMoveID] = useState<string | null>(null);
  const [destination, setDestination] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<{ pointerID: number; id: string; x: number; y: number; active: boolean; target: string | null } | null>(null);
  const suppressClickRef = useRef(false);
  const focusIDRef = useRef<string | null>(null);
  const byID = new Map(channels.map((channel) => [channel.id, channel]));
  const ids = [...new Set([...order, ...byID.keys()])].filter((id) => byID.has(id));
  const pageCount = Math.max(1, Math.ceil(ids.length / 12));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleIDs = ids.slice(currentPage * 12, (currentPage + 1) * 12);
  const movingChannel = moveID ? byID.get(moveID) : undefined;
  const reorderHelp = "Drag a tile's handle onto another tile or a page button. Click the handle to choose a position. Order is saved in this browser. Only the visible page plays.";

  useEffect(() => {
    // Reconcile only definitive snapshots, never the initial empty loading state.
    if (loaded && (ids.length !== order.length || ids.some((id, index) => id !== order[index]))) {
      setOrder(ids);
      writeMultiviewOrder(ids);
    }
    if (page !== currentPage) setPage(currentPage);
    if (moveID && !byID.has(moveID)) setMoveID(null);
    if (drag && (!byID.has(drag.id) || (drag.target && !byID.has(drag.target)))) {
      pointerRef.current = null;
      setDrag(null);
    }
  }, [loaded, ids, order, page, currentPage, moveID, byID, drag]);

  useLayoutEffect(() => {
    if (!focusIDRef.current) return;
    const tile = Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-move-target]") ?? [])
      .find((element) => element.dataset.moveTarget === focusIDRef.current && element.matches("article"));
    tile?.querySelector<HTMLButtonElement>(".multiview-drag-handle")?.focus();
    focusIDRef.current = null;
  });

  const moveChannel = (id: string, target: string) => {
    const from = ids.indexOf(id);
    const to = ids.indexOf(target);
    if (from < 0 || to < 0) return;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, id);
    setOrder(next);
    writeMultiviewOrder(next);
    setPage(Math.floor(to / 12));
    setMoveID(null);
    focusIDRef.current = id;
    setAnnouncement(`${byID.get(id)?.name} moved to page ${Math.floor(to / 12) + 1}, position ${to % 12 + 1}.`);
  };

  const startPointer = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (event.button !== 0 || event.isPrimary === false || ids.length < 2) return;
    suppressClickRef.current = false;
    pointerRef.current = { pointerID: event.pointerId, id, x: event.clientX, y: event.clientY, active: false, target: null };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const updatePointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pointer = pointerRef.current;
    if (!pointer || pointer.pointerID !== event.pointerId) return;
    if (!pointer.active && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 6) return;
    pointer.active = true;
    suppressClickRef.current = true;
    const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-move-target]");
    pointer.target = hit && rootRef.current?.contains(hit) ? hit.dataset.moveTarget ?? null : null;
    setDrag({ id: pointer.id, target: pointer.target });
  };

  const cancelPointer = () => {
    pointerRef.current = null;
    setDrag(null);
  };

  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pointer = pointerRef.current;
    if (!pointer || pointer.pointerID !== event.pointerId) return;
    if (pointer.active && pointer.target) moveChannel(pointer.id, pointer.target);
    cancelPointer();
  };

  return (
    <>
      <div className="multiview-browser" ref={rootRef} inert={movingChannel ? true : undefined} aria-hidden={movingChannel ? true : undefined}
        onPointerDownCapture={() => { suppressClickRef.current = false; }}
        onClickCapture={(event) => {
          if (suppressClickRef.current && event.detail > 0) {
            suppressClickRef.current = false;
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onPointerMove={updatePointer} onPointerUp={finishPointer} onPointerCancel={cancelPointer} onLostPointerCapture={cancelPointer}
        onKeyDown={(event) => { if (event.key === "Escape") cancelPointer(); }}>
        <div className="multiview-toolbar">
          <nav className="detail-breadcrumb multiview-breadcrumb" aria-label="Breadcrumb">
            <a className="crumb-back" href="/"><ArrowLeftIcon /> Overview</a>
            <span className="crumb-divider" aria-hidden="true">/</span>
            <h1 className="crumb-current" aria-current="page">Multiviewer</h1>
          </nav>
          <div className="multiview-controls">
            {summary && <p className="multiview-summary">{summary}</p>}
            {(["suspended", "interrupted", "error"] as string[]).includes(audioMeters.state) && <button className="button secondary multiview-enable-meters" type="button" onClick={audioMeters.enable} title="Enable silent audio analysis; playback remains muted">Enable meters</button>}
            {(audioMeters.state === "unsupported" || audioMeters.state === "closed") && <span className="multiview-summary" title="This browser cannot run audio analysis. Video playback is unaffected.">Meters unavailable</span>}
            <HelpTip label="Reorder channels" content={reorderHelp} placement="bottom" />
            <nav className="multiview-pagination" aria-label="Multiview pages">
              <button className={`button secondary${drag && drag.target === ids[(currentPage - 1) * 12] ? " is-drop-target" : ""}`} type="button"
                disabled={currentPage === 0} data-move-target={currentPage > 0 ? ids[(currentPage - 1) * 12] : undefined}
                onClick={() => setPage(currentPage - 1)}>Previous page</button>
              <span aria-live="polite">Page {currentPage + 1} of {pageCount}</span>
              <button className={`button secondary${drag && drag.target === ids[(currentPage + 1) * 12] ? " is-drop-target" : ""}`} type="button"
                disabled={currentPage === pageCount - 1} data-move-target={ids[(currentPage + 1) * 12]}
                onClick={() => setPage(currentPage + 1)}>Next page</button>
            </nav>
          </div>
        </div>
        <p id="multiview-help" className="visually-hidden">{reorderHelp}</p>
        <section className="multiview-grid" aria-label={`Channels on page ${currentPage + 1}`} hidden={ids.length === 0}>
          {visibleIDs.map((id) => {
            const channel = byID.get(id)!;
            return <MultiviewTile key={id} channel={channel} audioContext={audioMeters.context} dragging={drag?.id === id} dropTarget={drag?.target === id} moveHandle={
              <button className="multiview-drag-handle" type="button" aria-label={`Move ${channel.name}`} aria-describedby="multiview-help"
                title="Drag to reorder or click to choose a position" disabled={ids.length < 2} onPointerDown={(event) => startPointer(event, id)}
                onClick={() => {
                  setMoveID(id);
                  setDestination(id);
                }}><GripIcon /></button>
            } />;
          })}
        </section>
        {ids.length === 0 && <div className="multiview-empty">{loaded ? "Create a channel in Signal Desk. It will appear here automatically." : "Reading live output status."}</div>}
        <div className="visually-hidden" role="status">{announcement}</div>
      </div>
      {movingChannel && <ModalShell className="multiview-move-dialog" labelledBy="move-channel-title" closeLabel="Close move channel" onClose={() => setMoveID(null)}>
        <header className="editor-header"><h2 id="move-channel-title">Move {movingChannel.name}</h2></header>
        <div className="editor-body"><label className="field">Destination position
          <select value={destination} onChange={(event) => setDestination(event.target.value)}>
            {ids.map((id, index) => <option key={id} value={id}>Page {Math.floor(index / 12) + 1}, position {index % 12 + 1} - {byID.get(id)?.name}</option>)}
          </select>
        </label></div>
        <footer className="editor-footer"><button className="button secondary" type="button" onClick={() => setMoveID(null)}>Cancel</button>
          <button className="button primary" type="button" disabled={!byID.has(destination)} onClick={() => moveChannel(movingChannel.id, destination)}>Move channel</button></footer>
      </ModalShell>}
    </>
  );
}

export function StandalonePlayer({ channelID }: { channelID: string }) {
  const [channel, setChannel] = useState<Channel | null>(null);

  useEffect(() => {
    let disposed = false;
    let initialized = false;
    let snapshot: Channel | null = null;

    const loadFull = async (signal: AbortSignal) => {
      const { response, body } = await requestJSON<unknown>(`/api/v1/channels/${encodeURIComponent(channelID)}`, {
        cache: "no-store",
        signal,
      });
      if (response.status === 404 || response.status === 410) return null;
      if (!response.ok) throw new Error(apiErrorMessage(body, response.status, "Channel request failed"));
      const channel = readChannelSnapshot(body);
      if (!channel) throw new Error("Gateway channel response was malformed");
      return channel;
    };

    const load = async (signal: AbortSignal) => {
      try {
        let next: Channel | null;
        if (!initialized) {
          next = await loadFull(signal);
        } else {
          const { response, body } = await requestJSON<unknown>(`/api/v1/channels/${encodeURIComponent(channelID)}/runtime`, {
            cache: "no-store",
            signal,
          });
          if (response.status === 404 || response.status === 410) {
            next = null;
          } else {
            if (!response.ok) throw new Error(apiErrorMessage(body, response.status, "Channel request failed"));
            const runtime = readChannelRuntime(body);
            if (!runtime) throw new Error("Gateway runtime channel response was malformed");
            next = snapshot ? mergeChannelRuntime(snapshot, runtime) ?? await loadFull(signal) : await loadFull(signal);
          }
        }
        if (disposed) return;
        initialized = true;
        snapshot = next;
        setChannel(next);
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

function MultiviewTile({ channel, audioContext, moveHandle, dragging, dropTarget }: { channel: Channel; audioContext: AudioContext | null; moveHandle: ReactNode; dragging: boolean; dropTarget: boolean }) {
  const playable = channelPlaybackReady(channel);
  const player = useWHEPPlayer({
    whepPath: channel?.whepPath ?? "",
    enabled: playable,
    retry: true,
  });
  const stateLabel = channelStateLabel(channel);
  const showAudioOnly = Boolean(playable && player.state === "playing" && player.hasAudio && !player.hasVideo);

  return (
    <article data-move-target={channel.id} className={`multiview-tile${playable ? " live" : ""}${dragging ? " is-dragging" : ""}${dropTarget ? " is-drop-target" : ""}`}>
      <header className="multiview-tile-header">
        <div><span className={channelHasFault(channel) ? "signal fault" : playable ? "signal online" : "signal"} /><h2>{channel.name}</h2></div>
        <small>{stateLabel}</small>
        {moveHandle}
      </header>
      <section className="standalone-stage" aria-label={`${channel.name} player`}>
        <div className="multiview-picture">
        <video ref={player.videoRef} autoPlay playsInline muted aria-label={`${channel.name} video`} />
        {showAudioOnly && <PlayerMessage code="AUD" title="Audio-only stream" detail="Monitoring muted. Audio levels are shown beside the player." />}
        {!playable && <PlayerMessage code={stateCode(channel)} title={stateLabel} detail={offlineDetail(channel)} error={channelHasFault(channel)} />}
        {playable && player.state === "connecting" && <PlayerMessage code="ICE" title="Connecting" detail="Establishing a WebRTC media session." pulse />}
        {playable && player.state === "error" && <PlayerMessage code="ERR" title="Playback interrupted" detail={`${player.error} Retrying automatically.`} error />}
        {playable && player.state === "playing" && !player.hasVideo && !player.hasAudio && <PlayerMessage code="LIVE" title="Connected" detail="Waiting for media tracks." pulse />}
        </div>
        <AudioMeter track={playable ? player.audioTrack : null} context={audioContext} name={channel.name} />
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
  if (primaryChannelIssue(channel)) return primaryChannelIssue(channel)?.message ?? "The input was rejected.";
  if (channel.compatibility.state === "error") return channel.compatibility.lastError ?? "A browser-compatible output is unavailable.";
  if (channel.relay?.state === "retrying" || channel.relay?.state === "stopped") return channel.relay.lastError ?? "The SRT listener process is unavailable.";
  if (channel.available && channel.online) return "The encoder is connected and the browser-compatible output is being prepared.";
  return "The player will start automatically when output becomes ready.";
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
