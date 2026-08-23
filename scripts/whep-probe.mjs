#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const endpoint = process.argv[2];
if (!endpoint) {
  console.error("usage: node scripts/whep-probe.mjs WHEP_URL");
  process.exit(2);
}

const endpointURL = new URL(endpoint);
const chromium = process.env.CHROMIUM || "chromium";
const sampleDurationMS = Number(process.env.WHEP_SAMPLE_MS || 2_000);
if (!Number.isFinite(sampleDurationMS) || sampleDurationMS < 0) {
  console.error("WHEP_SAMPLE_MS must be a non-negative number");
  process.exit(2);
}
const profile = await mkdtemp(join(tmpdir(), "whep-probe-"));
let browser;
let socket;

async function cleanup() {
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  if (browser && browser.exitCode === null) {
    browser.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => browser.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (browser.exitCode === null) browser.kill("SIGKILL");
  }
  await rm(profile, { recursive: true, force: true });
}

try {
  browser = spawn(chromium, [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--autoplay-policy=no-user-gesture-required",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  const debuggerURL = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chromium DevTools startup timed out")), 10_000);
    let stderr = "";
    browser.stderr.setEncoding("utf8");
    browser.stderr.on("data", (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    browser.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    browser.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chromium exited during startup with code ${code}: ${stderr.trim()}`));
    });
  });

  const debuggerHTTP = new URL(debuggerURL);
  debuggerHTTP.protocol = "http:";
  debuggerHTTP.pathname = "/json/list";
  debuggerHTTP.search = "";
  const targets = await (await fetch(debuggerHTTP)).json();
  const page = targets.find((target) => target.type === "page");
  if (!page) throw new Error("Chromium did not expose a page target");

  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let commandID = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const handler = pending.get(message.id);
    if (!handler) return;
    pending.delete(message.id);
    if (message.error) handler.reject(new Error(message.error.message));
    else handler.resolve(message.result);
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++commandID;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: endpointURL.origin });
  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      const ready = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
      if (ready.result.value === "complete") break;
    } catch {
      // Navigation replaces the execution context once; retry against the new one.
    }
  }
  const expression = `(${async function probe(whepURL, sampleDurationMS) {
    const peer = new RTCPeerConnection();
    let location = "";
    const tracks = [];
    const stream = new MediaStream();
    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    document.body.append(video);
    peer.addTransceiver("video", { direction: "recvonly" });
    peer.addTransceiver("audio", { direction: "recvonly" });
    peer.addEventListener("track", (event) => {
      tracks.push(event.track.kind);
      stream.addTrack(event.track);
      video.play().catch(() => undefined);
    });

    const waitForICE = () => new Promise((resolve) => {
      if (peer.iceGatheringState === "complete") {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 5_000);
      peer.addEventListener("icegatheringstatechange", () => {
        if (peer.iceGatheringState === "complete") {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const waitForConnection = () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`WebRTC connection timed out in ${peer.connectionState} state`)), 12_000);
      const inspect = () => {
        if (peer.connectionState === "connected") {
          clearTimeout(timer);
          resolve();
        } else if (peer.connectionState === "failed" || peer.connectionState === "closed") {
          clearTimeout(timer);
          reject(new Error(`WebRTC connection entered ${peer.connectionState} state`));
        }
      };
      peer.addEventListener("connectionstatechange", inspect);
      inspect();
    });

    try {
      const sessionStarted = performance.now();
      await peer.setLocalDescription(await peer.createOffer());
      await waitForICE();
      const response = await fetch(whepURL, {
        method: "POST",
        headers: { "Content-Type": "application/sdp", Accept: "application/sdp" },
        body: peer.localDescription.sdp,
      });
      if (!response.ok) throw new Error(`WHEP POST failed with ${response.status}: ${await response.text()}`);
      const sessionLocation = response.headers.get("Location");
      if (!sessionLocation) throw new Error("WHEP response omitted the session Location header");
      location = new URL(sessionLocation, whepURL).toString();
      await peer.setRemoteDescription({ type: "answer", sdp: await response.text() });
      await waitForConnection();
      const connectionMS = performance.now() - sessionStarted;

      let firstPacketMS = null;
      let firstFrameMS = null;
      let sampleBaseline = new Map();
      const mediaDeadline = performance.now() + 5_000;
      while (performance.now() < mediaDeadline) {
        const stats = await peer.getStats();
        let receivedPacket = false;
        let decodedFrame = false;
        for (const report of stats.values()) {
          if (report.type !== "inbound-rtp") continue;
          if ((report.bytesReceived || 0) > 0) receivedPacket = true;
          if (report.kind === "video" && (report.framesDecoded || 0) > 0) decodedFrame = true;
        }
        if (receivedPacket && firstPacketMS === null) firstPacketMS = performance.now() - sessionStarted;
        if (decodedFrame && firstFrameMS === null) firstFrameMS = performance.now() - sessionStarted;
        const hasVideo = tracks.includes("video");
        if (receivedPacket && (!hasVideo || decodedFrame)) {
          sampleBaseline = new Map([...stats.values()]
            .filter((report) => report.type === "inbound-rtp")
            .map((report) => [report.id, {
              bytesReceived: report.bytesReceived || 0,
              framesDecoded: report.framesDecoded || 0,
            }]));
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await new Promise((resolve) => setTimeout(resolve, sampleDurationMS));

      const stats = await peer.getStats();
      const codecs = new Map();
      for (const report of stats.values()) {
        if (report.type === "codec") codecs.set(report.id, report.mimeType);
      }
      const inbound = [];
      for (const report of stats.values()) {
        if (report.type !== "inbound-rtp" || report.kind === undefined) continue;
        const baseline = sampleBaseline.get(report.id) || { bytesReceived: 0, framesDecoded: 0 };
        inbound.push({
          kind: report.kind,
          codec: codecs.get(report.codecId) || "",
          bytesReceived: report.bytesReceived || 0,
          sampleBytesReceived: Math.max(0, (report.bytesReceived || 0) - baseline.bytesReceived),
          packetsReceived: report.packetsReceived || 0,
          framesDecoded: report.framesDecoded || 0,
          sampleFramesDecoded: Math.max(0, (report.framesDecoded || 0) - baseline.framesDecoded),
          framesDropped: report.framesDropped || 0,
        });
      }
      const bytesReceived = inbound.reduce((total, report) => total + report.bytesReceived, 0);
      const sampleBytesReceived = inbound.reduce((total, report) => total + report.sampleBytesReceived, 0);
      if (bytesReceived === 0) throw new Error("WebRTC connected but received no media bytes");
      return {
        connected: true,
        tracks: [...new Set(tracks)].sort(),
        connectionMS,
        firstPacketMS,
        firstFrameMS,
        sampleDurationMS,
        bytesReceived,
        sampleBytesReceived,
        inbound,
      };
    } finally {
      if (location) await fetch(location, { method: "DELETE" }).catch(() => undefined);
      peer.close();
    }
  }.toString()})(${JSON.stringify(endpointURL.toString())}, ${sampleDurationMS})`;

  const evaluation = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluation.exceptionDetails) {
    throw new Error(evaluation.exceptionDetails.exception?.description || evaluation.exceptionDetails.text);
  }
  console.log(JSON.stringify(evaluation.result.value));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await cleanup();
}
