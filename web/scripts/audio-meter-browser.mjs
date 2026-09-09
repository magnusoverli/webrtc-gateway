// Native Chrome regression: real Opus encoding/decoding through the WHEP player,
// with only the HTTP signaling endpoint supplied by a local peer (no live server).
// Run from web: PLAYWRIGHT_MODULE=<module path or file URL> node scripts/audio-meter-browser.mjs
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createServer } from "vite";

const modulePath = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(modulePath ? (modulePath.startsWith("file:") ? modulePath : pathToFileURL(modulePath).href) : "playwright");
const server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), server: { host: "127.0.0.1", port: 5174, strictPort: true } });
let browser;
let deletes = 0;
try {
  await server.listen();
  browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || "chrome", headless: true });
  const page = await browser.newPage();
  await page.route("**/api/**", (route) => route.fulfill({ json: { channels: [] } }));
  await page.route("**/meter-session", async (route) => {
    assert.equal(route.request().method(), "DELETE");
    deletes++;
    await page.evaluate(() => window.sender.close());
    await route.fulfill({ status: 204 });
  });
  await page.route("**/meter-whep", async (route) => {
    const offer = route.request().postData();
    assert.match(offer, /a=fmtp:\d+ [^\r\n]*stereo=1/);
    const answer = await page.evaluate(async (sdp) => {
      const sender = window.sender = new RTCPeerConnection();
      sender.addTrack(window.testSource.stream.getAudioTracks()[0], window.testSource.stream);
      await sender.setRemoteDescription({ type: "offer", sdp });
      await sender.setLocalDescription(await sender.createAnswer());
      if (sender.iceGatheringState !== "complete") await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Sender ICE timed out")), 10000);
        sender.addEventListener("icegatheringstatechange", () => {
          if (sender.iceGatheringState === "complete") { clearTimeout(timer); resolve(); }
        });
      });
      return sender.localDescription.sdp;
    }, offer);
    await route.fulfill({ status: 201, headers: { "Content-Type": "application/sdp", Location: "/meter-session" }, body: answer });
  });
  await page.goto("http://127.0.0.1:5174/view");
  await page.evaluate(async () => {
    const { default: React } = await import("/node_modules/.vite/deps/react.js");
    const { default: { createRoot } } = await import("/node_modules/.vite/deps/react-dom_client.js");
    const { AudioMeter, useAudioMeterContext } = await import("/src/AudioMeter.tsx");
    const { useWHEPPlayer } = await import("/src/useWHEPPlayer.ts");
    const context = window.sourceContext = new AudioContext();
    const output = window.testSource = context.createMediaStreamDestination();
    const merger = context.createChannelMerger(2);
    merger.connect(output);
    window.toneGains = [0.5, 0.125].map((amplitude, i) => {
      const oscillator = context.createOscillator();
      oscillator.frequency.value = [440, 880][i];
      const gain = context.createGain();
      gain.gain.value = amplitude;
      oscillator.connect(gain).connect(merger, 0, i);
      oscillator.start();
      return gain;
    });
    const h = React.createElement;
    function Harness() {
      const player = useWHEPPlayer({ whepPath: "/meter-whep", enabled: true });
      const meter = useAudioMeterContext();
      window.receiverTrack = player.audioTrack;
      window.meterContext = meter.context;
      return h("div", null,
        h("button", { onClick: () => { void context.resume(); } }, "Start native test"),
        h("div", { className: "multiview-picture", style: { width: "100%", height: 180 } },
          h("video", { ref: player.videoRef, muted: true, autoPlay: true }),
          h(AudioMeter, { track: player.audioTrack, context: meter.context, name: "Native" })));
    }
    const element = document.createElement("div");
    document.body.append(element);
    window.testRoot = createRoot(element);
    window.testRoot.render(h(Harness));
  });
  await page.getByRole("button", { name: "Start native test" }).waitFor();
  await page.waitForFunction(() => window.receiverTrack);
  const initialCount = await page.evaluate(() => window.receiverTrack.getSettings().channelCount);
  await page.getByRole("button", { name: "Start native test" }).click();
  const values = () => page.getByRole("meter").evaluateAll((bars) => bars.map((b) => Number(b.getAttribute("aria-valuenow"))));
  await page.waitForFunction(() => [...document.querySelectorAll('[role="meter"]')].every((b) => b.hasAttribute("aria-valuenow") && Number(b.getAttribute("aria-valuenow")) > -40));
  await page.waitForTimeout(1500);
  const stereo = await values();
  assert.equal(stereo.length, 2);
  assert.ok(Math.abs(stereo[0] - (-9.03)) < 2, `Left tone RMS: ${stereo}`);
  assert.ok(Math.abs(stereo[1] - (-21.07)) < 2, `Right tone RMS: ${stereo}`);
  for (const viewport of [{ width: 1600, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const layout = await page.locator(".multiview-picture").evaluate((picture) => {
      const meter = picture.querySelector(".audio-meter");
      const p = picture.getBoundingClientRect(), m = meter.getBoundingClientRect();
      return {
        flush: m.top === p.top && m.bottom === p.bottom && m.right === p.right,
        slim: m.width <= 33,
        labelsInside: [...meter.querySelectorAll(".audio-meter-axis > span,.audio-meter-label,.audio-meter-clip")].every((label) => {
          const r = label.getBoundingClientRect();
          return r.left >= m.left && r.right <= m.right && r.top >= m.top && r.bottom <= m.bottom;
        }),
        nonblocking: getComputedStyle(meter).pointerEvents === "none",
      };
    });
    assert.deepEqual(layout, { flush: true, slim: true, labelsInside: true, nonblocking: true });
  }
  // Independent source change must affect R alone after real Opus transmission.
  await page.evaluate(() => { window.toneGains[1].gain.value = 0; });
  await page.waitForTimeout(2000);
  const rightSilent = await values();
  assert.ok(rightSilent[0] > -12 && rightSilent[1] <= -59, `No fake duplication: ${rightSilent}`);
  assert.equal(await page.locator("video").last().evaluate((video) => video.muted), true);
  // Chrome may upmix an actual mono MediaStream before the discrete splitter.
  // Record that separately; it must not be mistaken for independent source stereo.
  await page.evaluate(async () => {
    window.testRoot.unmount();
    const { default: React } = await import("/node_modules/.vite/deps/react.js");
    const { default: { createRoot } } = await import("/node_modules/.vite/deps/react-dom_client.js");
    const { AudioMeter } = await import("/src/AudioMeter.tsx");
    const context = window.sourceContext;
    const mono = new MediaStreamAudioDestinationNode(context, { channelCount: 1 });
    window.monoDestination = mono;
    window.toneGains[0].connect(mono);
    const element = document.createElement("div"); document.body.append(element);
    window.testRoot = createRoot(element);
    window.testRoot.render(React.createElement(AudioMeter, { track: mono.stream.getAudioTracks()[0], context, name: "Mono" }));
  });
  await page.waitForTimeout(1500);
  const mono = await values();
  const monoCount = await page.evaluate(() => window.monoDestination.stream.getAudioTracks()[0].getSettings().channelCount);
  assert.equal(monoCount, 1);
  assert.ok(Math.abs(mono[0] + 9.03) < 1, `Mono level: ${mono}`);
  assert.ok(mono[1] === -60 || Math.abs(mono[1] - mono[0]) < 1, `Mono or browser upmix: ${mono}`);
  await page.evaluate(async () => { window.testRoot.unmount(); await window.sourceContext.close(); });
  assert.equal(deletes, 1, "WHEP session deleted on unmount");
  console.log(JSON.stringify({ initialCount: initialCount ?? "omitted", stereo, rightSilent, monoCount, mono, deletes, mutedPlayback: true }));
} finally {
  await browser?.close();
  await server.close();
}
