// Real Chromium receiver + actual embed/runtime polling. Only the source peer
// and HTTP API are fixtures; no deployed gateway or hardware encoder is touched.
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createServer } from "vite";

const modulePath = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(modulePath ? (modulePath.startsWith("file:") ? modulePath : pathToFileURL(modulePath).href) : "playwright");
const server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), server: { host: "127.0.0.1", port: 5175, strictPort: true } });
let browser;
let page;
let ready = false;
let generation = 1;
let posts = 0;
let deletes = 0;
const channel = () => ({
  id: "recovery", revision: 1, number: 1, name: "Recovery test", path: "recovery",
  enabled: true, automaticPreview: true, maxReaders: 16, useAbsoluteTimestamp: true,
  input: { mode: "srt-push", srt: { port: 10000, hasPassphrase: false } },
  applyState: "applied", createdAt: "2026-09-11T00:00:00Z", updatedAt: "2026-09-11T00:00:00Z",
  whepPath: "/api/v1/channels/recovery/whep", viewerPath: "/view", embedPath: "/embed/1",
  available: ready, online: ready, outputReady: ready, availableTime: String(generation), outputAvailableTime: String(generation),
  inputGeneration: `${generation}:`, outputGeneration: `${generation}:direct`,
  inboundBytes: 0, outputInboundBytes: 0, outboundBytes: 0, inboundFramesInError: 0,
  tracks: [], outputTracks: [], readers: [], readerCount: 0, issues: [],
  compatibility: { state: ready ? "ready" : "offline", mode: "direct", required: false, reasons: [], worker: { running: false, restarts: 0 } },
});
try {
  await server.listen();
  browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  page = await browser.newPage();
  page.on("pageerror", (error) => console.error(error));
  await page.route("**/api/**", (route) => route.fulfill({ json: channel() }));
  await page.route("**/recovery-session/*", async (route) => {
    assert.equal(route.request().method(), "DELETE");
    const id = Number(new URL(route.request().url()).pathname.split("/").at(-1));
    await page.evaluate((id) => { window.senders.get(id)?.close(); window.senders.delete(id); }, id);
    deletes++;
    await route.fulfill({ status: 204 });
  });
  await page.route("**/api/v1/channels/recovery/whep", async (route) => {
    assert.equal(route.request().method(), "POST");
    const id = ++posts;
    const answer = await page.evaluate(async ({ id, sdp }) => {
      const sender = new RTCPeerConnection();
      window.senders.set(id, sender);
      window.latestSender = sender;
      sender.addTrack(window.videoTrack);
      sender.addTrack(window.audioTrack);
      await sender.setRemoteDescription({ type: "offer", sdp });
      await sender.setLocalDescription(await sender.createAnswer());
      if (sender.iceGatheringState !== "complete") await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Sender ICE timed out")), 10000);
        sender.addEventListener("icegatheringstatechange", () => {
          if (sender.iceGatheringState === "complete") { clearTimeout(timer); resolve(); }
        });
      });
      return sender.localDescription.sdp;
    }, { id, sdp: route.request().postData() });
    await route.fulfill({ status: 201, headers: { "Content-Type": "application/sdp", Location: `/recovery-session/${id}` }, body: answer });
  });
  await page.goto("http://127.0.0.1:5175/embed/1");
  await page.locator("video").waitFor();
  await page.evaluate(async () => {
    window.senders = new Map();
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext("2d");
    let frame = 0;
    window.drawTimer = setInterval(() => {
      context.fillStyle = `hsl(${frame++ % 360} 100% 40%)`;
      context.fillRect(0, 0, 320, 180);
      context.fillStyle = "white";
      context.fillText(String(frame), 20, 30);
    }, 33);
    window.videoTrack = canvas.captureStream(30).getVideoTracks()[0];
    const audio = window.audioContext = new AudioContext();
    const tone = audio.createOscillator();
    const output = audio.createMediaStreamDestination();
    tone.connect(output); tone.start();
    window.audioTrack = output.stream.getAudioTracks()[0];
    await audio.resume();
    window.presentedFrames = [];
    const video = document.querySelector("video");
    const presented = (now) => {
      window.presentedFrames.push({ at: now, stream: video.srcObject?.id });
      video.requestVideoFrameCallback(presented);
    };
    video.requestVideoFrameCallback(presented);
  });
  ready = true;
  await page.waitForFunction(() => window.presentedFrames.length >= 10, null, { timeout: 15000 });
  const initialPosts = posts;
  assert.equal(initialPosts, 1);

  // A brief packet gap should recover in-place, with audio still flowing.
  await page.evaluate(async () => {
    window.videoSender = window.latestSender.getSenders().find((sender) => sender.track?.kind === "video");
    await window.videoSender.replaceTrack(null);
  });
  await page.waitForTimeout(600);
  await page.evaluate(async () => { window.beforeResume = window.presentedFrames.length; await window.videoSender.replaceTrack(window.videoTrack); });
  await page.waitForFunction(() => window.presentedFrames.length >= window.beforeResume + 10);
  assert.equal(posts, initialPosts, "brief gap replaced a healthy session");

  // No offline snapshot: output is ready before and after replacement. Keep the
  // old transport connected so only the generation marker can trigger recovery.
  const replace = await page.evaluate(() => ({ at: performance.now(), stream: document.querySelector("video").srcObject.id }));
  generation++;
  await page.waitForFunction((old) => window.presentedFrames.filter((frame) => frame.stream && frame.stream !== old).length >= 5, replace.stream);
  const generationRecoveryMs = await page.evaluate(({ at, stream }) => window.presentedFrames.find((frame) => frame.at >= at && frame.stream !== stream && frame.stream).at - at, replace);
  assert.equal(posts, initialPosts + 1);
  assert.ok(generationRecoveryMs < 3000, `Generation recovery took ${generationRecoveryMs} ms`);

  // Stop video only, leaving both audio and the peer connection active. The new
  // WHEP session is fed valid video, modelling an abandoned/stuck old reader.
  const stall = await page.evaluate(async () => {
    const stream = document.querySelector("video").srcObject.id;
    const at = performance.now();
    await window.latestSender.getSenders().find((sender) => sender.track?.kind === "video").replaceTrack(null);
    return { at, stream };
  });
  await page.waitForFunction(({ stream, at }) => window.presentedFrames.filter((frame) => frame.at >= at && frame.stream && frame.stream !== stream).length >= 5, stall, { timeout: 10000 });
  const stallRecoveryMs = await page.evaluate(({ at, stream }) => window.presentedFrames.find((frame) => frame.at >= at && frame.stream !== stream && frame.stream).at - at, stall);
  assert.equal(posts, initialPosts + 2);
  assert.ok(stallRecoveryMs < 6500, `Media-stall recovery took ${stallRecoveryMs} ms`);

  ready = false;
  await page.waitForFunction(() => document.querySelector("video").srcObject === null && window.senders.size === 0);
  assert.equal(deletes, posts, "a replaced WHEP reader was leaked");
  await page.evaluate(async () => { clearInterval(window.drawTimer); window.videoTrack.stop(); window.audioTrack.stop(); await window.audioContext.close(); });
  console.log(JSON.stringify({ generationRecoveryMs, stallRecoveryMs, shortGapPreservedSession: true, posts, deletes }));
} catch (error) {
  console.error({ posts, deletes, browser: await page?.evaluate(() => ({
    text: document.body.innerText, frames: window.presentedFrames?.length,
    senders: [...(window.senders?.values() ?? [])].map((peer) => peer.connectionState),
    video: document.querySelector("video")?.readyState,
  })).catch(() => undefined) });
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
