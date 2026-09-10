// Native layout/receiver regression: resize one live page across all breakpoints.
// PLAYWRIGHT_MODULE may point to an external Playwright installation.
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createServer } from "vite";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), server: { host: "127.0.0.1", port: 5199, strictPort: true } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || "chrome" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" });
  const errors = [], posts = [], deletes = [];
  page.on("pageerror", error => errors.push(error.message));
  const channels = Array.from({ length: 13 }, (_, i) => ({
    id: `channel-${i + 1}`, number: i + 1, revision: 1, name: `Channel ${i + 1}`, path: `channel-${i + 1}`,
    enabled: true, automaticPreview: true, input: { mode: "srt-push", srt: { port: 18000 + i, hasPassphrase: false } }, maxReaders: 16,
    useAbsoluteTimestamp: true, applyState: "applied", createdAt: "2026-09-10T00:00:00Z", updatedAt: "2026-09-10T00:00:00Z",
    whepPath: `/api/v1/channels/channel-${i + 1}/whep`, viewerPath: "/view", embedPath: `/embed/${i + 1}`,
    available: true, online: true, inputGeneration: "input:", inboundBytes: 0, outputInboundBytes: 0,
    outputGeneration: "output:direct", outboundBytes: 0, inboundFramesInError: 0, readers: [], readerCount: 0,
    tracks: [], outputReady: true, outputTracks: [], issues: [],
    compatibility: { state: "ready", mode: "direct", required: false, reasons: [], worker: { running: false, restarts: 0 } },
  }));
  await page.addInitScript(() => { window.testPeers = new Map(); });
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.includes("/test-session/")) {
      deletes.push(path);
      await page.evaluate(path => {
        const peer = window.testPeers.get(path);
        clearInterval(peer.timer);
        peer.getSenders().forEach(sender => sender.track?.stop());
        peer.close(); window.testPeers.delete(path);
      }, path);
      return route.fulfill({ status: 204 });
    }
    if (path.endsWith("/whep")) {
      posts.push(path);
      const session = `/api/test-session/${posts.length}`;
      const answer = await page.evaluate(async ({ sdp, session }) => {
        const peer = new RTCPeerConnection(), canvas = document.createElement("canvas");
        canvas.width = 320; canvas.height = 180;
        const pen = canvas.getContext("2d");
        pen.fillStyle = "#458f9b"; pen.fillRect(0, 0, 320, 180);
        const stream = canvas.captureStream(5);
        peer.timer = setInterval(() => { pen.fillStyle = "white"; pen.fillRect(0, 174, Date.now() / 20 % 320, 6); stream.getVideoTracks()[0].requestFrame(); }, 200);
        stream.getTracks().forEach(track => peer.addTrack(track, stream));
        window.testPeers.set(session, peer);
        await peer.setRemoteDescription({ type: "offer", sdp });
        await peer.setLocalDescription(await peer.createAnswer());
        if (peer.iceGatheringState !== "complete") await new Promise(resolve => peer.addEventListener("icegatheringstatechange", () => { if (peer.iceGatheringState === "complete") resolve(); }));
        return peer.localDescription.sdp;
      }, { sdp: request.postData(), session });
      return route.fulfill({ status: 201, headers: { "Content-Type": "application/sdp", Location: session }, body: answer });
    }
    assert.ok(["/api/v1/channels", "/api/v1/channels/runtime"].includes(path));
    return route.fulfill({ json: { channels } });
  });
  await page.goto("http://127.0.0.1:5199/view");
  await page.waitForFunction(() => [...document.querySelectorAll("video")].length === 12 && [...document.querySelectorAll("video")].every(video => video.videoWidth > 0));
  await page.evaluate(() => { window.originalVideos = [...document.querySelectorAll("video")]; });
  const results = [];
  for (const [width, height, columns] of [[1440, 900, 4], [1000, 800, 3], [700, 800, 2], [390, 844, 1], [1440, 500, 4]]) {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(columns => document.querySelector(".multiview-grid").dataset.columns === String(columns), columns);
    await page.waitForTimeout(150);
    const result = await page.evaluate(() => {
      const scroll = document.querySelector(".multiview-scroll"), tiles = [...document.querySelectorAll(".multiview-grid article")];
      const rects = tiles.map(tile => { const r = tile.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; });
      return {
        columns: getComputedStyle(document.querySelector(".multiview-grid")).gridTemplateColumns.split(" ").length,
        pictureRatios: tiles.map(tile => { const r = tile.querySelector(".multiview-picture").getBoundingClientRect(); return r.height / r.width; }),
        overflow: document.documentElement.scrollWidth > innerWidth,
        scrollable: scroll.scrollHeight > scroll.clientHeight,
        stable: [...document.querySelectorAll("video")].every((video, i) => video === window.originalVideos[i] && video.videoWidth > 0),
        overlaps: rects.some((r, i) => rects.some((s, j) => i !== j && r.x < s.right - 1 && r.right > s.x + 1 && r.y < s.bottom - 1 && r.bottom > s.y + 1)),
      };
    });
    assert.equal(result.columns, columns);
    assert.equal(result.overflow, false);
    assert.equal(result.overlaps, false);
    assert.equal(result.stable, true);
    assert.ok(result.pictureRatios.every(ratio => ratio >= 9 / 16 - 0.025), JSON.stringify(result));
    assert.equal(posts.length, 12); assert.equal(deletes.length, 0);
    if (columns < 4 || height === 500) assert.equal(result.scrollable, true);
    results.push({ width, height, ...result });
    if (process.env.RESPONSIVE_SCREENSHOTS) await page.screenshot({ path: `${process.env.RESPONSIVE_SCREENSHOTS}/responsive-${width}-${height}.png` });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector(".multiview-grid").dataset.columns === "1");
  const handle = page.getByRole("button", { name: "Move Channel 1", exact: true });
  const first = await handle.boundingBox(), second = await page.getByRole("button", { name: "Move Channel 2", exact: true }).boundingBox();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 0 }] });
  await touch("touchStart", first.x + first.width / 2, first.y + first.height / 2);
  for (let step = 1; step <= 12; step++) await touch("touchMove", first.x + first.width / 2, first.y + first.height / 2 + (second.y - first.y) * step / 12);
  await page.waitForTimeout(500);
  await touch("touchEnd");
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await page.waitForTimeout(500);
  const order = await page.evaluate(() => JSON.parse(localStorage.getItem("signal-desk.multiview-order.v1")));
  assert.deepEqual(order.slice(0, 2), ["channel-2", "channel-1"]);
  assert.equal(posts.length, 12); assert.equal(deletes.length, 0);
  const moving = await handle.boundingBox();
  await page.mouse.move(moving.x + 20, moving.y + 15); await page.mouse.down();
  await page.mouse.move(moving.x + 30, moving.y + 60);
  await page.setViewportSize({ width: 700, height: 800 });
  await page.mouse.up();
  assert.equal(await page.locator(".multiview-drag-overlay").count(), 0);
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("signal-desk.multiview-order.v1"))), order);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("heading", { name: "Channel 12", exact: true }).scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll("video").length === 1 && document.querySelector("video").videoWidth > 0);
  await page.waitForTimeout(300);
  assert.equal(posts.length, 13); assert.equal(deletes.length, 12);
  await page.getByRole("button", { name: "Previous page", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll("video").length === 12 && [...document.querySelectorAll("video")].every(video => video.videoWidth > 0));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => document.querySelector(".multiview-grid").dataset.columns === "4");
  await page.getByRole("button", { name: "Resize Channel 1 right edge", exact: true }).focus();
  await page.keyboard.press("Shift+ArrowRight");
  const sizes = await page.evaluate(() => localStorage.getItem("signal-desk.multiview-sizes.v1"));
  assert.equal(JSON.parse(sizes)["channel-1"].columns, 2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('[data-move-target="channel-1"]').style.gridColumn.includes("span 1"));
  assert.equal(await page.evaluate(() => localStorage.getItem("signal-desk.multiview-sizes.v1")), sizes);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => document.querySelector('[data-move-target="channel-1"]').style.gridColumn.includes("span 2"));
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await page.waitForTimeout(300);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ results, posts: posts.length, deletes: deletes.length }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
