// Native Chrome pointer/FLIP regression, isolated from any gateway. WHEP signaling
// is fulfilled by local browser peers sending synthetic canvas video and audio.
// Run from web with PLAYWRIGHT_MODULE set if Playwright is installed elsewhere.
// Set SORT_SCREENSHOTS to an existing directory to retain before/during/after PNGs.
// SORT_SIX_ONLY=1 runs the five-live/one-offline motion regression only;
// SORT_HEADED=1 and SORT_VIEWPORT=desktop|mobile|short narrow native diagnostics.
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createServer } from "vite";

const modulePath = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(modulePath ? (modulePath.startsWith("file:") ? modulePath : pathToFileURL(modulePath).href) : "playwright");
const server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), server: { host: "127.0.0.1", port: 5198, strictPort: true } });
const key = "signal-desk.multiview-order.v1";
const channels = Array.from({ length: 13 }, (_, i) => {
  const number = i + 1, id = `channel-${number}`, ready = number !== 11;
  return {
    id, number, revision: 1, name: `Channel ${number}`, path: id, enabled: true, automaticPreview: true,
    input: { mode: "srt-push", srt: { port: 10000, hasPassphrase: false } }, maxReaders: 16,
    useAbsoluteTimestamp: true, applyState: "applied", createdAt: "2026-08-25T08:00:00Z", updatedAt: "2026-08-25T08:00:00Z",
    whepPath: `/api/v1/channels/${id}/whep`, viewerPath: "/view", embedPath: `/embed/${number}`,
    available: ready, online: ready, inputGeneration: "input:", inboundBytes: 0, outputInboundBytes: 0,
    outputGeneration: "output:direct", outboundBytes: 0, inboundFramesInError: 0, readers: [], readerCount: 0,
    tracks: [], outputReady: ready, outputTracks: [], issues: [],
    compatibility: { state: ready ? "ready" : "offline", mode: "direct", required: false, reasons: [], worker: { running: false, restarts: 0 } },
  };
});
let browser;
const results = [];
try {
  await server.listen();
  browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || "chrome", headless: process.env.SORT_HEADED !== "1" });
  for (const [name, width, height, touch] of [["desktop", 1440, 900, false], ["mobile", 390, 844, true], ["short", 1280, 420, false]]) {
    if (process.env.SORT_VIEWPORT && process.env.SORT_VIEWPORT !== name) continue;
    const context = await browser.newContext({ viewport: { width, height }, isMobile: touch, hasTouch: touch, reducedMotion: "no-preference" });
    const page = await context.newPage();
    const errors = [], posts = [], deletes = [];
    let fixture = [...channels.slice(0, 5), channels[10]];
    let runtimePolls = 0;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.senders = new Map();
      window.captures = [];
      document.addEventListener("gotpointercapture", (event) => window.captures.push({ trusted: event.isTrusted, type: event.pointerType }));
    });
    await page.route("**/api/**", async (route) => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path.includes("/sort-session/")) {
        assert.equal(request.method(), "DELETE");
        deletes.push(path);
        await page.evaluate((path) => {
          const sender = window.senders.get(path);
          clearInterval(sender?.testTimer);
          sender?.getSenders().forEach((sender) => sender.track?.stop());
          sender?.close(); window.senders.delete(path);
        }, path);
        return route.fulfill({ status: 204 });
      }
      if (path.endsWith("/whep")) {
        assert.equal(request.method(), "POST");
        posts.push(path);
        const number = Number(path.match(/channel-(\d+)/)[1]);
        const session = `/api/sort-session/${posts.length}`;
        const answer = await page.evaluate(async ({ sdp, number, session }) => {
          const sender = new RTCPeerConnection();
          window.senders.set(session, sender);
          let stream;
          if (number === 12) {
            const audio = window.testAudio = new AudioContext();
            const oscillator = audio.createOscillator(), output = audio.createMediaStreamDestination();
            oscillator.connect(output); oscillator.start();
            stream = output.stream;
          } else {
            const canvas = document.createElement("canvas");
            canvas.width = 320; canvas.height = 180;
            const pen = canvas.getContext("2d");
            ["#d5ba49", "#58afb1", "#6dab63", "#976abb", "#bc6672", "#405683"].forEach((color, i) => {
              pen.fillStyle = color; pen.fillRect(i * 54, 0, 54, 180);
            });
            pen.fillStyle = "#122322"; pen.fillRect(0, 110, 320, 55);
            pen.font = "bold 20px sans-serif"; pen.fillStyle = "white"; pen.fillText(`LOCAL TEST ${number}`, 22, 143);
            stream = canvas.captureStream(4);
            sender.testTimer = setInterval(() => {
              pen.fillStyle = "white"; pen.fillRect(0, 174, (Date.now() / 20) % 320, 6);
              stream.getVideoTracks()[0].requestFrame();
            }, 250);
          }
          stream.getTracks().forEach((track) => sender.addTrack(track, stream));
          await sender.setRemoteDescription({ type: "offer", sdp });
          await sender.setLocalDescription(await sender.createAnswer());
          if (sender.iceGatheringState !== "complete") await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Local sender ICE timed out")), 10000);
            sender.addEventListener("icegatheringstatechange", () => {
              if (sender.iceGatheringState === "complete") { clearTimeout(timer); resolve(); }
            });
          });
          return sender.localDescription.sdp;
        }, { sdp: request.postData(), number, session });
        return route.fulfill({ status: 201, headers: { "Content-Type": "application/sdp", Location: session }, body: answer });
      }
      if (["/api/v1/channels", "/api/v1/channels/runtime"].includes(path)) {
        if (path.endsWith("/runtime")) runtimePolls++;
        return route.fulfill({ json: { channels: fixture.map(channel => ({ ...channel, inboundBytes: runtimePolls * 1000 })) } });
      }
      throw new Error(`Unexpected API ${request.method()} ${path}`);
    });
    const tiles = page.locator("article[data-move-target]");
    const tile = (id) => page.locator(`article[data-move-target="${id}"]`);
    const handle = (id) => tile(id).locator(".multiview-titlebar-drag");
    const point = async (locator) => { const b = await locator.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
    const domIDs = () => tiles.evaluateAll((tiles) => tiles.map((tile) => tile.dataset.moveTarget));
    const ids = () => proposed();
    const proposed = () => tiles.evaluateAll((tiles) => tiles.sort((a, b) => Number(a.style.order) - Number(b.style.order)).map((tile) => tile.dataset.moveTarget));
    const saved = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), key);
    const shot = async (suffix) => { if (process.env.SORT_SCREENSHOTS) await page.screenshot({ path: `${process.env.SORT_SCREENSHOTS}/sort-half-overlap-${name}-${suffix}.png` }); };
    const cdp = touch ? await context.newCDPSession(page) : null;
    let gripOffset = { x: 0, y: 0 };
    // Test destinations describe the full ghost center, not the captured handle.
    const over = (p) => ({ x: p.x + gripOffset.x, y: p.y + gripOffset.y });
    const rawMove = async (p) => {
      if (touch) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...p, id: 1 }] });
      else await page.mouse.move(p.x, p.y);
    };
    const move = async (p, explicitPointer = false) => {
      await rawMove(explicitPointer ? p : over(p));
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    const start = async (id) => {
      const title = await handle(id).boundingBox();
      // Press off-centre on the right, as the pointer-versus-overlap checks require.
      const p = { x: title.x + title.width * 3 / 4, y: title.y + title.height / 2 };
      const center = await point(tile(id));
      gripOffset = { x: p.x - center.x, y: p.y - center.y };
      if (touch) await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...p, id: 1 }] });
      else { await page.mouse.move(p.x, p.y); await page.mouse.down(); }
      return p;
    };
    const end = async (cancel = false) => {
      if (touch) await cdp.send("Input.dispatchTouchEvent", { type: cancel ? "touchCancel" : "touchEnd", touchPoints: [] });
      else await page.mouse.up();
    };
    const clean = async (settle = false) => {
      assert.equal(await page.locator(".multiview-drag-overlay,article.is-dragging,article.is-drop-target,[role=dialog]").count(), 0);
      if (settle) await page.waitForFunction(() => [...document.querySelectorAll("article")].every(tile => tile.getAnimations().length === 0), null, { timeout: 1500 });
      assert.equal(await tiles.evaluateAll((tiles) => tiles.flatMap((tile) => tile.getAnimations()).length), 0);
    };
    await page.goto("http://127.0.0.1:5198/view");
    await tiles.first().waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll("article video")].filter(video => video.videoWidth > 0 && video.readyState >= 2 && video.getVideoPlaybackQuality().totalVideoFrames >= 3).length === 5);
    await page.evaluate(() => document.fonts.ready);
    const automationReducedMotion = await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
    assert.equal(automationReducedMotion, false);
    // Start sampling BEFORE input: no screenshots, paused animations, or waits between
    // crossing the nearby slot boundary and releasing the pointer.
    const sixLayout = await tiles.evaluateAll(tiles => tiles.map(tile => {
      const r = tile.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
    }));
    const sixPosts = posts.length, sixDeletes = deletes.length;
    const titleBar = await handle("channel-1").boundingBox();
    const headerBox = await tile("channel-1").locator("header").boundingBox();
    assert.ok(Math.abs(titleBar.width - headerBox.width) < 1 && Math.abs(titleBar.height - headerBox.height) < 2);
    assert.equal(await handle("channel-1").locator("svg").count(), 0);
    assert.equal(await tile("channel-1").locator("h2").evaluate(title => {
      const r = title.getBoundingClientRect();
      return document.elementFromPoint(r.left + Math.min(3, r.width / 2), r.top + r.height / 2)?.classList.contains("multiview-titlebar-drag");
    }), true, "Channel title must hit the title-bar drag surface");
    const outsideEdge = Math.min(3, await page.locator(".multiview-grid").evaluate(grid => parseFloat(getComputedStyle(grid).gap) / 2 - 1));
    for (const [edge, cursor] of [["left", "ew-resize"], ["right", "ew-resize"], ["top", "ns-resize"], ["bottom", "ns-resize"]]) {
      for (const fraction of [0.25, 0.75]) {
        for (const inset of [3, -outsideEdge]) {
          const hit = await tile("channel-1").evaluate((tile, { edge, fraction, inset }) => {
            const r = tile.getBoundingClientRect();
            const x = edge === "left" ? r.left + inset : edge === "right" ? r.right - inset : r.left + r.width * fraction;
            const y = edge === "top" ? r.top + inset : edge === "bottom" ? r.bottom - inset : r.top + r.height * fraction;
            const node = document.elementFromPoint(x, y);
            return { label: node?.closest('[role="button"]')?.getAttribute("aria-label"), cursor: node && getComputedStyle(node).cursor };
          }, { edge, fraction, inset });
          assert.deepEqual(hit, { label: `Resize Channel 1 ${edge} edge`, cursor }, `${name}: resize target at ${fraction} of ${edge} edge, inset ${inset}`);
        }
      }
    }
    // Resize from well away from the stock centre grip, with native mouse/touch.
    const initialTile = await tile("channel-1").boundingBox();
    const away = { x: initialTile.x + initialTile.width + outsideEdge, y: initialTile.y + initialTile.height / 4 };
    if (touch) await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...away, id: 1 }] });
    else { await page.mouse.move(away.x, away.y); await page.mouse.down(); }
    await rawMove({ x: away.x + initialTile.width * 0.15, y: away.y });
    await end();
    assert.ok((await tile("channel-1").boundingBox()).width > initialTile.width + 5);
    const awaySize = await page.evaluate(() => JSON.parse(localStorage.getItem("signal-desk.multiview-sizes.v1"))["channel-1"]);
    assert.ok(awaySize.columns > 1.1 && awaySize.columns < 1.2);
    await tile("channel-1").getByRole("button", { name: "Reset Channel 1 size" }).click();
    await page.waitForFunction(() => [...document.querySelectorAll("article")].every(tile => tile.getAnimations().length === 0));
    await page.evaluate(() => { window.sixVideos = [...document.querySelectorAll("article video")]; });
    // Complete one real glide to warm native video compositing before the strict
    // 50/100ms probe. Cold compositor startup can skip rAF callbacks on Windows.
    await start("channel-1"); await move(await point(tile("channel-2")));
    await tiles.evaluateAll(tiles => Promise.all(tiles.flatMap(tile => tile.getAnimations().map(animation => animation.finished))));
    await page.keyboard.press("Escape"); await end(); await clean();
    await start("channel-1");
    await page.evaluate(() => {
      const neighbor = document.querySelector('article[data-move-target="channel-2"]');
      const frames = window.sortFrames = []; window.sortSampling = true;
      const sample = () => {
        if (!window.sortSampling || window.sortFrames !== frames) return;
        const r = neighbor.getBoundingClientRect();
        window.sortFrames.push({ t: performance.now(), x: r.x, y: r.y, order: neighbor.style.order });
        requestAnimationFrame(sample);
      }; sample();
    });
    await rawMove(over({ x: sixLayout[1].x + 8, y: sixLayout[1].y + sixLayout[1].height / 2 }));
    await end();
    await page.evaluate(async () => {
      const start = performance.now();
      while (performance.now() - start < 650) await new Promise(requestAnimationFrame);
    });
    const dropFrames = await page.evaluate(() => { window.sortSampling = false; return window.sortFrames; });
    const dropStart = dropFrames.find(frame => frame.order === "0").t;
    const dropCheckpoints = [50, 100].map(ms => dropFrames.find(frame => frame.t >= dropStart + ms));
    for (const [i, frame] of dropCheckpoints.entries()) {
      assert.ok(frame.t - dropStart < [100, 160][i], `${name}: sampling must not skip the early drop frames: ${JSON.stringify(dropFrames)}`);
      assert.ok(frame.x > sixLayout[0].x + 2 && frame.x < sixLayout[1].x - 2,
        `${name}: short drop neighbor at ${frame.t - dropStart}ms must be BETWEEN slots, got ${frame.x} (destination ${sixLayout[0].x})`);
    }
    assert.ok(dropCheckpoints[1].x < dropCheckpoints[0].x, "Neighbor continues toward its slot after release");
    assert.ok(Math.abs(dropFrames.at(-1).x - sixLayout[0].x) < 0.1);
    assert.equal(posts.length, sixPosts); assert.equal(deletes.length, sixDeletes);
    assert.equal(await page.evaluate(() => window.sixVideos.every(video => video.isConnected && (!video.videoWidth || video.readyState >= 2))), true);
    await clean();
    console.log(JSON.stringify({ name, shortDrop: dropCheckpoints.map(frame => ({ ms: frame.t - dropStart, x: frame.x })), destination: sixLayout[0].x }));
    const pollsBeforeDrag = runtimePolls;
    const continuous = [];
    await start("channel-2");
    for (const index of [5, 0, 5, 0]) {
      const beforeX = await tile("channel-1").evaluate(tile => tile.getBoundingClientRect().x);
      await page.evaluate(() => {
        const neighbor = document.querySelector('article[data-move-target="channel-1"]');
        const frames = window.sortFrames = []; window.sortSampling = true;
        const sample = () => {
          if (!window.sortSampling || window.sortFrames !== frames) return;
          window.sortFrames.push({ t: performance.now(), x: neighbor.getBoundingClientRect().x, order: neighbor.style.order });
          requestAnimationFrame(sample);
        }; sample();
      });
      const slot = sixLayout[index];
      const destinationX = sixLayout[index ? 0 : 1].x;
      for (let i = 0; i < 36; i++) {
        await rawMove(over({ x: slot.x + slot.width / 2 + Math.sin(i) * 2, y: slot.y + slot.height / 2 + Math.cos(i) * 2 }));
        await page.evaluate(() => new Promise(requestAnimationFrame));
      }
      const frames = await page.evaluate(() => { window.sortSampling = false; return window.sortFrames; });
      const first = frames.find(frame => frame.order === (index ? "0" : "1"));
      const checkpoints = [50, 100].map(ms => frames.find(frame => frame.t >= first.t + ms));
      for (const frame of checkpoints) {
        const progress = (frame.x - beforeX) / (destinationX - beforeX);
        assert.ok(progress > 0.01 && progress < 0.99, `${name}: continuous movement must show an intermediate visual rect, got ${progress}`);
      }
      const progress = frames.map(frame => (frame.x - beforeX) / (destinationX - beforeX));
      assert.ok(progress.every((p, i) => p >= -0.001 && p <= 1.001 && (!i || p >= progress[i - 1] - 0.001)), "Repeated moves and runtime rerenders cannot snap/reset the glide");
      assert.ok(Math.abs(frames.at(-1).x - destinationX) < 0.1);
      continuous.push({ slot: index, frames: frames.length, checkpoints: checkpoints.map(frame => ({ ms: frame.t - first.t, x: frame.x })) });
    }
    await page.keyboard.press("Escape"); await end(); await clean();
    assert.ok(runtimePolls > pollsBeforeDrag, "Continuous drag spans real serial runtime polls");
    assert.equal(posts.length, sixPosts); assert.equal(deletes.length, sixDeletes);
    assert.equal(await page.evaluate(() => window.sixVideos.every(video => video.isConnected && (!video.videoWidth || video.readyState >= 2))), true);
    // Reduced motion is deliberately immediate, including ordinary/native OS mode.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await start("channel-2"); await move(await point(tile("channel-1")));
    assert.equal(await tile("channel-1").evaluate(tile => tile.getBoundingClientRect().x), sixLayout[0].x);
    assert.equal(await tiles.evaluateAll(tiles => tiles.flatMap(tile => tile.getAnimations()).length), 0);
    await page.keyboard.press("Escape"); await end(); await clean();
    // Playwright defaults to no-preference even when Windows disables animations.
    // null clears the override on Playwright's OWN CDP session (not a second one).
    await page.emulateMedia({ reducedMotion: null });
    const nativeReducedMotion = await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
    await start("channel-2"); await move(await point(tile("channel-1")));
    assert.equal(await tiles.evaluateAll(tiles => tiles.some(tile => tile.getAnimations().length > 0)), !nativeReducedMotion);
    await page.keyboard.press("Escape"); await end(); await clean();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    console.log(JSON.stringify({ name, automationReducedMotion, nativeReducedMotion, continuous, runtimePollsDuringDrag: runtimePolls - pollsBeforeDrag, samePageExtraSessions: 0 }));
    // Real captured edge resizing must retain the original decoded video nodes.
    // Channel 2 is first after the completed reorder. Reserve 2×2 cells while
    // retaining an intermediate 1.45×1.35 visual size, with linear edge motion.
    const resizeTile = tile("channel-2");
    for (const edge of ["right", "bottom"]) {
      // Finish the previous reflow before selecting a different handle: a
      // neighbouring tile in transit can temporarily cross that hit location.
      await page.waitForFunction(() => [...document.querySelectorAll("article")].every(tile => tile.getAnimations().length === 0));
      const p = await point(resizeTile.locator(`.react-resizable-handle-${edge === "right" ? "e" : "s"}`));
      const grid = await page.locator(".multiview-grid").boundingBox();
      const gap = await page.locator(".multiview-grid").evaluate(grid => parseFloat(getComputedStyle(grid).gap));
      const step = edge === "right" ? (grid.width + gap) / 4 : (grid.height + gap) / 3;
      const beforeSize = await resizeTile.boundingBox();
      if (touch) await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...p, id: 1 }] });
      else { await page.mouse.move(p.x, p.y); await page.mouse.down(); }
      for (const fraction of [0.05, 0.15, edge === "right" ? 0.45 : 0.35]) {
        await rawMove({ x: p.x + (edge === "right" ? step * fraction : 0), y: p.y + (edge === "bottom" ? step * fraction : 0) });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const afterSize = await resizeTile.boundingBox();
        const growth = edge === "right" ? afterSize.width - beforeSize.width : afterSize.height - beforeSize.height;
        assert.ok(Math.abs(growth - step * fraction) < 1, `${name}: ${edge} edge should follow pointer at ${fraction} cells, got ${growth}px`);
      }
      await end();
      await page.waitForFunction(() => document.querySelector('article[data-move-target="channel-2"]').style.gridColumn.includes("span 2"));
    }
    assert.equal(await resizeTile.evaluate(tile => tile.style.gridRow), "1 / span 2");
    const savedSize = await page.evaluate(() => JSON.parse(localStorage.getItem("signal-desk.multiview-sizes.v1"))["channel-2"]);
    assert.ok(Math.abs(savedSize.columns - 1.45) < 0.01 && Math.abs(savedSize.rows - 1.35) < 0.01);
    await page.waitForFunction(() => [...document.querySelectorAll("article")].every(tile => tile.getAnimations().length === 0));
    const boxes = await tiles.evaluateAll(tiles => tiles.map(tile => tile.getBoundingClientRect().toJSON()));
    for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
      const overlap = Math.max(0, Math.min(boxes[a].right, boxes[b].right) - Math.max(boxes[a].left, boxes[b].left)) *
        Math.max(0, Math.min(boxes[a].bottom, boxes[b].bottom) - Math.max(boxes[a].top, boxes[b].top));
      assert.equal(overlap, 0, "Resized tiles must not overlap");
    }
    await shot("resized");
    assert.equal(posts.length, sixPosts); assert.equal(deletes.length, sixDeletes);
    await resizeTile.locator("video").dblclick();
    await page.waitForFunction(() => Boolean(document.querySelector("article.is-fullscreen")));
    await page.waitForFunction(() => {
      const r = document.querySelector("article.is-fullscreen").getBoundingClientRect();
      return r.width >= innerWidth - 1 && r.height >= innerHeight - 1;
    });
    await shot("fullscreen");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("article.is-fullscreen"));
    assert.equal(await page.evaluate(() => window.sixVideos.every(video => video.isConnected && (!video.videoWidth || video.readyState >= 2))), true);
    await resizeTile.getByRole("button", { name: "Reset Channel 2 size" }).click();
    assert.equal(await resizeTile.evaluate(tile => tile.style.gridColumn), "1 / span 1");
    assert.equal(await resizeTile.getByRole("button", { name: "Fullscreen Channel 2", exact: true }).count(), 0);
    assert.equal(await resizeTile.locator("header small").count(), 0);
    await resizeTile.locator("video").focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => Boolean(document.querySelector("article.is-fullscreen")));
    await resizeTile.getByRole("button", { name: "Exit fullscreen for Channel 2" }).click();
    await page.waitForFunction(() => !document.querySelector("article.is-fullscreen"));
    assert.equal(posts.length, sixPosts); assert.equal(deletes.length, sixDeletes);
    // The standard diagonal corner handle adjusts width and height together.
    const corner = resizeTile.getByRole("button", { name: "Resize Channel 2 bottom-right corner" });
    await page.waitForFunction(() => [...document.querySelectorAll("article")].every(tile => tile.getAnimations().length === 0));
    assert.match(await corner.evaluate(handle => getComputedStyle(handle).cursor), /se-resize|nwse-resize/);
    assert.equal(await corner.evaluate(handle => getComputedStyle(handle).width), "20px");
    assert.match(await corner.evaluate(handle => getComputedStyle(handle).backgroundImage), /data:image\/svg\+xml;base64/);
    assert.equal(await corner.evaluate(handle => getComputedStyle(handle, "::after").content), "none");
    const cornerPoint = await point(corner);
    const cornerGrid = await page.locator(".multiview-grid").boundingBox();
    const cornerGap = await page.locator(".multiview-grid").evaluate(grid => parseFloat(getComputedStyle(grid).gap));
    if (touch) await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...cornerPoint, id: 1 }] });
    else { await page.mouse.move(cornerPoint.x, cornerPoint.y); await page.mouse.down(); }
    await rawMove({ x: cornerPoint.x + (cornerGrid.width + cornerGap) / 4 * 0.1, y: cornerPoint.y + (cornerGrid.height + cornerGap) / 3 * 0.1 });
    await end();
    const cornerSize = await page.evaluate(() => JSON.parse(localStorage.getItem("signal-desk.multiview-sizes.v1"))["channel-2"]);
    assert.ok(Math.abs(cornerSize.columns - 1.1) < 0.015 && Math.abs(cornerSize.rows - 1.1) < 0.015, JSON.stringify(cornerSize));
    await resizeTile.getByRole("button", { name: "Reset Channel 2 size" }).click();
    assert.equal(posts.length, sixPosts); assert.equal(deletes.length, sixDeletes);
    console.log(JSON.stringify({ name, edgeResize: savedSize, cornerResize: cornerSize, fullscreen: true, reset: true, retainedVideoNodes: true }));
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await page.waitForFunction(() => window.senders.size === 0);
    if (process.env.SORT_SIX_ONLY === "1") {
      assert.deepEqual(errors, []);
      assert.equal(posts.length, sixPosts); assert.equal(deletes.length, sixPosts);
      results.push({ name, tiles: 6, playing: 5, shortDrop: true, continuousMoves: 144, runtimePolls: runtimePolls - pollsBeforeDrag,
        automationReducedMotion, nativeReducedMotion, samePageExtraSessions: 0, cleanupSessions: deletes.length });
      await context.close();
      continue;
    }
    fixture = channels;
    await page.evaluate(key => localStorage.removeItem(key), key);
    posts.length = 0; deletes.length = 0;
    await page.reload();
    await page.waitForFunction(() => [...document.querySelectorAll("article video")].filter((video) => video.videoWidth > 0 && video.readyState >= 2).length === 10).catch(async (error) => {
      console.error({ name, posts, deletes, errors, media: await tiles.evaluateAll((tiles) => tiles.map((tile) => ({ id: tile.dataset.moveTarget, text: tile.textContent, state: tile.querySelector("video").readyState, width: tile.querySelector("video").videoWidth }))) });
      throw error;
    });
    await page.evaluate(() => document.fonts.ready);
    const baseline = await ids(), originalSaved = await saved();
    const originalPosts = posts.length, originalDeletes = deletes.length;
    assert.equal(originalPosts, 11, "Only the 11 ready visible tiles open WHEP sessions");
    const layout = await tiles.evaluateAll((tiles) => tiles.map((tile) => { const r = tile.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; }));
    assert.equal(new Set(layout.map((r) => r.x)).size, 4);
    assert.equal(new Set(layout.map((r) => r.y)).size, 3);
    assert.ok(layout.every((r) => r.right <= width && r.bottom <= height));
    await page.evaluate(() => { window.originalVideos = [...document.querySelectorAll("article video")]; });
    const slots = await Promise.all(baseline.map((id) => point(tile(id))));
    // Measure full-rectangle collision with native mouse/touch and a top-right grip.
    // One pixel either side avoids integer offset rounding at fractional CSS slots;
    // the unit suite also covers the exact 50% boundary and two-axis overlap.
    await start(baseline[0]);
    const neighbor = layout[1], initial = layout[0];
    const below = { x: neighbor.x - 1, y: slots[1].y };
    assert.ok(over(below).x > neighbor.x && over(below).x < neighbor.right, "Handle is inside the neighbor before half overlap");
    await move(below);
    assert.deepEqual(await proposed(), baseline, "Pointer over a neighbor is insufficient");
    await move({ x: neighbor.x + 1, y: slots[1].y });
    const swapped = [baseline[1], baseline[0], ...baseline.slice(2)];
    assert.deepEqual(await proposed(), swapped, "More than half the ghost displaces the neighbor");
    const pointerOutside = { x: neighbor.right - initial.width * 0.2, y: slots[1].y };
    assert.ok(over(pointerOutside).x > neighbor.right, "Handle is outside the reserved target slot");
    for (const p of [pointerOutside, slots[1], { x: (initial.right + neighbor.x) / 2, y: slots[1].y }, slots[1]]) {
      await move(p);
      assert.deepEqual(await proposed(), swapped, "Own placeholder and below-threshold gap retain the preview");
    }
    await move(slots[0]);
    assert.deepEqual(await proposed(), baseline, "Reverse collision uses the displaced neighbor's current slot");
    await page.keyboard.press("Escape"); await end(); await clean();
    assert.equal(posts.length, originalPosts); assert.equal(deletes.length, originalDeletes);
    const overlapMeasures = { width: initial.width, height: initial.height,
      belowFraction: 0.5 - 1 / initial.width, aboveFraction: 0.5 + 1 / initial.width,
      pointerOutsideFraction: 0.7, placeholderOpacity: 0, ghostTransform: "none" };
    await shot("before");
    await start(baseline[0]);
    await move(slots[5]);
    const expected = [...baseline]; expected.splice(0, 1); expected.splice(5, 0, baseline[0]);
    assert.deepEqual(await proposed(), expected);
    assert.deepEqual(await domIDs(), baseline, "Capture never moves the DOM nodes");
    assert.deepEqual(await saved(), originalSaved, "Hover must not persist");
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const animation = await tile(baseline[1]).evaluate((tile) => ({ left: tile.getBoundingClientRect().left, animations: tile.getAnimations().length }));
    assert.ok(animation.animations > 0, "Other tiles are actively animating");
    assert.ok(animation.left > layout[0].x && animation.left < layout[1].x, `${name}: intermediate FLIP position ${animation.left} between ${layout[0].x} and ${layout[1].x}`);
    const overlay = await page.locator(".multiview-drag-overlay").evaluate((element) => {
      const r = element.getBoundingClientRect(), style = getComputedStyle(element);
      const canvas = element.querySelector("canvas");
      return { x: r.x, y: r.y, width: r.width, height: r.height, opacity: Number(style.opacity), pointerEvents: style.pointerEvents,
        inert: element.inert, hidden: element.getAttribute("aria-hidden"), videos: element.querySelectorAll("video,button,[tabindex]").length,
        frame: canvas && [...canvas.getContext("2d").getImageData(0, 0, 1, 1).data] };
    });
    assert.ok(overlay.opacity > 0 && overlay.opacity < 1);
    assert.equal(overlay.pointerEvents, "none"); assert.equal(overlay.inert, true); assert.equal(overlay.hidden, "true"); assert.equal(overlay.videos, 0);
    assert.ok(overlay.frame?.[3] > 0, "A decoded video frame was captured");
    assert.ok(Math.abs(overlay.x - layout[5].x) < 1);
    assert.ok(Math.abs(overlay.y - layout[5].y) < 1);
    const ghostTile = await page.locator(".multiview-drag-overlay > .multiview-tile").evaluate(element => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, transform: getComputedStyle(element).transform };
    });
    assert.equal(ghostTile.transform, "none");
    for (const dimension of ["width", "height"]) assert.ok(Math.abs(ghostTile[dimension] - layout[0][dimension]) < 0.1);
    assert.ok(Math.abs(ghostTile.x - overlay.x) < 0.1 && Math.abs(ghostTile.y - overlay.y) < 0.1);
    const placeholder = await tile(baseline[0]).evaluate(element => ({ opacity: getComputedStyle(element).opacity,
      pointerEvents: getComputedStyle(element).pointerEvents, width: element.offsetWidth, height: element.offsetHeight,
      capture: element.querySelector("button").hasPointerCapture(1), connected: element.querySelector("video").isConnected }));
    assert.equal(placeholder.opacity, "0"); assert.equal(placeholder.pointerEvents, "none");
    assert.ok(placeholder.width > 0 && placeholder.height > 0 && placeholder.connected);
    await shot("during");
    // Sample a native, uninterrupted long-distance glide, not just its endpoints.
    await move(slots[11]);
    const glide = await tile(baseline[8]).evaluate(async (tile) => {
      const animation = tile.getAnimations()[0];
      const timing = animation.effect.getTiming();
      const frames = [];
      do {
        await new Promise(requestAnimationFrame);
        const r = tile.getBoundingClientRect();
        frames.push({ time: animation.currentTime, x: r.x, y: r.y });
      } while (animation.playState !== "finished");
      return { duration: timing.duration, easing: timing.easing, frames };
    });
    assert.equal(glide.duration, 460);
    assert.equal(glide.easing, "cubic-bezier(0.22, 0.68, 0.2, 1)");
    const progress = glide.frames.map((frame) => (frame.x - layout[8].x) / (layout[7].x - layout[8].x));
    assert.ok(progress.every((p, i) => p >= 0 && p <= 1 && (!i || p >= progress[i - 1] - 0.001)), "Glide is monotonic with no overshoot");
    assert.ok(glide.frames.some((frame, i) => frame.time >= 220 && frame.time < 350 && progress[i] > 0.8 && progress[i] < 0.995), "Tiles are still gently settling after the old 220ms cutoff");
    assert.deepEqual(await proposed(), [...baseline.slice(1), baseline[0]], "Holding a distant slot does not oscillate");
    await shot("held");
    if (process.env.SORT_SCREENSHOTS) {
      // Reveal part of the invisible reserved slot without colliding with a neighbor.
      await move({ x: slots[11].x - layout[0].width * 0.3, y: slots[11].y - layout[0].height * 0.15 });
      await shot("placeholder");
      await move(slots[11]);
    }

    // Freeze real WAAPI animations mid-flight only for a deterministic continuity probe.
    await move(slots[0]);
    const interrupted = await tiles.evaluateAll((tiles) => tiles.map((tile) => {
      for (const animation of tile.getAnimations()) { animation.pause(); animation.currentTime = 140; }
      const r = tile.getBoundingClientRect();
      return { id: tile.dataset.moveTarget, x: r.x, y: r.y };
    }));
    await move(slots[11]);
    const restarted = await tiles.evaluateAll((tiles) => tiles.map((tile) => {
      const animation = tile.getAnimations()[0];
      const first = new DOMMatrix(animation?.effect.getKeyframes()[0].transform);
      const current = new DOMMatrix(getComputedStyle(tile).transform);
      const r = tile.getBoundingClientRect();
      return { id: tile.dataset.moveTarget, x: r.x - current.m41 + first.m41, y: r.y - current.m42 + first.m42 };
    }));
    for (const before of interrupted) {
      const after = restarted.find((tile) => tile.id === before.id);
      assert.ok(Math.hypot(after.x - before.x, after.y - before.y) < 0.1, `${name}: ${before.id} retarget starts at its interrupted visual position: ${JSON.stringify({ before, after })}`);
    }
    await shot("reverse");
    for (const index of [5, 5, 2, 11, 0, 8, 2, 5, 5]) {
      await move({ x: slots[index].x + 1, y: slots[index].y });
      const next = [...baseline]; next.splice(0, 1); next.splice(index, 0, baseline[0]);
      assert.deepEqual(await proposed(), next, "Logical slots do not oscillate through rapid/repeated hovers");
    }
    assert.equal(await page.evaluate(() => window.originalVideos.every((video) => video.isConnected && [...document.querySelectorAll("article video")].includes(video))), true);
    assert.equal(posts.length, originalPosts); assert.equal(deletes.length, originalDeletes);
    await end(); await clean(true);
    assert.deepEqual(await ids(), expected); assert.deepEqual((await saved()).slice(0, 12), expected);
    assert.equal(await handle(baseline[0]).evaluate((element) => element === document.activeElement), true);
    assert.equal(posts.length, originalPosts); assert.equal(deletes.length, originalDeletes);
    assert.equal(await page.evaluate(() => window.originalVideos.every((video) => video.isConnected && (!video.videoWidth || video.readyState >= 2))), true);
    assert.equal(await page.evaluate(() => scrollY), 0, "Touch dragging must not scroll the page");
    await shot("after");
    const committed = await saved();
    for (const action of ["outside", "gap", "disabled-page", "Escape", "lostcapture", ...(touch ? ["pointercancel"] : [])]) {
      await start(baseline[0]); await move(slots[2]);
      if (action === "outside") await move({ x: width - 1, y: height - 1 });
      if (action === "gap") await move({ x: (layout[0].right + layout[1].x) / 2, y: slots[0].y });
      if (action === "disabled-page") await move(await point(page.getByRole("button", { name: "Previous page", exact: true })), true);
      if (action === "Escape") await page.keyboard.press("Escape");
      if (action === "lostcapture") {
        await handle(baseline[0]).evaluate((element) => {
          for (let id = 1; id < 50; id++) if (element.hasPointerCapture(id)) element.releasePointerCapture(id);
        });
        await rawMove(over({ x: slots[2].x + 2, y: slots[2].y }));
      }
      await end(action === "pointercancel"); await clean();
      assert.deepEqual(await saved(), committed, `${action} rolls back`);
      assert.deepEqual(await ids(), expected);
      assert.equal(await handle(baseline[0]).evaluate((element) => element === document.activeElement), true);
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await start(baseline[0]); await move(slots[2]);
    assert.equal(await tiles.evaluateAll((tiles) => tiles.flatMap((tile) => tile.getAnimations()).length), 0);
    assert.equal(await page.locator(".multiview-drag-overlay > .multiview-tile").evaluate((element) => getComputedStyle(element).transform), "none");
    const firstX = await page.locator(".multiview-drag-overlay").evaluate((element) => element.getBoundingClientRect().x);
    await move({ x: slots[2].x + 5, y: slots[2].y });
    const secondX = await page.locator(".multiview-drag-overlay").evaluate((element) => element.getBoundingClientRect().x);
    assert.ok(Math.abs(secondX - firstX - 5) < 1, "Reduced-motion overlay still follows pointer");
    await page.keyboard.press("Escape"); await end(); await clean();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    for (const id of ["channel-11", "channel-12"]) {
      await start(id); await move(slots[2]);
      assert.equal(await page.locator(".multiview-drag-overlay canvas").count(), 0);
      assert.match(await page.locator(".multiview-drag-overlay").textContent(), id === "channel-11" ? /waiting for encoder/ : /Audio-only/);
      await page.keyboard.press("Escape"); await end(); await clean();
    }
    for (const direction of ["Next page", "Previous page"]) {
      const beforePosts = posts.length, beforeDeletes = deletes.length;
      const button = page.getByRole("button", { name: direction, exact: true });
      await start(baseline[0]); await move(await point(button), true);
      assert.equal(await button.evaluate((button) => button.classList.contains("is-drop-target")), true);
      assert.equal(posts.length, beforePosts); assert.equal(deletes.length, beforeDeletes);
      await shot(direction === "Next page" ? "page-target" : "previous-target");
      await end(); await clean();
      assert.equal((await ids())[0], baseline[0]);
      assert.equal(posts.filter((path) => path === channels[0].whepPath).length, 1, "Cross-page source session is retained");
    }
    // Click/tap and keyboard fallback remain usable after drag suppression.
    await page.evaluate(() => {
      window.fallbackEvents = [];
      for (const type of ["pointerdown", "pointerup", "pointermove", "pointercancel", "mousedown", "click", "lostpointercapture"]) document.addEventListener(type, event => {
        const entry = { type, x: event.clientX, y: event.clientY, detail: event.detail, target: event.target.outerHTML?.slice(0, 300), prevented: false };
        window.fallbackEvents.push(entry); queueMicrotask(() => { entry.prevented = event.defaultPrevented; });
      }, true);
    });
    const title = await handle(baseline[0]).boundingBox();
    // Click the title surface clear of the stock north resize grip.
    const position = { x: title.width / 4, y: title.height * 3 / 4 };
    if (touch) await handle(baseline[0]).tap({ position }); else await handle(baseline[0]).click({ position });
    await page.getByRole("dialog").waitFor({ timeout: 2000 }).catch(async error => {
      console.error({ name, phase: "fallback click", events: await page.evaluate(() => window.fallbackEvents), state: await handle(baseline[0]).evaluate(element => ({ active: element === document.activeElement, capture: [...Array(50).keys()].filter(id => element.hasPointerCapture(id)), dragging: document.querySelectorAll('.is-dragging').length })) });
      throw error;
    });
    await page.keyboard.press("Escape");
    assert.equal(await handle(baseline[0]).evaluate((element) => element === document.activeElement), true,
      JSON.stringify(await page.evaluate(() => ({ active: document.activeElement.outerHTML.slice(0, 400), dialog: Boolean(document.querySelector('[role="dialog"]')), events: window.fallbackEvents }))));
    await page.keyboard.press("Enter"); await page.getByRole("dialog").waitFor(); await page.keyboard.press("Escape");
    // Definitive polling deletions cancel the ghost, never commit a stale target.
    for (const removed of ["channel-3", baseline[0]]) {
      await start(baseline[0]); await move(await point(tile("channel-3" === removed ? removed : "channel-4")));
      fixture = fixture.filter((channel) => channel.id !== removed);
      await page.locator(".multiview-drag-overlay").waitFor({ state: "detached", timeout: 6000 });
      await end(); await clean();
      assert.equal((await saved()).includes(removed), false);
    }
    assert.ok((await page.evaluate(() => window.captures)).some((capture) => capture.trusted && capture.type === (touch ? "touch" : "mouse")));
    assert.equal(await page.locator("video[controls]").count(), 0);
    assert.deepEqual(errors, []);
    results.push({ name, viewport: `${width}x${height}`, nativePointer: touch ? "touch" : "mouse", initialWHEPSessions: originalPosts, samePageExtraSessions: 0,
      overlapMeasures, postCrossPageTap: true,
      frameSnapshot: true, intermediateAnimation: true, glide: { duration: glide.duration, easing: glide.easing, sampledFrames: glide.frames.length },
      interruptedContinuity: true, noOvershoot: true, cancellations: true, reducedMotion: true, crossPage: true, deletion: true });
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await page.waitForFunction(() => window.senders.size === 0);
    await context.close();
  }
  console.log(JSON.stringify({ browser: browser.version(), results }, null, 2));
} finally {
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) {
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide"))).catch(() => {});
    await page.waitForFunction(() => window.senders?.size === 0, null, { timeout: 5000 }).catch(error => console.error("Playback cleanup:", error.message));
  }
  await browser?.close();
  await server.close();
}
