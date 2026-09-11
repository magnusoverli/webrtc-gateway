import { useEffect, useRef, useState } from "react";
import { isRequestTimeoutError, requestText, requestWithDeadline } from "./request";
import { MediaProgressWatchdog } from "./mediaHealth";
import { preferOpusStereo, summarizeRTCStats, waitForICEGathering, type PreviewStats, type StatsSample } from "./webrtc";

export type WHEPPlayerState = "off" | "connecting" | "playing" | "error";

export type WHEPPlayerOptions = {
  whepPath: string;
  outputGeneration?: string;
  enabled: boolean;
  retry?: boolean;
  collectStats?: boolean;
  random?: () => number;
};

type WHEPSession = {
  peer: RTCPeerConnection;
  abort: AbortController;
  location: string;
  closed: boolean;
  cleanupPromise?: Promise<void>;
  connectionTimer?: number;
  stableTimer?: number;
  statsTimer?: number;
  statsRunning: boolean;
  statsPending: boolean;
  statsSample?: StatsSample;
  mediaConnected: boolean;
  mediaWatchdog: MediaProgressWatchdog;
};

const ICE_GATHERING_TIMEOUT_MS = 10_000;
const SIGNALING_TIMEOUT_MS = 10_000;
const CONNECTION_TIMEOUT_MS = 12_000;
const DISCONNECTED_TIMEOUT_MS = 3_000;
const STABLE_CONNECTION_MS = 10_000;
const STATS_INTERVAL_MS = 1_000;
const MEDIA_CHECK_INTERVAL_MS = 500;
const HIDDEN_SESSION_GRACE_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 3_000;
const REPLACEMENT_CLEANUP_WAIT_MS = 1_000;
const FAST_RETRY_MS = 250;
const FAST_RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 8_000;
const RETRY_JITTER_RATIO = 0.2;
const RESUME_BASE_MS = 500;

export function preferLowDelay(receiver: RTCRtpReceiver) {
  if (!("jitterBufferTarget" in receiver)) return;
  try {
    receiver.jitterBufferTarget = 0;
  } catch {
    // Receiver hints are optional and must not prevent playback.
  }
}

export function useWHEPPlayer({
  whepPath,
  outputGeneration = "",
  enabled,
  retry = false,
  collectStats = false,
  random = Math.random,
}: WHEPPlayerOptions) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<WHEPPlayerState>("off");
  const [error, setError] = useState("");
  const [stats, setStats] = useState<PreviewStats | null>(null);
  const [hasVideo, setHasVideo] = useState(false);
  const [hasAudio, setHasAudio] = useState(false);
  const [audioTrack, setAudioTrack] = useState<MediaStreamTrack | null>(null);
  const [statePath, setStatePath] = useState(whepPath);
  const [stateGeneration, setStateGeneration] = useState(outputGeneration);
  // A generation change runs effect cleanup before starting its replacement.
  // Keep DELETE coordination across effects, including rapid ready/offline edges.
  const pendingCleanupRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    setStatePath(whepPath);
    setStateGeneration(outputGeneration);
    setState("off");
    setError("");
    setStats(null);
    setHasVideo(false);
    setHasAudio(false);
    setAudioTrack(null);
    let disposed = false;
    let pageInactive = false;
    let session: WHEPSession | null = null;
    let retryTimer: number | undefined;
    let retryTimerKind: "retry" | "resume" | undefined;
    let hiddenTimer: number | undefined;
    let deferredStart: "retry" | "resume" | null = null;
    let retryCount = 0;
    let startVersion = 0;
    let waitingStartVersion: number | null = null;

    const isPaused = () => pageInactive || document.visibilityState === "hidden";
    const clearMedia = () => {
      if (videoRef.current) videoRef.current.srcObject = null;
      if (disposed) return;
      setStats(null);
      setHasVideo(false);
      setHasAudio(false);
      setAudioTrack(null);
    };
    const clearRetryTimer = () => {
      if (retryTimer === undefined) return;
      window.clearTimeout(retryTimer);
      retryTimer = undefined;
      retryTimerKind = undefined;
    };
    const clearHiddenTimer = () => {
      if (hiddenTimer === undefined) return;
      window.clearTimeout(hiddenTimer);
      hiddenTimer = undefined;
    };
    const trackCleanup = (cleanup: Promise<void>) => {
      const previous = pendingCleanupRef.current;
      const pending = previous ? Promise.all([previous, cleanup]).then(() => undefined) : cleanup;
      pendingCleanupRef.current = pending;
      void pending.finally(() => {
        if (pendingCleanupRef.current === pending) pendingCleanupRef.current = null;
      });
    };
    const closeCurrent = (keepalive = false) => {
      const current = session;
      session = null;
      if (!current) return pendingCleanupRef.current;
      const cleanup = closeWHEPSession(current, { keepalive, retryDelete: !keepalive });
      trackCleanup(cleanup);
      clearMedia();
      return pendingCleanupRef.current;
    };
    const jitteredDelay = (baseMs: number) => {
      const unit = Math.min(1, Math.max(0, random()));
      return Math.min(RETRY_CAP_MS, Math.round(baseMs * (1 - RETRY_JITTER_RATIO + unit * RETRY_JITTER_RATIO * 2)));
    };
    const scheduleStart = (kind: "retry" | "resume") => {
      clearRetryTimer();
      if (isPaused()) {
        deferredStart = kind;
        return;
      }
      const exponent = Math.min(Math.max(0, retryCount - FAST_RETRY_ATTEMPTS - 1), 30);
      const base = kind === "retry"
        ? retryCount <= FAST_RETRY_ATTEMPTS ? FAST_RETRY_MS : Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** exponent)
        : RESUME_BASE_MS;
      retryTimerKind = kind;
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        retryTimerKind = undefined;
        void start();
      }, jitteredDelay(base));
    };
    const fail = (current: WHEPSession | null, message: string) => {
      if (disposed || session !== current) return;
      session = null;
      if (current) trackCleanup(closeWHEPSession(current, { keepalive: false, retryDelete: true }));
      clearMedia();
      setState("error");
      setError(message);
      if (retry) {
        retryCount += 1;
        scheduleStart("retry");
      }
    };
    const markConnected = (current: WHEPSession) => {
      if (disposed || session !== current) return;
      if (!current.mediaConnected) {
        current.mediaConnected = true;
        current.mediaWatchdog.reset(performance.now());
      }
      if (current.connectionTimer !== undefined) {
        window.clearTimeout(current.connectionTimer);
        current.connectionTimer = undefined;
      }
      setState("playing");
      if (current.stableTimer === undefined) {
        current.stableTimer = window.setTimeout(() => {
          current.stableTimer = undefined;
          if (!disposed && session === current && current.peer.connectionState === "connected") retryCount = 0;
        }, STABLE_CONNECTION_MS);
      }
    };
    const pauseStats = (current: WHEPSession) => {
      if (current.statsTimer !== undefined) {
        window.clearTimeout(current.statsTimer);
        current.statsTimer = undefined;
      }
      current.statsPending = collectStats || retry;
      current.mediaWatchdog.reset(performance.now());
      current.statsSample = undefined;
    };
    const runStats = (current: WHEPSession) => {
      if ((!collectStats && !retry) || disposed || session !== current || isPaused()) return;
      if (current.statsRunning) {
        current.statsPending = true;
        return;
      }
      if (current.statsTimer !== undefined) {
        window.clearTimeout(current.statsTimer);
        current.statsTimer = undefined;
      }
      current.statsRunning = true;
      current.statsPending = false;
      void (async () => {
        try {
          const report = await current.peer.getStats();
          if (disposed || session !== current || isPaused()) return;
          if (retry && current.mediaConnected && current.peer.connectionState === "connected") {
            const problem = current.mediaWatchdog.inspect(report, performance.now());
            if (problem) { fail(current, problem); return; }
          }
          if (collectStats) {
            const result = summarizeRTCStats(report, current.statsSample);
            current.statsSample = result.sample;
            setStats(result.stats);
          }
        } catch {
          // Stats are diagnostic only and must not interrupt playback.
          current.mediaWatchdog.reset(performance.now());
        } finally {
          current.statsRunning = false;
          if ((!collectStats && !retry) || disposed || session !== current || isPaused()) return;
          if (current.statsPending) {
            runStats(current);
          } else {
            current.statsTimer = window.setTimeout(() => runStats(current), retry ? MEDIA_CHECK_INTERVAL_MS : STATS_INTERVAL_MS);
          }
        }
      })();
    };

    const start = async () => {
      const version = ++startVersion;
      clearRetryTimer();
      deferredStart = null;
      if (disposed) return;
      if (isPaused()) {
        deferredStart = "resume";
        return;
      }

      const cleanup = closeCurrent(false);
      setState("connecting");
      setError("");
      if (cleanup) {
        waitingStartVersion = version;
        await waitForCleanup(cleanup, REPLACEMENT_CLEANUP_WAIT_MS);
        if (waitingStartVersion === version) waitingStartVersion = null;
      }
      if (disposed || version !== startVersion || isPaused()) return;

      let starting: WHEPSession | null = null;
      try {
        const peer = new RTCPeerConnection();
        const current: WHEPSession = {
          peer,
          abort: new AbortController(),
          location: "",
          closed: false,
          statsRunning: false,
          statsPending: false,
          mediaConnected: false,
          mediaWatchdog: new MediaProgressWatchdog(),
        };
        session = starting = current;
        const stream = new MediaStream();

        preferLowDelay(peer.addTransceiver("video", { direction: "recvonly" }).receiver);
        preferLowDelay(peer.addTransceiver("audio", { direction: "recvonly" }).receiver);
        peer.ontrack = (event) => {
          if (disposed || session !== current) return;
          stream.addTrack(event.track);
          if (event.track.kind === "video") setHasVideo(true);
          if (event.track.kind === "audio") {
            setHasAudio(true);
            setAudioTrack(event.track);
          }
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.muted = true;
            void videoRef.current.play().catch(() => undefined);
          }
        };
        peer.onconnectionstatechange = () => {
          if (disposed || session !== current) return;
          if (peer.connectionState === "connected") {
            markConnected(current);
          } else if (peer.connectionState === "failed" || peer.connectionState === "closed") {
            fail(current, "The WebRTC peer connection failed.");
          } else if (peer.connectionState === "disconnected") {
            current.mediaConnected = false;
            setState("connecting");
            if (current.stableTimer !== undefined) {
              window.clearTimeout(current.stableTimer);
              current.stableTimer = undefined;
            }
            if (current.connectionTimer !== undefined) window.clearTimeout(current.connectionTimer);
            current.connectionTimer = window.setTimeout(() => {
              fail(current, "The media session disconnected. Verify the browser network path and configured WebRTC UDP or TCP listener.");
            }, DISCONNECTED_TIMEOUT_MS);
          }
        };

        const offer = await peer.createOffer();
        if (disposed || session !== current) return;
        await peer.setLocalDescription({ ...offer, sdp: offer.sdp ? preferOpusStereo(offer.sdp) : offer.sdp });
        if (disposed || session !== current) return;
        const gathering = await waitForICEGathering(peer, {
          timeoutMs: ICE_GATHERING_TIMEOUT_MS,
          signal: current.abort.signal,
        });
        if (gathering === "aborted" || disposed || session !== current) return;
        if (gathering === "timeout") {
          fail(current, "ICE gathering timed out before completion; a non-trickle WHEP offer was not sent.");
          return;
        }
        if (!peer.localDescription?.sdp) throw new Error("WebRTC did not produce a local SDP offer.");

        const { body: answer } = await requestWithDeadline(whepPath, {
          method: "POST",
          headers: { "Content-Type": "application/sdp", Accept: "application/sdp" },
          body: peer.localDescription.sdp,
          signal: current.abort.signal,
          timeoutMs: SIGNALING_TIMEOUT_MS,
        }, async (response) => {
          if (!response.ok) {
            const detail = await response.text();
            throw new Error(detail || `WHEP request failed with ${response.status}`);
          }
          const location = response.headers.get("Location")?.trim();
          if (!location) throw new Error("WHEP response did not include the required Location header.");
          if (disposed || session !== current || current.abort.signal.aborted) throw abortError();
          current.location = resolveWHEPLocation(location);
          const body = await response.text();
          if (!body) throw new Error("WHEP response did not contain an SDP answer.");
          return body;
        });
        if (disposed || session !== current) return;
        await peer.setRemoteDescription({ type: "answer", sdp: answer });
        if (disposed || session !== current) return;

        if (peer.connectionState === "connected") {
          markConnected(current);
        } else {
          current.connectionTimer = window.setTimeout(() => {
            fail(current, "ICE could not connect. Allow the configured WebRTC media port through the host firewall, verify the advertised LAN host, or enable the TCP fallback in Global settings.");
          }, CONNECTION_TIMEOUT_MS);
        }
        if (collectStats || retry) runStats(current);
      } catch (caught) {
        if (starting?.abort.signal.aborted || disposed || session !== starting) return;
        const message = isRequestTimeoutError(caught)
          ? "WHEP signaling timed out before an SDP answer was received."
          : caught instanceof Error ? caught.message : "Unable to start WebRTC preview.";
        fail(starting, message);
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        if (retryTimer !== undefined) {
          deferredStart = retryTimerKind ?? "resume";
          clearRetryTimer();
        }
        const current = session;
        if (!current) {
          if (waitingStartVersion !== null) {
            startVersion += 1;
            waitingStartVersion = null;
            deferredStart = "resume";
          }
          return;
        }
        pauseStats(current);
        if (!current.location) {
          startVersion += 1;
          closeCurrent(false);
          deferredStart = "resume";
          return;
        }
        clearHiddenTimer();
        hiddenTimer = window.setTimeout(() => {
          hiddenTimer = undefined;
          if (document.visibilityState !== "hidden" || session !== current) return;
          startVersion += 1;
          closeCurrent(false);
          deferredStart = "resume";
        }, HIDDEN_SESSION_GRACE_MS);
        return;
      }

      clearHiddenTimer();
      const current = session;
      if (current) {
        deferredStart = null;
        current.mediaWatchdog.reset(performance.now());
        if (collectStats || retry) runStats(current);
      } else if (deferredStart) {
        scheduleStart(deferredStart);
      }
    };
    const onPageHide = () => {
      pageInactive = true;
      startVersion += 1;
      clearRetryTimer();
      clearHiddenTimer();
      deferredStart = "resume";
      closeCurrent(true);
    };
    const onPageShow = () => {
      pageInactive = false;
      if (document.visibilityState !== "hidden" && !session && deferredStart) scheduleStart(deferredStart);
    };

    if (!enabled || !whepPath) {
      setState("off");
      setError("");
      clearMedia();
      return () => {
        disposed = true;
      };
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    if (isPaused()) deferredStart = "resume";
    else void start();

    return () => {
      disposed = true;
      startVersion += 1;
      clearRetryTimer();
      clearHiddenTimer();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      closeCurrent(false);
    };
  }, [collectStats, enabled, outputGeneration, random, retry, whepPath]);

  // Do not expose the previous channel's receiver evidence before effect cleanup runs.
  if (!enabled || statePath !== whepPath || stateGeneration !== outputGeneration) return {
    videoRef, state: "off" as const, error: "", stats: null, hasVideo: false, hasAudio: false, audioTrack: null,
  };
  return { videoRef, state, error, stats, hasVideo, hasAudio, audioTrack };
}

async function closeWHEPSession(
  session: WHEPSession,
  options: { keepalive: boolean; retryDelete: boolean },
) {
  if (session.cleanupPromise) return session.cleanupPromise;
  session.closed = true;
  session.abort.abort(abortError());
  if (session.connectionTimer !== undefined) window.clearTimeout(session.connectionTimer);
  if (session.stableTimer !== undefined) window.clearTimeout(session.stableTimer);
  if (session.statsTimer !== undefined) window.clearTimeout(session.statsTimer);
  session.peer.ontrack = null;
  session.peer.onconnectionstatechange = null;
  session.peer.close();

  session.cleanupPromise = session.location
    ? deleteWHEPLocation(session.location, options)
    : Promise.resolve();
  return session.cleanupPromise;
}

async function deleteWHEPLocation(
  location: string,
  { keepalive, retryDelete }: { keepalive: boolean; retryDelete: boolean },
) {
  const attempts = retryDelete ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const { response } = await requestText(location, {
        method: "DELETE",
        keepalive,
        timeoutMs: CLEANUP_TIMEOUT_MS,
      });
      if (response.ok || response.status === 404) return;
      if (response.status !== 408 && response.status !== 429 && response.status < 500) return;
      throw new Error(`WHEP cleanup failed with ${response.status}`);
    } catch {
      // DELETE is idempotent; one bounded retry is safe outside page unload.
    }
  }
}

function resolveWHEPLocation(location: string) {
  const url = new URL(location, window.location.href);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("WHEP response Location must use HTTP or HTTPS.");
  }
  return url.toString();
}

async function waitForCleanup(cleanup: Promise<void>, timeoutMs: number) {
  let timer: number | undefined;
  await Promise.race([
    cleanup,
    new Promise<void>((resolve) => {
      timer = window.setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer !== undefined) window.clearTimeout(timer);
}

function abortError() {
  return new DOMException("The WHEP session was closed.", "AbortError");
}
