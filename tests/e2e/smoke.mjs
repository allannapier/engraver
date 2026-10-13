// End-to-end check of the browser app against the simulator.
//
//   ENGRAVER_SIM_SPEED=20 ENGRAVER_CONFIG=/tmp/engraver-e2e.json uv run engraver --no-browser --port 8642
//   node tests/e2e/smoke.mjs            (needs `playwright` resolvable; set PLAYWRIGHT_PATH if it's elsewhere)
//
// Pass a directory as the first argument to also save screenshots there.

import assert from "node:assert/strict";

const { chromium } = await import(process.env.PLAYWRIGHT_PATH || "playwright");
const BASE = process.env.ENGRAVER_URL || "http://127.0.0.1:8642";
const shots = process.argv[2];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
const fail = (text) => {
  errors.push(text);
  console.log(`  browser error: ${text}`);
};
// A refused request (off the bed, not connected) is logged by the browser; those are expected here.
page.on("console", (m) => m.type() === "error" && !/status of (409|422)/.test(m.text()) && fail(m.text()));
page.on("pageerror", (e) => fail(`pageerror: ${e.stack || e.message}`));

const shot = async (name) => shots && page.screenshot({ path: `${shots}/${name}.png` });
const step = (name) => console.log(`- ${name}`);
const near = (a, b, tol = 0.15) => assert.ok(Math.abs(a - b) <= tol, `expected ${a} to be within ${tol} of ${b}`);
const store = (fn, arg) => page.evaluate(async ([source, a]) => (0, eval)(`(${source})`)(await import("/js/store.js"), a), [fn.toString(), arg]);
const preview = () => page.evaluate(async () => {
  const { buildJob } = await import("/js/job.js");
  const { post } = await import("/js/api.js");
  const built = await buildJob("Test");
  return { job: built.job, warnings: built.warnings, summary: await post("/api/job/preview", { job: built.job }) };
});
const gcode = () => page.evaluate(async () => {
  const { buildJob } = await import("/js/job.js");
  const { post } = await import("/js/api.js");
  return post("/api/job/gcode", { job: (await buildJob("Test")).job });
});
const setProp = async (id, value) => {
  await page.fill(`#prop-${id}`, String(value));
  await page.press(`#prop-${id}`, "Enter");
};
const paste = (text) => page.evaluate((t) => {
  const data = new DataTransfer();
  data.setData("text/plain", t);
  window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data }));
}, text);
// waitForFunction needs a synchronous predicate, so the store module is parked on window after each load.
const ready = async () => {
  await page.waitForSelector(".layer");
  await page.evaluate(async () => { window.__store = await import("/js/store.js"); });
};
const waitStatus = (fn, arg) => page.waitForFunction(([source, a]) => (0, eval)(`(${source})`)(window.__store.state.status, a), [fn.toString(), arg], { timeout: 20000 });

await page.goto(BASE);
await page.evaluate(() => localStorage.clear());
await page.reload();
await ready();
await shot("01-empty");

step("a rectangle goes where the property bar says, in machine coordinates");
await page.click('[data-tool="rect"]');
await page.click("#prop-lock"); // unlock proportions so width and height can be set separately
await setProp("w", 50);
await setProp("h", 30);
await setProp("x", 10);
await setProp("y", 20);
let p = await preview();
assert.equal(p.job.layers.length, 1);
assert.equal(p.job.layers[0].mode, "line");
assert.deepEqual(p.summary.bounds, [10, 20, 60, 50]);
assert.equal(p.summary.burn_mm, 320); // 160 mm outline, two passes on the Cut layer

step("rotating by 90 degrees swaps its footprint and keeps the corner pinned by X/Y");
await setProp("rot", 90);
await setProp("x", 10);
await setProp("y", 20);
p = await preview();
p.summary.bounds.forEach((v, i) => near(v, [10, 20, 40, 70][i]));
await setProp("rot", 0);

step("dragging moves it; undo puts it back");
const before = await store((s) => ({ ...s.state.doc.objects[0] }));
const box = await page.locator(".obj .hit").first().boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 - 40, { steps: 5 });
await page.mouse.up();
const after = await store((s) => ({ ...s.state.doc.objects[0] }));
assert.ok(after.x > before.x + 5 && after.y < before.y - 5, "object should have moved right and up");
await page.keyboard.press("Control+z");
const undone = await store((s) => ({ ...s.state.doc.objects[0] }));
near(undone.x, before.x, 0.001);
near(undone.y, before.y, 0.001);

step("resizing from a corner handle keeps proportions when locked");
await page.click("#prop-lock");
// The canvas redraws on the next frame; measure the handle after that, not mid-redraw.
await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const handle = await page.locator('[data-handle="4"]').boundingBox();
await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
await page.mouse.down();
await page.mouse.move(handle.x + 80, handle.y + 20, { steps: 5 });
await page.mouse.up();
const resized = await store((s) => ({ ...s.state.doc.objects[0] }));
assert.ok(resized.w > 55, "should be wider");
near(resized.w / resized.h, 50 / 30, 0.01);
near(resized.x, undone.x, 0.01); // opposite corner stayed put
near(resized.y, undone.y, 0.01);
await page.keyboard.press("Control+z");

step("pasted SVG is sanitised, cropped to its artwork and traced accurately");
await paste(`<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100" onload="window.__pwned=1">
  <script>window.__pwned = 1</script>
  <style>.c { fill: none; stroke: #000 }</style>
  <foreignObject><div>x</div></foreignObject>
  <defs><circle id="dot" r="5"/></defs>
  <circle class="c" cx="50" cy="50" r="20" onclick="window.__pwned=1"/>
  <path d="M30 50a20 20 0 0140 0" fill="none" stroke="#000"/>
  <use href="#dot" x="50" y="50"/>
  <image href="https://example.com/track.png" width="10" height="10"/>
</svg>`);
await page.waitForFunction(() => document.querySelectorAll(".obj").length === 2);
assert.equal(await page.evaluate(() => window.__pwned), undefined);
assert.equal(await page.evaluate(() => document.querySelectorAll("#stage script, #stage foreignObject, #stage style, #stage [onclick], #stage image").length), 0);
const circle = await store((s) => ({ ...s.state.doc.objects[1] }));
near(circle.w, 40, 0.01); // 100 mm page, r=20 circle: cropped to 40 mm
near(circle.h, 40, 0.01);
assert.equal(await page.evaluate(() => getComputedStyle(document.querySelectorAll(".obj")[1].querySelector('circle[cx="50"]')).fill), "none", "class rule was inlined");
// Move it to the Cut layer and measure the traced geometry.
await page.selectOption("#prop-layer", { label: "Cut" });
await setProp("x", 100);
await setProp("y", 100);
p = await preview();
const traced = p.job.layers[0].polylines.slice(1); // [0] is the rectangle
assert.equal(traced.length, 3, "circle, arc and the <use> copy");
const length = (line) => line.slice(1).reduce((sum, pt, i) => sum + Math.hypot(pt[0] - line[i][0], pt[1] - line[i][1]), 0);
near(length(traced[0]), 2 * Math.PI * 20, 0.05);
near(length(traced[1]), Math.PI * 20, 0.05);
near(length(traced[2]), 2 * Math.PI * 5, 0.05);
const xs = traced[0].map((pt) => pt[0]), ys = traced[0].map((pt) => pt[1]);
near(Math.min(...xs), 100, 0.02);
near(Math.max(...xs), 140, 0.02);
near(400 - Math.max(...ys), 100, 0.02); // front edge is 100 mm from the bed's front
await shot("02-vector");

step("text engraves as a fill layer and lands where it is drawn");
await page.click('[data-tool="text"]');
await page.fill("dialog textarea", "Scooby\nDoos");
await page.click('dialog button[value="ok"]');
await page.waitForFunction(() => document.querySelectorAll(".obj").length === 3);
await setProp("x", 200);
await setProp("y", 250);
const text = await store((s) => ({ ...s.state.doc.objects[2] }));
p = await preview();
const fill = p.job.layers.find((l) => l.mode === "fill");
assert.ok(fill && fill.raster.png.startsWith("data:image/png"), "fill layer carries a bitmap");
const code = await gcode();
const fillPart = code.split("M4 S0")[1];
const burnXs = [...fillPart.matchAll(/G1 X([\d.]+)[^\n]*S(\d+)/g)].filter((m) => Number(m[2]) > 0).map((m) => Number(m[1]));
const burnYs = [...fillPart.matchAll(/G0 X[\d.]+ Y([\d.]+)/g)].map((m) => Number(m[1]));
assert.ok(burnXs.length > 50, "text produces many scan segments");
// The measured box includes the font's line spacing, so ink sits inside it.
assert.ok(Math.min(...burnXs) >= 200 - 0.5 && Math.max(...burnXs) <= 200 + text.w + 0.5, "ink stays inside the text box horizontally");
assert.ok(Math.min(...burnYs) >= 250 - 0.5 && Math.max(...burnYs) <= 250 + text.h + 0.5, "ink stays inside the text box vertically");
assert.ok(Math.max(...burnXs) - Math.min(...burnXs) > text.w * 0.8, "ink spans most of the box width");

step("selected text can be edited from the property bar");
await page.click("#prop-edit-text");
await page.fill("dialog textarea", "Scooby");
await page.click('dialog button[value="ok"]');
await page.waitForFunction(() => !document.querySelector("dialog[open]"));
assert.equal(await store((s) => s.state.doc.objects[2].text.value), "Scooby", "text updated in place");
assert.equal(await store((s) => s.state.doc.objects.length), 3, "editing does not add an object");
await page.click('[data-tool="undo"]');

step("assistant-style SVG text, even inside an inherited-attribute group, can be edited");
await paste(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40" fill="#000" font-family="Impact" font-weight="bold"><text x="0" y="30" font-size="30">Hi</text></svg>`);
await page.waitForFunction(() => document.querySelectorAll(".obj").length === 4);
await page.waitForSelector("#prop-edit-text:not([hidden])");
const pastedId = await store((s) => s.state.doc.objects[3].id);
await page.click("#prop-edit-text");
await page.fill("dialog textarea", "Hello");
await page.click('dialog button[value="ok"]');
await page.waitForFunction(() => !document.querySelector("dialog[open]"));
const edited = await store((s) => ({ ...s.state.doc.objects[3], n: s.state.doc.objects.length }));
assert.equal(edited.id, pastedId, "same object updated");
assert.equal(edited.kind, "text");
assert.equal(edited.text.value, "Hello");
assert.equal(edited.n, 4);
await page.click('[data-tool="undo"]');
await page.click('[data-tool="undo"]');
await page.waitForFunction(() => document.querySelectorAll(".obj").length === 3);
await store((s) => s.select([s.state.doc.objects[2].id]));

step("the typeface list previews each font and the chosen one");
await page.click('[data-tool="text"]');
const fontStyles = await page.$$eval("dialog select option", (opts) => opts.map((o) => o.style.fontFamily));
assert.ok(fontStyles.length > 6 && fontStyles.every(Boolean), "every typeface option renders in its own font");
await page.selectOption("dialog select", { label: "Garamond" });
assert.match(await page.$eval("dialog select", (el) => el.style.fontFamily), /Garamond/, "closed select shows the chosen font");
await page.click('dialog button[value=""]');
await page.waitForFunction(() => !document.querySelector("dialog[open]"));

step("text on a line layer is skipped with an explanation");
await page.selectOption("#prop-layer", { label: "Cut" });
p = await preview();
assert.ok(p.warnings.some((w) => w.includes("text can't be traced")), "warns about text");
await page.selectOption("#prop-layer", { label: "Engrave" });

step("a design off the bed is refused in bed-position mode");
await setProp("x", 400);
await assert.rejects(preview(), /off the bed/);
await setProp("x", 200);

step("layer settings reach the G-code");
const speed = page.locator('[data-field="speed"]').nth(1);
await speed.fill("450");
await speed.press("Enter");
const power = page.locator('[data-field="power"]').nth(1);
await power.fill("75");
await power.press("Enter");
const passes = page.locator('[data-field="passes"]').nth(1);
await passes.fill("3");
await passes.press("Enter");
const cutCode = (await gcode()).split("M4 S0")[2];
assert.ok(cutCode.includes("S750") && cutCode.includes("F450"), "cut layer uses 75% and 450 mm/min");
await passes.fill("1");
await passes.press("Enter");
const onePass = (await gcode()).split("M4 S0")[2];
assert.equal(cutCode.match(/G1 /g).length, 3 * onePass.match(/G1 /g).length, "three passes cut everything three times");

step("material presets fill in a layer");
await page.selectOption("#material", "plywood-3");
await page.locator(".layer").nth(1).locator('select[aria-label="Presets"]').selectOption("use:cut");
const cut = await store((s) => ({ ...s.state.doc.layers[1] }));
assert.deepEqual([cut.speed, cut.power, cut.passes, cut.mode], [300, 100, 2, "line"]);

step("connect to the simulator, jog and set the origin");
await page.click('[data-tab="laser"]');
await page.selectOption("#port", "sim");
await page.click("#connect");
await waitStatus((s) => s.connected && s.state === "Idle" && s.settings["30"]);
assert.equal(await page.textContent("#state-text"), "Ready");
await page.click('button[aria-label="Move right"]');
await page.click('button[aria-label="Move back"]');
await waitStatus((s) => s.wpos[0] === 10 && s.wpos[1] === 10 && s.state === "Idle");
assert.equal(await page.textContent("#dro-x"), "10.00");
await page.getByRole("button", { name: "Set origin here" }).click();
await waitStatus((s) => s.wpos[0] === 0 && s.wco[0] === 10);
await page.getByRole("button", { name: "Clear" }).click();
await waitStatus((s) => s.wco[0] === 0 && s.wpos[0] === 10);
await page.getByRole("button", { name: "Go to origin" }).click();
await waitStatus((s) => s.wpos[0] === 0 && s.wpos[1] === 0 && s.state === "Idle");
await shot("03-laser-tab");

step("frame traces the job outline");
await page.click("#job-frame");
await waitStatus((s) => s.job && s.job.kind === "frame" && s.state === "Run");
// The laser is off while framing, so the status mustn't say it's running.
await page.waitForFunction(() => document.getElementById("state-text").textContent === "Framing");
await waitStatus((s) => s.job && s.job.kind === "frame" && s.job.state === "done");
// Ports the operating system lists with nothing behind them are tucked away.
const portOptions = await page.locator("#port option").allTextContents();
assert.ok(!portOptions.some((text) => /ttyS\d/.test(text)), `port list should be short: ${portOptions.join(", ")}`);

step("start asks first, then runs to the end");
await page.click("#job-start");
await page.waitForSelector("dialog[open]");
assert.match(await page.textContent("dialog"), /Start burning\?/);
await shot("04-confirm");
await page.click('dialog button[value=""]');
assert.equal(await store((s) => s.state.status.job.kind), "frame", "cancelling starts nothing");
await page.click("#job-start");
await page.click('dialog button[value="go"]');
await waitStatus((s) => s.job.kind === "job" && s.job.state === "running");
await page.waitForFunction(() => document.querySelector(".jobbar").dataset.live === "true");
await shot("05-running");

step("pause, resume and stop");
await page.click("#job-pause");
await waitStatus((s) => s.state === "Hold" && s.job.state === "paused");
assert.equal(await page.textContent("#job-pause"), "Resume");
assert.equal(await page.textContent("#state-text"), "Paused");
await page.click("#job-pause");
await waitStatus((s) => s.state === "Run");
await page.click("#job-stop");
await waitStatus((s) => s.job.state === "stopped" && s.state === "Idle");
assert.equal(await page.isDisabled("#job-start"), false, "ready to go again after a stop");

step("a short job runs to completion");
await store((s) => {
  s.state.doc.objects = s.state.doc.objects.slice(0, 1);
  s.commit();
});
await page.click("#job-start");
await page.click('dialog button[value="go"]');
await waitStatus((s) => s.job.kind === "job" && s.job.state === "done");
assert.equal(await page.getAttribute("#job-bar", "aria-valuenow"), "100");
assert.match(await page.textContent("#job-title"), /finished/);

step("saving a layer's settings makes your own copy of the material");
await page.click('[data-tab="design"]');
await page.locator(".layer").nth(1).locator('select[aria-label="Presets"]').selectOption("save:cut");
await page.waitForFunction(() => window.__store.state.library[0]?.cut?.source === "saved");
let lib = await store((s) => ({ mats: s.state.library, picked: s.state.ui.materialId }));
const plyId = lib.mats[0].id;
assert.equal(lib.mats[0].name, "Plywood (basswood/birch), 3 mm");
assert.equal(lib.picked, plyId, "the copy becomes the material in use");
assert.deepEqual([lib.mats[0].cut.speed, lib.mats[0].cut.passes, lib.mats[0].cut.source], [300, 2, "saved"]);
assert.equal(lib.mats[0].engrave.source, "starting", "the rest is carried over as untested");
assert.equal(await page.locator('#material optgroup[label="Your materials"] option').count(), 1);

step("a material can be added, edited and deleted by hand");
await page.getByRole("button", { name: "New material" }).click();
await page.fill('dialog input[type="text"]', "Slate coaster");
await page.fill('dialog input[aria-label="Engrave mm/min"]', "3000");
await page.fill('dialog input[aria-label="Engrave %"]', "80");
await page.click('dialog button[value="ok"]');
await page.waitForFunction(() => window.__store.state.library.length === 2 && window.__store.state.library.some((m) => m.engrave?.speed === 3000));
let slate = await store((s) => s.state.materials.find((m) => m.id === s.state.ui.materialId));
assert.equal(slate.name, "Slate coaster");
assert.deepEqual([slate.engrave.mode, slate.engrave.power, slate.engrave.passes, slate.engrave.interval, slate.engrave.source], ["fill", 80, 1, 0.1, "saved"]);
assert.equal(slate.cut, null);
await page.getByRole("button", { name: "Edit", exact: true }).click();
await page.fill('dialog input[aria-label="Engrave %"]', "85");
await page.fill("dialog textarea", "Dark grey, from the garden centre");
await page.click('dialog button[value="ok"]');
await page.waitForFunction(() => window.__store.state.library.some((m) => m.engrave?.power === 85 && m.notes.includes("garden centre")));
await page.getByRole("button", { name: "New material" }).click();
await page.fill('dialog input[type="text"]', "slate COASTER");
await page.click('dialog button[value="ok"]');
await page.waitForSelector(".toast.error");
assert.match(await page.locator(".toast.error").last().textContent(), /already have a material called "Slate coaster"/);
assert.equal(await store((s) => s.state.library.length), 2);
await page.getByRole("button", { name: "Delete", exact: true }).click();
await page.click('dialog button[value="delete"]');
await page.waitForFunction(() => window.__store.state.library.length === 1 && window.__store.state.ui.materialId === "");

step("the test card is laid out as asked");
await page.selectOption("#material", plyId);
await page.getByRole("button", { name: "Test grid" }).click();
await page.waitForSelector(".test-preview");
assert.equal(await page.locator(".test-cell").count(), 25, "5 speeds by 5 powers by default");
const typeIn = async (label, value, nth = 0) => {
  const input = page.getByLabel(label, { exact: true }).nth(nth);
  await input.fill(String(value));
  await input.press("Tab");
};
await typeIn("Speed from", 2000);
await typeIn("to (mm/min)", 6000);
await typeIn("Steps", 3, 0);
await typeIn("Power from", 30);
await typeIn("to (%)", 60);
await typeIn("Steps", 2, 1);
await typeIn("Line gap (mm)", 0.2);
await typeIn("Square (mm)", 6);
assert.equal(await page.locator(".test-cell").count(), 6);
const card = await page.evaluate(async () => {
  const grid = await import("/js/testgrid.js");
  const { post } = await import("/js/api.js");
  const job = await grid.buildTestJob(grid.gridSpec(grid.test, 6000, "Plywood"));
  return {
    origin: job.origin_mode,
    layers: job.layers.map((l) => [l.name, l.mode, l.speed, l.power, l.interval]),
    summary: await post("/api/job/preview", { job }),
    gcode: await post("/api/job/gcode", { job }),
  };
});
assert.equal(card.origin, "origin");
assert.deepEqual(card.layers[0].slice(0, 2), ["Labels", "fill"]);
assert.deepEqual(card.layers.slice(1).map((l) => [l[2], l[3]]), [[2000, 30], [4000, 30], [6000, 30], [2000, 60], [4000, 60], [6000, 60]]);
assert.ok(card.layers.slice(1).every((l) => l[1] === "fill" && l[4] === 0.2));
near(card.summary.bounds[0], 0, 0.11);
near(card.summary.bounds[1], 0, 0.11);
// 10 mm of row labels plus three 6 mm squares, and 13.5 mm of headings plus two rows (less the space above the title's capitals).
assert.ok(card.summary.width >= 31.9 && card.summary.height > 26 && card.summary.height < 27.6, `card is ${card.summary.width} × ${card.summary.height}`);
// Each square is burned at its own speed and power: 6 mm at 0.2 mm gap is 30 scan lines.
const blocks = card.gcode.split("M4 S0").slice(2);
assert.equal(blocks.length, 6);
blocks.forEach((block, i) => {
  const [speed, power] = [[2000, 30], [4000, 30], [6000, 30], [2000, 60], [4000, 60], [6000, 60]][i];
  const burns = [...block.matchAll(/G1 X[\d.]+ S(\d+)/g)].filter((m) => Number(m[1]) > 0);
  assert.equal(burns.length, 30, `square ${i} has 30 scan lines`);
  assert.ok(burns.every((m) => Number(m[1]) === power * 10), `square ${i} burns at ${power}%`);
  assert.ok(block.includes(`F${speed}`), `square ${i} runs at ${speed} mm/min`);
});

step("a score card burns from the origin, and the picked square is saved to the material");
await page.getByRole("button", { name: "Score", exact: true }).click();
assert.equal(await page.locator(".test-cell").count(), 25);
assert.equal(await page.getByRole("button", { name: "Save as the score setting" }).isDisabled(), true, "nothing picked yet");
await page.getByRole("button", { name: "Frame test" }).click();
await waitStatus((s) => s.job.kind === "frame" && s.job.state === "running");
await waitStatus((s) => s.job.kind === "frame" && s.job.state === "done");
await page.getByRole("button", { name: "Burn test" }).click();
await page.waitForSelector("dialog[open]");
const confirmText = await page.textContent("dialog");
assert.match(confirmText, /25 squares: 1000 to 5000 mm\/min, 10 to 50%/);
assert.match(confirmText, /the card's front-left corner/);
await page.click('dialog button[value="go"]');
await waitStatus((s) => s.job.name === "Material test" && s.job.state === "running");
assert.equal(await page.getByRole("button", { name: "Burn test" }).isDisabled(), true, "can't start a second run on top");
await waitStatus((s) => s.job.name === "Material test" && s.job.state === "done");
await page.locator('.test-cell[data-r="2"][data-c="1"]').click();
assert.match(await page.textContent("#tab-design"), /Picked: 2000 mm\/min, 30%, 1 pass\./);
await shot("08-test-grid");
await page.getByRole("button", { name: "Save as the score setting" }).click();
await page.waitForFunction(() => window.__store.state.library[0].score?.source === "test");
const tested = await store((s) => s.state.library[0]);
assert.deepEqual([tested.score.mode, tested.score.speed, tested.score.power, tested.score.passes], ["line", 2000, 30, 1]);
assert.match(tested.score.date, /^\d{4}-\d{2}-\d{2}$/);
assert.equal(tested.cut.speed, 300, "other settings are untouched");
await page.getByRole("button", { name: "Back to layers" }).click();
assert.match(await page.textContent(".settings-list"), /2000 mm\/min, 30%, 1 pass\s*picked from a test/);
await page.locator(".layer").nth(1).locator('select[aria-label="Presets"]').selectOption("use:score");
const scored = await store((s) => ({ ...s.state.doc.layers[1] }));
assert.deepEqual([scored.speed, scored.power, scored.passes, scored.mode], [2000, 30, 1, "line"]);
await shot("09-material");

step("the assistant's reply changes the canvas and the layers");
await page.route("**/api/state", async (route) => {
  const response = await route.fetch();
  const body = await response.json();
  body.config.llm.model = "test/model";
  await route.fulfill({ response, json: body });
});
let asked;
await page.route("**/api/ai/chat", async (route) => {
  asked = route.request().postDataJSON();
  await route.fulfill({
    json: {
      text: "Here's a **star** for the coaster, with `plywood` settings.",
      actions: [
        { type: "add_design", name: "Star", mode: "fill", width_mm: 60, x_mm: 300, y_mm: 40,
          svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><polygon points="50,5 61,38 96,38 68,59 79,93 50,72 21,93 32,59 4,38 39,38" fill="#000"/></svg>' },
        { type: "set_layer", layer_id: asked.context.layers[0].id, speed: 5000, power: 55 },
        { type: "set_layer", layer_id: "nope", speed: 1 },
      ],
    },
  });
});
await page.reload();
await ready();
await page.click('[data-tab="assistant"]');
await page.fill("#tab-assistant textarea", "Make a star for a plywood coaster");
await page.press("#tab-assistant textarea", "Enter");
await page.waitForSelector(".msg.assistant:not(.thinking)");
assert.equal(asked.messages.at(-1).content, "Make a star for a plywood coaster");
assert.equal(asked.context.material.name, "Plywood (basswood/birch), 3 mm");
assert.equal(asked.context.material.from, "the person's own materials");
assert.equal(asked.context.material.score.source, "test");
assert.ok(asked.image.startsWith("data:image/png"), "a picture of the canvas is sent");
const star = await store((s) => {
  const o = s.state.doc.objects.at(-1);
  return { ...o, layer: s.layerById(o.layerId) };
});
assert.equal(star.name, "Star");
// Bold and code come out as formatting, not as stray asterisks and backticks.
const reply = page.locator(".msg.assistant").last();
assert.equal(await reply.locator("strong").textContent(), "star");
assert.equal(await reply.locator("code").textContent(), "plywood");
assert.ok(!(await reply.textContent()).includes("**"));
// The message box stays inside the panel even with a much wider font.
const fits = await page.evaluate(() => {
  const panel = document.getElementById("tab-assistant");
  panel.style.fontFamily = "monospace";
  panel.style.fontSize = "19px";
  const edge = panel.getBoundingClientRect().right - parseFloat(getComputedStyle(panel).paddingRight);
  const widest = Math.max(...[...panel.querySelectorAll("textarea, .composer button, .msg")].map((node) => node.getBoundingClientRect().right));
  panel.style.fontFamily = panel.style.fontSize = "";
  return widest <= edge + 0.5;
});
assert.ok(fits, "assistant messages and message box fit inside the panel");
near(star.w, 60, 0.01);
near(star.x, 300, 0.01);
near(400 - (star.y + star.h), 40, 0.01);
assert.deepEqual([star.layer.mode, star.layer.speed, star.layer.power], ["fill", 5000, 55]);
const notes = await page.locator(".msg.assistant .did").allTextContents();
assert.ok(notes.some((n) => n.startsWith('Added "Star"')) && notes.some((n) => n.startsWith("Skipped one change")), notes.join(" | "));
await shot("06-assistant");
await page.keyboard.press("Escape");
await page.locator("#stage").focus();
await page.keyboard.press("Control+z");
assert.equal(await store((s) => s.state.doc.objects.length), 1, "one undo reverses the whole reply");

step("a reference picture goes to the assistant, scaled down, until it is removed");
const bigPng = Buffer.from(await page.evaluate(() => {
  const c = document.createElement("canvas");
  c.width = 2400;
  c.height = 1200;
  const g = c.getContext("2d");
  g.fillStyle = "#c33";
  g.fillRect(200, 200, 800, 800);
  return c.toDataURL("image/png").split(",")[1];
}), "base64");
await page.click('[data-tab="assistant"]');
await page.locator('#tab-assistant input[type="file"]').setInputFiles({ name: "sketch.png", mimeType: "image/png", buffer: bigPng });
await page.waitForSelector(".ref-attach:not([hidden]) img");
assert.equal(await page.locator(".ref-attach strong").textContent(), "sketch.png");
await page.fill("#tab-assistant textarea", "Trace this sketch");
await page.press("#tab-assistant textarea", "Enter");
await page.waitForFunction(() => document.querySelectorAll(".msg.assistant:not(.thinking)").length >= 2);
assert.ok(asked.reference.startsWith("data:image/jpeg;base64,"), "the reference is sent as a JPEG");
const refSize = await page.evaluate((url) => new Promise((resolve) => {
  const img = new Image();
  img.onload = () => resolve([img.naturalWidth, img.naturalHeight]);
  img.src = url;
}), asked.reference);
assert.deepEqual(refSize, [1024, 512], "the reference is scaled to 1024 px on the long side");
assert.equal(await page.locator(".msg.user .msg-ref").count(), 1, "the sent message shows the picture");
await page.click('.ref-attach button:has-text("Remove")');
assert.ok(await page.locator(".ref-attach").isHidden());
await page.fill("#tab-assistant textarea", "Thanks");
await page.press("#tab-assistant textarea", "Enter");
await page.waitForFunction(() => document.querySelectorAll(".msg.assistant:not(.thinking)").length >= 3);
assert.equal(asked.reference, null, "a removed picture is no longer sent");
await page.keyboard.press("Escape");
await page.locator("#stage").focus();
await page.keyboard.press("Control+z");
await page.keyboard.press("Control+z");
assert.equal(await store((s) => s.state.doc.objects.length), 1);

step("a chat is kept across a reload, cleared with New chat and reopened");
// The chat is saved just after the reply shows; wait for it before reloading.
await page.waitForFunction(async () => (await (await fetch("/api/chats")).json()).chats[0]?.count === 6);
await page.reload();
await ready();
await page.click('[data-tab="assistant"]');
await page.waitForFunction(() => document.querySelectorAll(".msg.user").length === 3);
assert.equal(await page.locator(".msg.user").first().textContent(), "Make a star for a plywood coaster");
await page.click('#tab-assistant button:has-text("New chat")');
assert.equal(await page.locator(".msg").count(), 0);
await page.click('#tab-assistant button:has-text("Back to last chat")');
await page.waitForFunction(() => document.querySelectorAll(".msg.user").length === 3);
await page.click('#tab-assistant button:has-text("New chat")');
await page.fill("#tab-assistant textarea", "A second chat");
await page.press("#tab-assistant textarea", "Enter");
await page.waitForSelector(".msg.assistant:not(.thinking)");
await page.click('#tab-assistant button:has-text("Chats")');
await page.waitForFunction(() => document.querySelectorAll("dialog .chat-row").length === 2);
const chatNames = await page.locator("dialog .chat-row strong").allTextContents();
assert.equal(chatNames.length, 2, chatNames.join(" | "));
assert.ok(chatNames[0].startsWith("A second chat") && chatNames[1].startsWith("Make a star"), chatNames.join(" | "));
await page.locator("dialog .chat-row").nth(1).getByRole("button", { name: "Open" }).click();
await page.waitForFunction(() => document.querySelectorAll(".msg.user").length === 3);
await page.locator("#stage").focus();
await page.keyboard.press("Control+z");
assert.equal(await store((s) => s.state.doc.objects.length), 1);

step("settings are saved from Setup");
await page.unroute("**/api/state");
await page.click('[data-tab="setup"]');
await page.fill('[data-machine="bed_w"]', "400");
await page.getByRole("button", { name: "Save machine" }).click();
await page.waitForFunction(() => window.__store.state.machine.bed_w === 400);
await page.fill('[data-machine="bed_w"]', "410");
await page.getByRole("button", { name: "Save machine" }).click();
await page.waitForFunction(() => window.__store.state.machine.bed_w === 410);
await shot("07-setup");

step("a hostile project file is cleaned on open");
await page.setInputFiles("#file-project", {
  name: "bad.engraver.json",
  mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify({
    format: "engraver-project",
    doc: {
      layers: [{ id: "L1", name: "Cut", mode: "line", color: "red;background:url(https://example.com/x)", speed: "fast", power: 900, passes: 0 }],
      objects: [
        { id: "a", layerId: "L1", vb: [0, 0, 10, 10], w: 20, h: 20, x: 5, y: 5,
          svg: '<rect width="10" height="10" onclick="window.__pwned=2"/><script>window.__pwned=2</script><image href="https://example.com/t.png" width="1" height="1"/>' },
        { id: "b", layerId: "nope", vb: [0, 0, 0, 10], svg: "<rect/>" },
        { nonsense: true },
      ],
    },
  })),
});
await page.waitForFunction(() => window.__store.state.doc.layers[0].id === "L1");
const opened = await store((s) => s.state.doc);
assert.equal(opened.objects.length, 1, "malformed objects are dropped");
assert.equal(opened.objects[0].svg, '<rect width="10" height="10"/>');
assert.deepEqual([opened.layers[0].speed, opened.layers[0].power, opened.layers[0].passes], [1000, 100, 1]);
assert.match(opened.layers[0].color, /^#[0-9a-f]{6}$/);
assert.equal(await page.evaluate(() => window.__pwned), undefined);
await page.locator("#stage").focus();
await page.keyboard.press("Control+z");
assert.equal(await store((s) => s.state.doc.objects[0].kind), "shape", "opening a project is undoable");

step("a bug report gathers diagnostics, is reviewed, then filed");
// Filing is always faked here: this test must never create a real issue.
await page.route("**/api/bug/status", (route) => route.fulfill({ json: { repo: "allannapier/engraver", method: "gh", public: true } }));
let filed;
await page.route("**/api/bug/report", async (route) => {
  filed = route.request().postDataJSON();
  await route.fulfill({ json: { url: "https://github.com/allannapier/engraver/issues/7", number: 7, via: "gh" } });
});
await page.evaluate(async () => {
  window.dispatchEvent(new ErrorEvent("error", { message: "TypeError: test boom", filename: `${location.origin}/js/stage.js`, lineno: 42, colno: 7 }));
  const { post } = await import("/js/api.js");
  await post("/api/job/preview", { job: { layers: [] } }).catch(() => {});
});
await page.click("#report-bug");
await page.waitForSelector("dialog[open]");
assert.match(await page.textContent("dialog"), /public, so anyone can read the report/);
await page.click('dialog button[value="review"]');
assert.equal(await page.textContent("dialog h1"), "Report a bug", "an empty report can't be sent on");
await page.fill('dialog input[type="text"]', "Frame goes off the bed");
await page.locator("dialog textarea").first().fill("Pressed Frame and the head hit the rail.");
await page.click('dialog button[value="review"]');
await page.waitForSelector("dialog .report-body");
const reportText = await page.inputValue("dialog .report-body");
for (const expected of [
  "## What happened\n\nPressed Frame and the head hit the rail.",
  "- Laser: connected on the simulator (Grbl 1.1h), state Idle",
  "TypeError: test boom at /js/stage.js:42:7",
  "POST /api/job/preview -> 422: Nothing to burn",
  "click: Report a bug",
  "Laser console",
  '"kind": "job"',
  "Layers and designs on the canvas",
]) assert.ok(reportText.includes(expected), `report should include: ${expected}`);
assert.ok(!reportText.includes("Assistant conversation"), "the conversation is left out unless ticked");
await shot("10-bug-review");
await page.click('dialog button[value="back"]');
assert.equal(await page.inputValue('dialog input[type="text"]'), "Frame goes off the bed", "going back keeps what was typed");
await page.click('dialog button[value="review"]');
await page.waitForSelector("dialog .report-body");
await page.fill("dialog .report-body", "## What happened\n\nTrimmed by hand.");
await page.click('dialog button[value="send"]');
await page.waitForFunction(() => document.querySelector("dialog h1")?.textContent === "Issue #7 created");
assert.deepEqual(filed, { title: "Frame goes off the bed", body: "## What happened\n\nTrimmed by hand." }, "exactly the reviewed text is sent");
assert.equal(await page.getAttribute("dialog a", "href"), "https://github.com/allannapier/engraver/issues/7");
await page.click('dialog button[value=""]');

step("without a GitHub sign-in it opens a pre-filled issue page instead");
await page.unroute("**/api/bug/status");
await page.unroute("**/api/bug/report");
await page.evaluate(() => {
  window.open = (url) => {
    window.__opened = url;
    return null;
  };
});
await page.click("#report-bug");
await page.waitForSelector("dialog[open]");
assert.match(await page.textContent("dialog"), /opens a pre-filled issue page/);
assert.equal(await page.inputValue('dialog input[type="text"]'), "", "the form starts clean after a report is filed");
await page.fill('dialog input[type="text"]', "Second problem");
await page.locator("dialog textarea").first().fill("Something else went wrong.");
await page.click('dialog button[value="review"]');
await page.waitForSelector("dialog .report-body");
assert.equal(await page.textContent('dialog button[value="send"]'), "Open issue page");
await page.click('dialog button[value="send"]');
await page.waitForFunction(() => document.querySelector("dialog h1")?.textContent === "Finish on GitHub");
const issuePage = await page.evaluate(() => window.__opened);
assert.ok(issuePage.startsWith("https://github.com/allannapier/engraver/issues/new?title=Second+problem&body="), issuePage.slice(0, 120));
assert.ok(issuePage.length < 8000);
await page.locator('dialog button[value=""]').click();

step("a design is saved in the app, replaced by a new one, and opened again");
await page.click("#project-save");
await page.fill('dialog input[name="name"]', "Clean square");
await page.click('dialog button[value="ok"]');
await page.waitForFunction(() => document.getElementById("design-name").textContent === "Clean square");
await page.click("#project-open");
await page.waitForSelector("dialog .design-row");
assert.equal(await page.locator("dialog .design-row").count(), 1);
assert.match(await page.locator("dialog .design-thumb img").getAttribute("src"), /^data:image\/jpeg;base64,/);
await page.click('dialog button:has-text("New design")');
await page.waitForFunction(() => window.__store.state.doc.objects.length === 0);
assert.equal(await page.textContent("#design-name"), "");
await page.click("#project-save");
await page.fill('dialog input[name="name"]', "clean SQUARE");
await page.click('dialog button[value="ok"]');
await page.waitForSelector('dialog h1:has-text("Replace")');
await page.click('dialog button:has-text("Cancel")');
await page.click("#project-open");
await page.locator("dialog .design-row").first().getByRole("button", { name: "Open" }).click();
await page.waitForFunction(() => window.__store.state.doc.objects.length === 1);
assert.equal(await page.textContent("#design-name"), "Clean square");
await store((s) => { s.state.doc.objects[0].x += 1; s.commit(); });
assert.equal(await page.textContent("#design-name"), "Clean square •");
await page.locator("#stage").focus();
await page.keyboard.press("Control+s");
await page.waitForFunction(() => document.getElementById("design-name").textContent === "Clean square");

step("the project survives a reload");
await page.reload();
await ready();
await page.waitForSelector(".obj");
assert.equal(await store((s) => s.state.doc.objects.length), 1);

step("assistant parts drawn in one viewBox line up across layers");
await page.route("**/api/state", async (route) => {
  const response = await route.fetch();
  const body = await response.json();
  body.config.llm.model = "test/model";
  await route.fulfill({ response, json: body });
});
await page.unroute("**/api/ai/chat");
await page.route("**/api/ai/chat", async (route) => {
  asked = route.request().postDataJSON();
  await route.fulfill({
    json: {
      text: "Two tokens with a mark engraved on each.",
      actions: [
        { type: "add_design", name: "Token outlines", mode: "line", width_mm: 60, x_mm: 100, y_mm: 100, note: "Cut outlines.",
          svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 24"><g fill="none" stroke="#000"><circle cx="12" cy="12" r="12"/><circle cx="48" cy="12" r="12"/></g></svg>' },
        { type: "add_design", name: "Token marks", mode: "fill", width_mm: 999, align_with: "Token outlines", note: "Marks.",
          svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 24"><rect x="10" y="10" width="4" height="4"/><rect x="46" y="10" width="4" height="4"/></svg>' },
      ],
    },
  });
});
await page.reload();
await ready();
await page.click('[data-tab="assistant"]');
await page.fill("#tab-assistant textarea", "Two tokens with a mark on each");
await page.press("#tab-assistant textarea", "Enter");
await page.waitForFunction(() => window.__store.state.doc.objects.some((o) => o.name === "Token marks"));
assert.ok(asked.context.designs.every((d) => d.kind !== "svg" || d.svg?.startsWith("<svg")), "every design's SVG goes to the assistant");
const [outline, marks] = await store((s) => ["Token outlines", "Token marks"].map((n) => {
  const o = s.state.doc.objects.find((d) => d.name === n);
  return { x: o.x, y: o.y, w: o.w, h: o.h };
}));
near(outline.w, 60, 0.01);
near(marks.w, 40, 0.01); // keeps the outline's scale, not its own width_mm
near(marks.x - outline.x, 10, 0.01);
near(marks.y - outline.y, 10, 0.01);
const lined = await page.locator(".msg.assistant .did").allTextContents();
assert.ok(lined.some((n) => n.includes('lined up with "Token outlines"')), lined.join(" | "));
await page.keyboard.press("Escape");
await page.locator("#stage").focus();
await page.keyboard.press("Control+z");
assert.equal(await store((s) => s.state.doc.objects.length), 1);
await page.unroute("**/api/state");

await page.click("#connect");
await waitStatus((s) => !s.connected);
await browser.close();
assert.deepEqual(errors, [], "no console errors");
console.log("ok");
