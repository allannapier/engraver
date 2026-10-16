// Takes the screenshots on the project site (docs/img/) from the running app and its simulator.
//
//   ENGRAVER_SIM_SPEED=20 ENGRAVER_BUG_DRY_RUN=1 ENGRAVER_CONFIG=/tmp/engraver-docs.json uv run engraver --no-browser
//   node docs/screenshots.mjs            (needs `playwright` resolvable, as for tests/e2e; set PLAYWRIGHT_PATH if it's elsewhere)
//
// Start from a fresh settings file and HOME: the script connects the simulator and saves a camera calibration.
// The camera is Chromium's fake one, playing the made-up bed picture from the browser test.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFakeCamera, pictureOf, MARKS, WIDTH } from "../tests/e2e/fakecamera.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_PATH || "playwright");
const BASE = process.env.ENGRAVER_URL || "http://127.0.0.1:8642";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "img");
mkdirSync(OUT, { recursive: true });

const cameraFile = join(mkdtempSync(join(tmpdir(), "engraver-cam-")), "bed.y4m");
writeFakeCamera(cameraFile);
const browser = await chromium.launch({
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${cameraFile}`],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, permissions: ["camera"] });
page.on("pageerror", (e) => console.log(`  page error: ${e.message}`));

const hideToasts = () => page.addStyleTag({ content: ".toasts { display: none !important; }" });
const shot = async (name, clip) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${name}.png`), clip });
  console.log(`- ${name}.png`);
};
const waitStatus = (fn) => page.waitForFunction(`(${fn})(window.__store.state.status)`, null, { timeout: 30000 });

let rpcId = 0;
const mcp = async (method, params) => {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const { result } = await res.json();
  if (result?.isError) throw new Error(result.content[0].text);
  return result;
};
const tool = async (name, args = {}) => {
  const first = (await mcp("tools/call", { name, arguments: args })).content[0];
  return first.type === "text" && /^[[{]/.test(first.text) ? JSON.parse(first.text) : first;
};

await page.goto(BASE);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector(".layer");
await page.evaluate(async () => { window.__store = await import("/js/store.js"); });
await hideToasts();

// Connect the simulator.
await page.click("#connect");
await waitStatus((s) => s.connected);

// A coaster, drawn by "Claude Code" over MCP: engraved mountains lined up inside a cut circle.
await mcp("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "1" }, capabilities: {} });
const outline = await tool("add_design", {
  name: "Coaster outline", mode: "line", width_mm: 90, x_mm: 135, y_mm: 125,
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90 90"><circle cx="45" cy="45" r="45" fill="none" stroke="#000"/></svg>',
});
await tool("add_design", {
  name: "Mountains", mode: "fill", align_with: outline.design_id,
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90 90">
    <circle cx="62" cy="27" r="7"/>
    <path d="M10 60 L30 30 L38 41 L50 21 L80 60 Z"/>
    <rect x="18" y="65" width="54" height="2"/><rect x="24" y="70" width="42" height="2"/><rect x="31" y="75" width="28" height="2"/>
  </svg>`,
});
const state = await tool("get_state");
const layers = Object.fromEntries(state.canvas.layers.map((l) => [l.mode, l.id]));
await tool("set_layer", { layer_id: layers.fill, speed: 5000, power: 35, interval: 0.1 });
await tool("set_layer", { layer_id: layers.line, speed: 300, power: 90, passes: 3 });
await page.locator("#stage").focus();
await page.keyboard.press("Escape"); // deselect
await page.click('[data-tab="design"]');
await shot("design");
await shot("layers", { x: 380, y: 52, width: 1060, height: 780 });

// Laser tab: jog away from home so the head moves during the job.
await page.click('[data-tab="laser"]');
await page.click('button[aria-label="Move right"]');
await page.click('button[aria-label="Move back"]');
await waitStatus((s) => s.state === "Idle");

// Frame, then the client asks to start: the person still has to click.
await tool("frame_job");
await waitStatus((s) => s.job?.kind === "frame" && s.job.state === "done");
await tool("request_job_start");
await page.waitForSelector("dialog[open]");
await shot("confirm");
await page.click('dialog button[value="go"]');
await waitStatus((s) => s.job?.kind === "job" && s.job.state === "running" && s.job.progress > 0.1);
await shot("running");
await page.click("#job-stop");
await waitStatus((s) => s.job?.state !== "running");

// Material test card, with a square picked after the burn.
await page.click('[data-tab="design"]');
const ply = await page.evaluate(() => [...document.querySelectorAll("#material option")].find((o) => /birch/i.test(o.textContent))?.value);
await page.selectOption("#material", ply);
await page.getByRole("button", { name: "Test grid" }).click();
await page.waitForSelector(".test-preview");
await page.getByRole("button", { name: "Engrave", exact: true }).click();
await page.locator('.test-cell[data-r="1"][data-c="2"]').click();
await page.locator(".test-preview").evaluate((el) => el.scrollIntoView({ block: "center" }));
await shot("test-grid");
await page.getByRole("button", { name: /Save as the engrave setting/ }).click();
await page.getByRole("button", { name: "Back to layers" }).click();

await page.click('[data-tab="setup"]');

// Camera: calibrate on the four marks, then the bed photo under the canvas.
await page.locator("#camera-section").scrollIntoViewIfNeeded();
await page.click("#camera-section button:has-text('Calibrate')");
await page.waitForSelector("dialog[open] .calib canvas");
await page.waitForFunction(() => document.querySelector("dialog .calib canvas").width > 0);
const picture = page.locator("dialog .calib canvas");
const scale = (await picture.boundingBox()).width / WIDTH;
for (const [x, y] of MARKS) {
  const [u, v] = pictureOf(x, y);
  await picture.click({ position: { x: u * scale, y: v * scale } });
}
await shot("calibrate");
await page.click('dialog button[value="save"]');
await page.waitForSelector("#photo-bar:not([hidden])", { timeout: 15000 });
await page.click('[data-tab="design"]');
await shot("bed-photo");

// What Claude Code sees: a zoomed bed photo with the mm grid and the designs drawn over it.
const photo = await tool("get_bed_photo", { x_mm: 90, y_mm: 100, width_mm: 200, height_mm: 140 });
writeFileSync(join(OUT, "mcp-bed-photo.jpg"), Buffer.from(photo.data, "base64"));
console.log("- mcp-bed-photo.jpg");

await page.click("#connect");
await browser.close();
