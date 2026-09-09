import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
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
  const [drag, setDrag] = useState<{ id: string; target: string | null; dropTarget: string | null; pageIDs: string[]; snapshot: DragSnapshot; left: number; top: number } | null>(null);
  const [moveID, setMoveID] = useState<string | null>(null);
  const [destination, setDestination] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<{ pointerID: number; id: string; x: number; y: number; offsetX: number; offsetY: number; handle: HTMLButtonElement; pageIDs: string[]; active: boolean; target: string | null; snapshot: DragSnapshot | null; cleanup: () => void } | null>(null);
  const layoutRef = useRef(new Map<HTMLElement, DOMRect>());
  const animationsRef = useRef(new Set<Animation>());
  const tileIDsRef = useRef<string[]>([]);
  const suppressClickRef = useRef(false);
  const focusIDRef = useRef<string | null>(null);
  const byID = new Map(channels.map((channel) => [channel.id, channel]));
  const ids = [...new Set([...order, ...byID.keys()])].filter((id) => byID.has(id));
  const pageCount = Math.max(1, Math.ceil(ids.length / 12));
  const currentPage = Math.min(page, pageCount - 1);
  // Keep this page's DOM membership/order fixed throughout capture, including polling updates.
  const visibleIDs = drag ? drag.pageIDs.filter((id) => byID.has(id)) : ids.slice(currentPage * 12, (currentPage + 1) * 12);
  // Even keyed DOM moves can empty a native video and tear down its WHEP session.
  // Keep retained nodes in DOM order after drop too; CSS order owns their positions.
  const renderedIDs = [...tileIDsRef.current.filter((id) => visibleIDs.includes(id)), ...visibleIDs.filter((id) => !tileIDsRef.current.includes(id))];
  const previewIDs = [...visibleIDs];
  if (drag?.target && previewIDs.includes(drag.id) && previewIDs.includes(drag.target)) {
    const to = previewIDs.indexOf(drag.target);
    previewIDs.splice(previewIDs.indexOf(drag.id), 1);
    previewIDs.splice(to, 0, drag.id);
  }
  const movingChannel = moveID ? byID.get(moveID) : undefined;
  const reorderHelp = "Drag until more than half the preview overlaps another tile to displace it. Drop with the preview center inside a tile, or point at a page button to move pages. Click the handle to choose a position. Order is saved in this browser. Only the visible page plays.";

  useEffect(() => {
    // Reconcile only definitive snapshots, never the initial empty loading state.
    if (loaded && (ids.length !== order.length || ids.some((id, index) => id !== order[index]))) {
      setOrder(ids);
      writeMultiviewOrder(ids);
    }
    if (page !== currentPage) setPage(currentPage);
    if (moveID && !byID.has(moveID)) setMoveID(null);
    const pointer = pointerRef.current;
    if (pointer && (!byID.has(pointer.id) || (pointer.target && !byID.has(pointer.target)) || (drag?.dropTarget && !byID.has(drag.dropTarget)))) {
      cancelPointer();
    }
  }, [loaded, ids, order, page, currentPage, moveID, byID, drag]);

  useLayoutEffect(() => {
    tileIDsRef.current = renderedIDs;
    for (const [tile, before] of layoutRef.current) {
      if (!tile.isConnected || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || !tile.animate) continue;
      const after = tile.getBoundingClientRect();
      const x = before.left - after.left, y = before.top - after.top;
      if (!x && !y) continue;
      const animation = tile.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: "translate(0, 0)" }], {
        // Softened ease-out: a longer glide and gentle settle without overshoot.
        duration: 460, easing: "cubic-bezier(.22,.68,.2,1)",
      });
      animationsRef.current.add(animation);
      animation.onfinish = () => { animationsRef.current.delete(animation); animation.onfinish = null; };
    }
    layoutRef.current.clear();
  });

  const stopAnimations = () => {
    for (const animation of animationsRef.current) { animation.onfinish = null; animation.cancel(); }
    animationsRef.current.clear();
  };

  const captureLayout = () => {
    // Capture visual positions before cancelling, including an interrupted glide.
    layoutRef.current = new Map([...rootRef.current!.querySelectorAll<HTMLElement>(".multiview-grid article")]
      .map((tile) => [tile, tile.getBoundingClientRect()]));
    stopAnimations();
  };

  const cancelPointer = (keepAnimations = false) => {
    const pointer = pointerRef.current;
    pointerRef.current = null;
    pointer?.cleanup();
    if (pointer?.handle.hasPointerCapture?.(pointer.pointerID)) pointer.handle.releasePointerCapture(pointer.pointerID);
    if (pointer?.active && pointer.handle.isConnected) pointer.handle.focus({ preventScroll: true });
    if (!keepAnimations) {
      stopAnimations();
      layoutRef.current.clear();
    }
    setDrag(null);
  };

  useEffect(() => {
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const reduceMotion = () => { if (motion?.matches) stopAnimations(); };
    motion?.addEventListener("change", reduceMotion);
    return () => { motion?.removeEventListener("change", reduceMotion); };
  }, []);

  useEffect(() => {
    const resetClick = () => { if (!pointerRef.current?.active) suppressClickRef.current = false; };
    const suppressClick = (event: MouseEvent) => {
      if (suppressClickRef.current && event.detail > 0) {
        if (event.type === "click") suppressClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      }
    };
    // A touch compatibility click can hit the newly opened modal backdrop, not
    // the captured handle. Intercept before either subtree; fresh presses reset it.
    document.addEventListener("pointerdown", resetClick, true);
    document.addEventListener("mousedown", suppressClick, true);
    document.addEventListener("click", suppressClick, true);
    return () => {
      document.removeEventListener("pointerdown", resetClick, true);
      document.removeEventListener("mousedown", suppressClick, true);
      document.removeEventListener("click", suppressClick, true);
    };
  }, []);

  useEffect(() => () => {
    const pointer = pointerRef.current;
    pointerRef.current = null;
    pointer?.cleanup();
    if (pointer?.handle.hasPointerCapture?.(pointer.pointerID)) pointer.handle.releasePointerCapture(pointer.pointerID);
    stopAnimations();
    layoutRef.current.clear();
  }, []);

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
    if (pointerRef.current || event.button !== 0 || event.isPrimary === false || ids.length < 2) return;
    suppressClickRef.current = false;
    const rect = event.currentTarget.closest("article")!.getBoundingClientRect();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") cancelPointer(); };
    window.addEventListener("keydown", escape, true);
    pointerRef.current = { pointerID: event.pointerId, id, x: event.clientX, y: event.clientY,
      offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, handle: event.currentTarget,
      pageIDs: visibleIDs, active: false, target: id, snapshot: null,
      cleanup: () => window.removeEventListener("keydown", escape, true) };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const pointerTarget = (x: number, y: number) => {
    const pointer = pointerRef.current!;
    let target = pointer.target;
    const root = rootRef.current;
    const grid = root?.querySelector<HTMLElement>(".multiview-grid");
    if (!grid || !pointer.snapshot) return { target, dropTarget: null };
    const contains = (r: { left: number; top: number; width: number; height: number }) =>
      x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height;
    // Page buttons are explicit pointer targets, never accidental ghost collisions.
    for (const button of root!.querySelectorAll<HTMLButtonElement>(".multiview-pagination button")) {
      if (contains(button.getBoundingClientRect())) return { target, dropTarget: button.disabled ? null : button.dataset.moveTarget ?? null };
    }
    const origin = grid.getBoundingClientRect();
    // Offset geometry ignores FLIP transforms but follows the current CSS ordering.
    // Exclude the moving placeholder: holding its new slot must not undo the preview.
    const slots = [...grid.querySelectorAll<HTMLElement>("article")]
      .map((tile) => ({ id: tile.dataset.moveTarget, left: origin.left + tile.offsetLeft, top: origin.top + tile.offsetTop, width: tile.offsetWidth, height: tile.offsetHeight }))
      .sort((a, b) => a.top - b.top || a.left - b.left);
    const { width, height } = pointer.snapshot;
    const left = x - pointer.offsetX, top = y - pointer.offsetY;
    let bestArea = width * height / 2;
    const pageIDs = pointer.pageIDs.filter((id) => byID.has(id));
    slots.forEach((slot, index) => {
      if (slot.id === pointer.id) return;
      const area = Math.max(0, Math.min(left + width, slot.left + slot.width) - Math.max(left, slot.left))
        * Math.max(0, Math.min(top + height, slot.top + slot.height) - Math.max(top, slot.top));
      if (area > bestArea) {
        bestArea = area;
        // target is the original-page insertion anchor, not the displaced tile's ID.
        target = pageIDs[index];
      }
    });
    // Keep the proposed order across gaps and partial overlaps. Drop validity is
    // independent, including the invisible placeholder before/after displacement.
    x = left + width / 2;
    y = top + height / 2;
    return { target, dropTarget: slots.some(contains) ? target : null };
  };

  const updatePointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pointer = pointerRef.current;
    if (!pointer || pointer.pointerID !== event.pointerId) return;
    if (!pointer.active && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 6) return;
    if (!pointer.active) {
      pointer.active = true;
      pointer.snapshot = captureDragSnapshot(pointer.handle.closest("article")!);
    }
    suppressClickRef.current = true;
    const { target, dropTarget } = pointerTarget(event.clientX, event.clientY);
    if (target !== pointer.target) {
      captureLayout();
    }
    pointer.target = target;
    setDrag({ id: pointer.id, target, dropTarget, pageIDs: pointer.pageIDs, snapshot: pointer.snapshot!,
      left: event.clientX - pointer.offsetX, top: event.clientY - pointer.offsetY });
  };

  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pointer = pointerRef.current;
    if (!pointer || pointer.pointerID !== event.pointerId) return;
    const tap = !pointer.active && event.pointerType === "touch"
      && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 6;
    const target = pointer.active ? pointerTarget(event.clientX, event.clientY).dropTarget : null;
    const commit = target && byID.has(pointer.id) && (!pointer.target || byID.has(pointer.target));
    const samePage = Boolean(commit && target && pointer.pageIDs.includes(target));
    // Releasing a short drag must not cancel its glide before the first painted frame.
    // A final pointerup can also select a different slot without a preceding move.
    if (samePage && target !== pointer.target) captureLayout();
    cancelPointer(samePage);
    if (commit) moveChannel(pointer.id, target);
    else if (tap) {
      // Chrome can omit the compatibility click after a captured cross-page touch.
      // Handle a stationary tap once, whether or not that click is delivered.
      suppressClickRef.current = true;
      pointer.handle.focus({ preventScroll: true });
      setMoveID(pointer.id);
      setDestination(pointer.id);
    }
  };

  return (
    <>
      <div className="multiview-browser" ref={rootRef} inert={movingChannel ? true : undefined} aria-hidden={movingChannel ? true : undefined}
        onPointerMove={updatePointer} onPointerUp={finishPointer}
        onPointerCancel={(event) => { if (event.pointerId === pointerRef.current?.pointerID) cancelPointer(); }}
        onLostPointerCapture={(event) => { if (event.pointerId === pointerRef.current?.pointerID) cancelPointer(); }}>
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
              <button className={`button secondary${drag && drag.dropTarget === ids[(currentPage - 1) * 12] ? " is-drop-target" : ""}`} type="button"
                disabled={currentPage === 0} data-move-target={currentPage > 0 ? ids[(currentPage - 1) * 12] : undefined}
                onClick={() => { if (!drag) setPage(currentPage - 1); }}>Previous page</button>
              <span aria-live="polite">Page {currentPage + 1} of {pageCount}</span>
              <button className={`button secondary${drag && drag.dropTarget === ids[(currentPage + 1) * 12] ? " is-drop-target" : ""}`} type="button"
                disabled={currentPage === pageCount - 1} data-move-target={ids[(currentPage + 1) * 12]}
                onClick={() => { if (!drag) setPage(currentPage + 1); }}>Next page</button>
            </nav>
          </div>
        </div>
        <p id="multiview-help" className="visually-hidden">{reorderHelp}</p>
        <section className="multiview-grid" aria-label={`Channels on page ${currentPage + 1}`} hidden={ids.length === 0}>
          {renderedIDs.map((id) => {
            const channel = byID.get(id)!;
            return <MultiviewTile key={id} channel={channel} audioContext={audioMeters.context} position={previewIDs.indexOf(id)} dragging={drag?.id === id} dropTarget={drag?.id === id && visibleIDs.includes(drag.target ?? "")} moveHandle={
              <button className="multiview-drag-handle" type="button" aria-label={`Move ${channel.name}`} aria-describedby="multiview-help"
                title="Drag to reorder or click to choose a position" disabled={ids.length < 2} onPointerDown={(event) => startPointer(event, id)}
                onClick={() => {
                  if (drag) return;
                  setMoveID(id);
                  setDestination(id);
                }}><GripIcon /></button>
            } />;
          })}
        </section>
        {ids.length === 0 && <div className="multiview-empty">{loaded ? "Create a channel in Signal Desk. It will appear here automatically." : "Reading live output status."}</div>}
        <div className="visually-hidden" role="status">{announcement}</div>
      </div>
      {drag && createPortal(<DragOverlay snapshot={drag.snapshot} left={drag.left} top={drag.top} />, document.body)}
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

type DragSnapshot = {
  width: number; height: number; name: string; status: string; signal: string;
  frame: HTMLCanvasElement | null; message: string;
};

function captureDragSnapshot(tile: HTMLElement): DragSnapshot {
  const { width, height } = tile.getBoundingClientRect();
  const video = tile.querySelector("video");
  let frame: HTMLCanvasElement | null = null;
  if (video && video.readyState >= 2 && video.videoWidth && video.videoHeight) {
    try {
      const canvas = document.createElement("canvas");
      // One bounded still, never a cloned video, stream, or player session.
      canvas.width = Math.min(video.videoWidth, Math.ceil(width * window.devicePixelRatio), 1280);
      canvas.height = Math.max(1, Math.round(canvas.width * video.videoHeight / video.videoWidth));
      const context = canvas.getContext("2d");
      if (context) { context.drawImage(video, 0, 0, canvas.width, canvas.height); frame = canvas; }
    } catch { /* A missing/protected frame still has a useful header and status preview. */ }
  }
  return { width, height, frame,
    name: tile.querySelector("h2")?.textContent ?? "",
    status: tile.querySelector("header small")?.textContent ?? "",
    signal: tile.querySelector(".signal")?.className ?? "signal",
    message: [...tile.querySelectorAll(".preview-message > *")].map((element) => element.textContent).join(" ") || "Video frame unavailable",
  };
}

function DragOverlay({ snapshot, left, top }: { snapshot: DragSnapshot; left: number; top: number }) {
  const pictureRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!snapshot.frame) return;
    pictureRef.current?.append(snapshot.frame);
    return () => { snapshot.frame?.remove(); };
  }, [snapshot]);
  return <div className="multiview-drag-overlay" aria-hidden="true" inert
    style={{ width: snapshot.width, height: snapshot.height, transform: `translate3d(${left}px, ${top}px, 0)` }}>
    <div className="multiview-tile">
      <header className="multiview-tile-header">
        <div><span className={snapshot.signal} /><h2>{snapshot.name}</h2></div>
        <small>{snapshot.status}</small><span className="multiview-drag-handle"><GripIcon /></span>
      </header>
      <section className="standalone-stage"><div className="multiview-picture" ref={pictureRef}>
        {!snapshot.frame && <div className="preview-message">{snapshot.message}</div>}
      </div></section>
    </div>
  </div>;
}

function MultiviewTile({ channel, audioContext, moveHandle, position, dragging, dropTarget }: { channel: Channel; audioContext: AudioContext | null; moveHandle: ReactNode; position: number; dragging: boolean; dropTarget: boolean }) {
  const playable = channelPlaybackReady(channel);
  const player = useWHEPPlayer({
    whepPath: channel?.whepPath ?? "",
    enabled: playable,
    retry: true,
  });
  const stateLabel = channelStateLabel(channel);
  const showAudioOnly = Boolean(playable && player.state === "playing" && player.hasAudio && !player.hasVideo);

  return (
    <article data-move-target={channel.id} style={{ order: position }} className={`multiview-tile${playable ? " live" : ""}${dragging ? " is-dragging" : ""}${dropTarget ? " is-drop-target" : ""}`}>
      <header className="multiview-tile-header">
        <div><span className={channelHasFault(channel) ? "signal fault" : playable ? "signal online" : "signal"} /><h2>{channel.name}</h2></div>
        <small>{stateLabel}</small>
        {moveHandle}
      </header>
      <section className="standalone-stage" aria-label={`${channel.name} player`}>
        <div className="multiview-picture">
        <video ref={player.videoRef} autoPlay playsInline muted aria-label={`${channel.name} video`} />
        {showAudioOnly && <PlayerMessage code="AUD" title="Audio-only stream" detail="Monitoring muted. Audio levels are overlaid on the player." />}
        {!playable && <PlayerMessage code={stateCode(channel)} title={stateLabel} detail={offlineDetail(channel)} error={channelHasFault(channel)} />}
        {playable && player.state === "connecting" && <PlayerMessage code="ICE" title="Connecting" detail="Establishing a WebRTC media session." pulse />}
        {playable && player.state === "error" && <PlayerMessage code="ERR" title="Playback interrupted" detail={`${player.error} Retrying automatically.`} error />}
        {playable && player.state === "playing" && !player.hasVideo && !player.hasAudio && <PlayerMessage code="LIVE" title="Connected" detail="Waiting for media tracks." pulse />}
        <AudioMeter track={playable ? player.audioTrack : null} context={audioContext} name={channel.name} />
        </div>
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
