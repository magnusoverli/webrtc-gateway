import { useEffect, useRef, useState } from "react";

export type AudioMeterContextState = "initializing" | "running" | "suspended" | "interrupted" | "closed" | "unsupported" | "error";

function contextState(context: AudioContext): AudioMeterContextState {
  const state: string = context.state;
  return state === "running" || state === "suspended" || state === "interrupted" || state === "closed" ? state : "error";
}

/** Call once per grid, not once per tile. The context is used only for silent analysis. */
export function useAudioMeterContext(): { context: AudioContext | null; state: AudioMeterContextState; enable: () => void } {
  const [value, setValue] = useState<{ context: AudioContext | null; state: AudioMeterContextState }>({ context: null, state: "initializing" });
  const enableRef = useRef<() => void>(() => {});

  useEffect(() => {
    let disposed = false;
    let context: AudioContext | null = null;
    let pending = false;
    const publish = () => {
      if (!disposed && context) setValue({ context, state: contextState(context) });
    };
    const create = () => {
      if (typeof AudioContext === "undefined") {
        setValue({ context: null, state: "unsupported" });
        return;
      }
      try {
        context = new AudioContext();
        context.addEventListener("statechange", publish);
        publish();
      } catch {
        setValue({ context: null, state: "error" });
      }
    };
    const close = (owned: AudioContext) => {
      try { void owned.close().catch(() => {}); } catch { /* Already closed or unavailable. */ }
    };
    enableRef.current = () => {
      if (disposed || pending) return;
      if (!context) create();
      if (!context || context.state === "closed") return;
      if (context.state === "running") { publish(); return; }
      const owned = context;
      try {
        // Do not defer this call: resume must retain the toolbar's user activation.
        const resume = owned.resume();
        pending = true;
        void resume.then(() => {
          pending = false;
          if (disposed) {
            if (owned.state !== "closed") close(owned);
          } else publish();
        }, () => {
          pending = false;
          if (!disposed) setValue({ context: owned, state: owned.state === "running" ? "running" : "error" });
        });
      } catch {
        setValue({ context: owned, state: "error" });
      }
    };
    create();
    return () => {
      disposed = true;
      enableRef.current = () => {};
      if (context) {
        context.removeEventListener("statechange", publish);
        close(context);
      }
    };
  }, []);

  return { ...value, enable: () => enableRef.current() };
}

const FLOOR = -60;
const percent = (db: number) => `${(db - FLOOR) / -FLOOR * 100}%`;
const dbfs = (amplitude: number) => Math.max(FLOOR, Math.min(0, 20 * Math.log10(amplitude)));

export function AudioMeter({ track, context, name }: { track: MediaStreamTrack | null; context: AudioContext | null; name: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  let reported: number | undefined;
  try { reported = track?.getSettings().channelCount; } catch { /* Some receivers omit settings. */ }
  const known = typeof reported === "number" && Number.isFinite(reported) && reported >= 1;
  const count = known ? Math.min(8, Math.floor(reported!)) : 2;
  const labels = Array.from({ length: count }, (_, i) => known && reported === 1 ? "M" : known && reported === 2 ? ["L", "R"][i] : String(i + 1));
  const description = known
    ? `${count < reported! ? `First ${count} of ${reported}` : count} decoded channel${count === 1 ? "" : "s"}; receiver/browser downmix may differ from source channels.`
    : "First two decoded channels (channel count unknown); these slots may include silence or a browser downmix, not all source channels.";

  useEffect(() => {
    const root = rootRef.current!;
    const bars = Array.from(root.querySelectorAll<HTMLElement>(".audio-meter-channel"));
    const fills = bars.map((bar) => bar.querySelector<HTMLElement>(".audio-meter-fill")!);
    const peaks = bars.map((bar) => bar.querySelector<HTMLElement>(".audio-meter-peak")!);
    const status = root.querySelector<HTMLElement>(".audio-meter-status")!;
    const nodes: AudioNode[] = [];
    const analysers: AnalyserNode[] = [];
    const buffers: Float32Array<ArrayBuffer>[] = [];
    const levels = bars.map(() => ({ rms: FLOOR, peak: FLOOR, holdUntil: 0, clipUntil: 0 }));
    let frame: number | null = null;
    let disposed = false;
    let pageHidden = false;
    let failed = false;
    let lastSample = -Infinity;
    let lastAria = -Infinity;
    let displayedState = "";

    const disconnect = () => {
      for (const node of nodes) {
        try { node.disconnect(); } catch { /* A partially created graph may already be disconnected. */ }
      }
      nodes.length = 0;
    };
    const state = () => {
      if (pageHidden || document.visibilityState === "hidden") return ["hidden", "Meter paused while page is hidden"];
      if (!track) return ["no-track", "No audio track"];
      if (track.readyState === "ended") return ["ended", "Audio track ended"];
      if (track.muted) return ["muted", "Audio track muted"];
      if (!track.enabled) return ["disabled", "Audio track disabled"];
      if (!context) return ["unavailable", "Audio metering unavailable"];
      if (failed) return ["error", "Audio analysis unavailable"];
      const current = contextState(context);
      if (current !== "running") return [current, `Audio context ${current}${current === "suspended" ? "; enable meters to resume" : ""}`];
      return ["running", "RMS and sample peak in dBFS (not true peak or LUFS)"];
    };
    const showState = (next: string, message: string) => {
      if (displayedState === next) return;
      displayedState = next;
      root.dataset.state = next;
      root.classList.toggle("unavailable", next !== "running");
      root.title = `${message}. ${description}`;
      status.textContent = next === "running" ? "" : message;
      lastSample = lastAria = -Infinity;
      bars.forEach((bar, i) => {
        levels[i] = { rms: FLOOR, peak: FLOOR, holdUntil: 0, clipUntil: 0 };
        fills[i].style.height = "0%";
        peaks[i].style.bottom = "0%";
        peaks[i].hidden = true;
        bar.classList.remove("is-clipping");
        bar.dataset.level = "green";
        bar.removeAttribute("aria-valuenow");
        bar.setAttribute("aria-valuetext", next === "running" ? "Awaiting audio sample" : message);
        bar.setAttribute("aria-disabled", String(next !== "running"));
      });
    };
    const sample = (now: number) => {
      frame = null;
      if (disposed) return;
      const [next, message] = state();
      showState(next, message);
      if (next === "running" && now - lastSample >= 1000 / 25) {
        const elapsed = Number.isFinite(lastSample) ? Math.min(0.25, (now - lastSample) / 1000) : 0;
        lastSample = now;
        const updateAria = now - lastAria >= 250;
        try {
          analysers.forEach((analyser, i) => {
            const buffer = buffers[i];
            analyser.getFloatTimeDomainData(buffer);
            let sum = 0;
            let max = 0;
            for (const value of buffer) { sum += value * value; max = Math.max(max, Math.abs(value)); }
            const rms = dbfs(Math.sqrt(sum / buffer.length));
            const peak = dbfs(max);
            const level = levels[i];
            level.rms = Math.max(rms, level.rms - elapsed * 24);
            // Equal tones vary slightly between sampled windows; keep their hold alive.
            if (peak >= level.peak - 0.1) { level.peak = Math.max(peak, level.peak); level.holdUntil = now + 1000; }
            else if (now > level.holdUntil) level.peak = Math.max(peak, level.peak - elapsed * 18);
            if (peak >= -0.5) level.clipUntil = now + 1000;
            const clipping = now < level.clipUntil;
            const bar = bars[i];
            bar.classList.toggle("is-clipping", clipping);
            bar.dataset.level = level.rms >= -6 ? "red" : level.rms >= -18 ? "amber" : "green";
            fills[i].style.height = percent(level.rms);
            peaks[i].hidden = false;
            peaks[i].style.bottom = percent(level.peak);
            if (updateAria) {
              bar.setAttribute("aria-valuenow", rms.toFixed(1));
              bar.setAttribute("aria-valuetext", `RMS ${rms <= FLOOR ? "at or below " : ""}${rms.toFixed(1)} dBFS; sample peak ${peak.toFixed(1)} dBFS${clipping ? "; near full scale" : ""}`);
            }
          });
          if (updateAria) lastAria = now;
        } catch {
          failed = true;
          disconnect();
          showState("error", "Audio analysis unavailable");
        }
      }
      // Track.enabled has no event; keep checking it without reading analyser data.
      if (!failed && (next === "running" || next === "disabled")) frame = requestAnimationFrame(sample);
    };
    const refresh = () => {
      if (disposed) return;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      const [next, message] = state();
      showState(next, message);
      if (next === "running" || next === "disabled") frame = requestAnimationFrame(sample);
    };
    const hide = () => { pageHidden = true; refresh(); };
    const show = () => { pageHidden = false; refresh(); };

    if (track && context && track.readyState !== "ended" && context.state !== "closed") {
      try {
        const source = context.createMediaStreamSource(new MediaStream([track]));
        nodes.push(source);
        const splitter = context.createChannelSplitter(count);
        nodes.push(splitter);
        splitter.channelCount = count;
        splitter.channelCountMode = "explicit";
        splitter.channelInterpretation = "discrete";
        const silent = context.createGain();
        nodes.push(silent);
        // Set before connecting anything to destination. Never connect a source bypass.
        silent.gain.value = 0;
        silent.connect(context.destination);
        source.connect(splitter);
        for (let i = 0; i < count; i++) {
          const analyser = context.createAnalyser();
          nodes.push(analyser);
          analyser.fftSize = 2048;
          analyser.smoothingTimeConstant = 0;
          splitter.connect(analyser, i, 0);
          analyser.connect(silent);
          analysers.push(analyser);
          buffers.push(new Float32Array(analyser.fftSize));
        }
      } catch {
        failed = true;
        disconnect();
      }
    }
    track?.addEventListener("mute", refresh);
    track?.addEventListener("unmute", refresh);
    track?.addEventListener("ended", refresh);
    context?.addEventListener("statechange", refresh);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    refresh();
    return () => {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      track?.removeEventListener("mute", refresh);
      track?.removeEventListener("unmute", refresh);
      track?.removeEventListener("ended", refresh);
      context?.removeEventListener("statechange", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
      disconnect();
    };
  }, [track, context, count, description]);

  return (
    <div ref={rootRef} className="audio-meter unavailable" role="group" aria-label={`${name} audio meters`} data-state="unavailable" title={description}>
      <div className="audio-meter-axis" aria-hidden="true">
        {[0, -6, -18, -60].map((db) => <span key={db} style={{ bottom: percent(db) }}>{db}</span>)}
        <span className="audio-meter-unit">dBFS</span>
      </div>
      {labels.map((label, i) => (
        <div className="audio-meter-channel" key={i} role="meter" aria-label={`${name} channel ${label}`} aria-valuemin={FLOOR} aria-valuemax={0} aria-valuetext="Audio metering unavailable" title={`Decoded channel ${label}. ${description}`}>
          {/* Parent CSS positions fill at bottom:0 and peak absolutely; percentages map -60..0 dBFS linearly. */}
          <span className="audio-meter-fill" aria-hidden="true" />
          <span className="audio-meter-peak" aria-hidden="true" />
          <span className="audio-meter-clip" aria-hidden="true" />
          <span className="audio-meter-label" aria-hidden="true">{label}</span>
        </div>
      ))}
      <span className="audio-meter-status" />
    </div>
  );
}
