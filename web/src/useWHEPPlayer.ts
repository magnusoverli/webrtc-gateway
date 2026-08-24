import { useEffect, useRef, useState } from "react";
import { summarizeRTCStats, waitForICEGathering, type PreviewStats, type StatsSample } from "./webrtc";

export type WHEPPlayerState = "off" | "connecting" | "playing" | "error";

type WHEPSession = {
  peer: RTCPeerConnection;
  abort: AbortController;
  location: string;
  connectionTimer?: number;
  statsTimer?: number;
  statsSample?: StatsSample;
};

export function useWHEPPlayer({ whepPath, enabled, retry = false }: {
  whepPath: string;
  enabled: boolean;
  retry?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<WHEPPlayerState>("off");
  const [error, setError] = useState("");
  const [stats, setStats] = useState<PreviewStats | null>(null);
  const [hasVideo, setHasVideo] = useState(false);
  const [hasAudio, setHasAudio] = useState(false);

  useEffect(() => {
    let disposed = false;
    let session: WHEPSession | null = null;
    let retryTimer: number | undefined;
    let retryCount = 0;

    const clearMedia = () => {
      if (videoRef.current) videoRef.current.srcObject = null;
      setStats(null);
      setHasVideo(false);
      setHasAudio(false);
    };

    const closeSession = () => {
      const current = session;
      session = null;
      closeWHEPSession(current);
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      clearMedia();
    };

    if (!enabled || !whepPath) {
      setState("off");
      setError("");
      clearMedia();
      return () => {
        disposed = true;
      };
    }

    const start = async () => {
      if (disposed) return;
      closeSession();
      setState("connecting");
      setError("");

      const peer = new RTCPeerConnection();
      const current: WHEPSession = { peer, abort: new AbortController(), location: "" };
      const stream = new MediaStream();
      session = current;

      const fail = (message: string) => {
        if (disposed || session !== current) return;
        session = null;
        closeWHEPSession(current);
        clearMedia();
        setState("error");
        setError(message);
        if (retry) {
          const delay = Math.min(1_000 * 2 ** retryCount, 8_000);
          retryCount += 1;
          retryTimer = window.setTimeout(() => void start(), delay);
        }
      };

      peer.addTransceiver("video", { direction: "recvonly" });
      peer.addTransceiver("audio", { direction: "recvonly" });
      peer.ontrack = (event) => {
        if (disposed || session !== current) return;
        stream.addTrack(event.track);
        if (event.track.kind === "video") setHasVideo(true);
        if (event.track.kind === "audio") setHasAudio(true);
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.muted = true;
          void videoRef.current.play().catch(() => undefined);
        }
      };
      peer.onconnectionstatechange = () => {
        if (disposed || session !== current) return;
        if (peer.connectionState === "connected") {
          retryCount = 0;
          if (current.connectionTimer !== undefined) {
            window.clearTimeout(current.connectionTimer);
            current.connectionTimer = undefined;
          }
          setState("playing");
        } else if (peer.connectionState === "failed" || peer.connectionState === "closed") {
          fail("The WebRTC peer connection failed.");
        } else if (peer.connectionState === "disconnected") {
          setState("connecting");
          if (current.connectionTimer === undefined) {
            current.connectionTimer = window.setTimeout(() => {
              fail("The media session disconnected. Verify browser-compatible codecs; H264 streams must not contain B-frames.");
            }, 3_000);
          }
        }
      };

      try {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await waitForICEGathering(peer);
        if (disposed || session !== current || !peer.localDescription?.sdp) return;

        const response = await fetch(whepPath, {
          method: "POST",
          headers: { "Content-Type": "application/sdp", Accept: "application/sdp" },
          body: peer.localDescription.sdp,
          signal: current.abort.signal,
        });
        if (!response.ok) {
          const detail = await response.text();
          throw new Error(detail || `WHEP request failed with ${response.status}`);
        }
        const location = response.headers.get("Location");
        if (location) current.location = new URL(location, window.location.href).toString();
        const answer = await response.text();
        if (!answer) throw new Error("WHEP response did not contain an SDP answer.");
        if (disposed || session !== current) return;
        await peer.setRemoteDescription({ type: "answer", sdp: answer });
        if (disposed || session !== current) return;
        if (peer.connectionState !== "connected") {
          current.connectionTimer = window.setTimeout(() => {
            fail("ICE could not connect. Allow the configured WebRTC media port through the host firewall, verify the advertised LAN host, or enable the TCP fallback in Global settings.");
          }, 12_000);
        }

        const updateStats = async () => {
          if (disposed || session !== current) return;
          const report = await peer.getStats();
          if (disposed || session !== current) return;
          const result = summarizeRTCStats(report, current.statsSample);
          current.statsSample = result.sample;
          setStats(result.stats);
        };
        await updateStats();
        if (disposed || session !== current) return;
        current.statsTimer = window.setInterval(() => void updateStats(), 1_000);
      } catch (caught) {
        if (current.abort.signal.aborted || disposed || session !== current) return;
        fail(caught instanceof Error ? caught.message : "Unable to start WebRTC preview.");
      }
    };

    void start();
    return () => {
      disposed = true;
      closeSession();
    };
  }, [enabled, retry, whepPath]);

  return { videoRef, state, error, stats, hasVideo, hasAudio };
}

function closeWHEPSession(session: WHEPSession | null) {
  if (!session) return;
  session.abort.abort();
  if (session.connectionTimer !== undefined) window.clearTimeout(session.connectionTimer);
  if (session.statsTimer !== undefined) window.clearInterval(session.statsTimer);
  session.peer.ontrack = null;
  session.peer.onconnectionstatechange = null;
  session.peer.close();
  if (session.location) {
    void fetch(session.location, { method: "DELETE", keepalive: true }).catch(() => undefined);
  }
}
