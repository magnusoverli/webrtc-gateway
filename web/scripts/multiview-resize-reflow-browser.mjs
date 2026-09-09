// Native regression: continuous size updates within one reserved footprint must
// not cancel/restart neighbouring tiles' FLIP animations on every mouse event.
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createServer } from "vite";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), server: { host: "127.0.0.1", port: 5199, strictPort: true } });
const channels = Array.from({ length: 6 }, (_, i) => ({
  id: `channel-${i + 1}`, number: i + 1, revision: 1, name: `Channel ${i + 1}`, path: `channel-${i + 1}`, enabled: true,
  automaticPreview: true, input: { mode: "srt-push", srt: { port: 10000, hasPassphrase: false } }, maxReaders: 16,
  useAbsoluteTimestamp: true, applyState: "applied", createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z",
  whepPath: `/api/v1/channels/channel-${i + 1}/whep`, viewerPath: "/view", embedPath: `/embed/${i + 1}`,
  available: false, online: false, outputReady: false, inboundBytes: 0, outputInboundBytes: 0, outboundBytes: 0,
  readers: [], readerCount: 0, tracks: [], outputTracks: [], issues: [],
  compatibility: { state: "offline", mode: "direct", required: false, reasons: [], worker: { running: false, restarts: 0 } },
}));
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", route => route.fulfill({ json: { channels } }));
  await page.goto("http://127.0.0.1:5199/view");
  await page.locator("article").nth(5).waitFor();
  await page.evaluate(() => {
    window.moves = []; window.positions = []; window.sampling = true;
    const original = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      if (this.dataset.moveTarget === "channel-2") window.moves.push(performance.now());
      return original.apply(this, args);
    };
    const sample = () => {
      window.positions.push(document.querySelector('article[data-move-target="channel-2"]').getBoundingClientRect().left);
      if (window.sampling) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const grip = page.getByRole("button", { name: "Resize Channel 1 right edge" });
  const box = await grip.boundingBox();
  const step = await page.locator(".multiview-grid").evaluate(grid => (grid.getBoundingClientRect().width + parseFloat(getComputedStyle(grid).columnGap)) / 4);
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  for (let i = 1; i <= 40; i++) {
    await page.mouse.move(x + step * 0.45 * i / 40, y);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  }
  await page.mouse.up();
  await page.waitForFunction(() => [...document.querySelectorAll("article")].every(tile => tile.getAnimations().length === 0));
  const result = await page.evaluate(() => {
    window.sampling = false;
    return { animationStarts: window.moves.length, maximumBackwardJump: Math.max(0, ...window.positions.slice(1).map((x, i) => window.positions[i] - x)), travel: window.positions.at(-1) - window.positions[0] };
  });
  console.log(JSON.stringify(result));
  assert.equal(result.animationStarts, 1, "One layout change must produce one animation, not an animation per resize event");
  assert.ok(result.maximumBackwardJump <= 1, "Displaced tile must not flicker backwards");
  assert.ok(Math.abs(result.travel - step) < 1, "Neighbour must arrive one column to the right");
  // Further fine adjustments within those cells must not restart a settled
  // neighbour either; crossing the next cell boundary should animate once.
  await grip.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.evaluate(() => window.moves.length), 1);
  await page.keyboard.press("Shift+ArrowRight");
  await page.waitForFunction(() => [...document.querySelectorAll("article")].every(tile => tile.getAnimations().length === 0));
  assert.equal(await page.evaluate(() => window.moves.length), 2);
  // Cancelling an in-flight reflow returns from the current visual position,
  // without retaining a transform belonging to the abandoned destination.
  await page.getByRole("button", { name: "Reset Channel 1 size" }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("article")].every(tile => tile.getAnimations().length === 0));
  const origin = await page.locator('article[data-move-target="channel-2"]').boundingBox();
  const again = await grip.boundingBox();
  await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2); await page.mouse.down();
  await page.mouse.move(again.x + again.width / 2 + step * 0.2, again.y + again.height / 2);
  await page.keyboard.press("Escape"); await page.mouse.up();
  await page.waitForFunction(() => [...document.querySelectorAll("article")].every(tile => tile.getAnimations().length === 0));
  const restored = await page.locator('article[data-move-target="channel-2"]').boundingBox();
  assert.ok(Math.abs(restored.x - origin.x) < 1);
  assert.deepEqual(errors, []);
} finally { await browser?.close(); await server.close(); }
