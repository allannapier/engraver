# Engraver

[![CI](https://github.com/allannapier/engraver/actions/workflows/ci.yml/badge.svg)](https://github.com/allannapier/engraver/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Site:** https://allannapier.github.io/engraver/

A local browser app for designing and running jobs on an Atomstack A10 (or any GRBL diode laser). A small Python server talks to the laser over USB; the app runs in your browser at `127.0.0.1`.

- **Canvas**: import SVGs and pictures, add text and shapes, then move, scale and rotate them on a to-scale bed.
- **Layers**: speed, power, passes and mode (line or fill) per layer.
- **Saved designs**: **Save** (Ctrl+S) keeps the canvas and its layers in the app; **Open** lists them with a preview. They live in `~/.engraver/designs/`. **Download file** and **Open a file** move a design between computers.
- **Materials**: burn a test card on scrap, pick the best square, and keep the result in your own material library.
- **Laser control**: connect, jog, set and go to origin, frame, start, pause, resume, stop.
- **AI over MCP**: Claude Code (or any MCP client) can draw designs, rework them, set layers and frame the job. Only you can start it.
- **Simulator**: a built-in fake laser, so everything can be tried without the machine.

## Run it

Needs [uv](https://docs.astral.sh/uv/) and Python 3.11+.

```bash
git clone https://github.com/allannapier/engraver
cd engraver
uv run engraver
```

That starts the server on port 8642 and opens the app. `--port N` changes the port, `--no-browser` skips opening a window.

## First job

1. Plug the A10 in by USB and switch it on. Pick its port in the top bar and **Connect**. No laser to hand? Pick **Simulator**.
2. Add a design: import a file, drag one onto the canvas, paste SVG, or use the text and shape tools.
3. Put each design on a layer (the Layer box above the canvas) and set that layer's speed and power. Choosing a **Material** in the Design tab unlocks presets per layer.
4. In the **Laser** tab, choose where the job starts:
   - **Bed position**: the canvas is the bed, and the design burns where you placed it.
   - **Origin**: the design's front-left corner lands on the origin. Jog to the corner of your material, **Set origin here**, and go.
5. **Frame** traces the job's outline with the laser off. Then **Start**, check the summary, and confirm.

**Stop** is always available while connected. It turns the laser off, waits for the head to halt, and clears the queue without losing position.

### Keys

| | |
|---|---|
| Arrows | nudge 1 mm (Shift 10 mm, Alt 0.1 mm) |
| Ctrl/Cmd+Z, Shift+Z | undo, redo |
| Ctrl/Cmd+D | duplicate |
| Delete | delete |
| Scroll | zoom |
| Space+drag | pan |
| Shift while resizing | toggle keep-proportions |
| Shift while rotating | snap to 15° |

## Finding settings for a material

The built-in materials are generic starting points. To get settings for your machine and your stock:

1. In the **Design** tab, pick the closest material (or **New material**) and press **Test grid**.
2. Choose what you're testing for:
   - **Engrave**: filled squares across a range of speed and power.
   - **Score**: outlined squares across speed and power.
   - **Cut**: outlined squares across speed and number of passes at fixed power. The ones that drop out are cut through.
3. Jog to a piece of scrap, **Set origin here** in the Laser tab, then **Frame test** and **Burn test**. The card's front-left corner lands on the origin, and the values are engraved on it so you can keep it.
4. Click the square that came out best and **Save**. It's stored under that material as "picked from a test".

After that, a layer's **Presets** menu applies the saved engrave, score or cut setting, and can save a layer's current settings back to the material. **Edit** lets you type settings in by hand. MCP clients read your library and are told to prefer it over the generic table.

Your materials live in `~/.engraver/materials.json`, next to the settings file.

Settings live in `~/.engraver/config.json` (override with `ENGRAVER_CONFIG`).

## Reporting a bug

**Report a bug** (top right) files a GitHub issue with what someone needs to fix it:

- your description, plus what you expected
- app version and commit, Python, OS, browser
- machine state and the controller's `$$` settings
- the last job sent (settings, size, first lines of G-code)
- the laser console, server errors with tracebacks, browser errors, failed requests and recent clicks
- layers and designs on the canvas, without pictures

You always see the full text first and can edit or delete any of it. Tokens are stripped out, and your home folder's path is shortened to `~`. It never records what you type into text boxes.

How it files, in order of preference:

1. A GitHub token saved in Setup (or `GITHUB_TOKEN` / `GH_TOKEN`). It needs Issues read and write access to the repository.
2. The `gh` command-line tool, if it's installed and signed in. No setup needed.
3. Otherwise it opens a pre-filled issue page for you to submit, with the full report on your clipboard.

The repository defaults to `allannapier/engraver` and can be changed in Setup. That repository is public, so reports are too. Set `ENGRAVER_BUG_DRY_RUN=1` to try the form without creating anything.

## Camera

A USB webcam above the bed puts a photo of the bed on the canvas, so you can place designs on the material you've actually got, and lets MCP clients such as Claude Code see it too.

1. Mount the camera looking down at the whole bed and plug it in.
2. In **Setup → Camera**, pick it and use **Show preview** to check the view (the browser asks once for permission).
3. **Put marks on the canvas** adds four crosses on their own layer. Burn them on a sheet covering the bed, or draw crosses by hand at spots you've measured.
4. **Calibrate** takes a picture: click the centre of each mark in order (back left, back right, front right, front left) and check their X and Y. Save, and the corrected bed photo appears on the canvas. Check the grid lines up with the marks.

The camera button beside the canvas takes a new photo. The bar above the canvas says how old it is and retakes or hides it. Move the head out of the way first: it hides what's under it. The camera turns off after a minute and a half without a photo.

Calibration corrects perspective, not lens distortion, so a wide-angle lens is a few mm out near the edges. Calibrate again if the camera moves.

## Machine notes

- The A10 speaks GRBL at 115200 baud. On connect the app reads the controller's `$$` settings: the full-power value (`$30`) and top speed (`$110`) come from the machine, and Setup offers the reported travel as the bed size.
- Jobs are refused if laser mode is off (`$32=0`); send `$32=1` from the console in the Laser tab.
- Everything runs in `M4` dynamic power, so the beam is off during travel moves and scales down in corners.
- The origin is stored with `G10 L20` (GRBL's G54 offset), so it survives a stop and a power cycle. The Laser tab shows when one is active and lets you clear it.
- The built-in material values are starting points for a 10 W diode, not measured on your machine. Use the test grid to replace them with your own.

## Using it with Claude Code and other MCP clients

Engraver has no AI built in: you bring your own through MCP, so a Claude subscription works and nothing needs an API key. Setup shows the command below with a Copy button.

While Engraver is running, it is also an MCP server at `http://127.0.0.1:8642/mcp`. Add it to Claude Code with:

```bash
claude mcp add --transport http engraver http://127.0.0.1:8642/mcp
```

Clients that only start local programs (stdio) can run `engraver-mcp` instead, which passes messages on to the running app.

Keep Engraver open in your browser: the canvas lives there, and every change shows up on it and can be undone like any other edit. The server tells the client how to draw for a laser (closed outlines for cuts, solid black for engraving, lining parts up across layers) and to keep power at or below 90 %.

Try, for example: "a 90 mm coaster with a mountain line drawing, engraved, with a cut circle around it", or "recommend settings for 3 mm birch ply".

A client can:

- read the canvas, its layers and the machine's status, and get a picture of the bed
- with a calibrated camera, get a fresh photo of the bed (all of it, or part zoomed in) with a mm grid and the designs drawn over it (**get_bed_photo**)
- add, change, move and delete designs and layers and read your materials
- save, open and start new designs
- connect, jog, set or go to the origin, frame the job, and pause or stop a job

It can't start or resume a job. **request_job_start** opens the usual "Start burning?" confirmation in the app, marked with the client's name, and nothing burns until you click **Start burning**. Framing uses the laser only if you switched on the 2 % dot in the Laser tab.

## Safety

A 10 W diode laser blinds and starts fires. Wear goggles rated for 455 nm, ventilate, never leave a running job, and keep to the "never laser" list in the Design tab (PVC and vinyl release chlorine gas).

The server only listens on `127.0.0.1` and rejects requests that don't come from its own page, so other websites can't reach it. Programs on your own computer can, including MCP clients: they can move the head, but only you can start a job.

You run this software at your own risk. It comes with no warranty, the built-in settings are untested starting points, and nothing in it replaces watching the machine. See the [license](LICENSE).

## How it's built

```
src/engraver/
  cli.py            starts uvicorn, opens the browser
  app.py            FastAPI routes, websocket, request guard
  grbl/controller.py  serial streaming, status, pause/stop, origin
  grbl/simulator.py   in-process fake GRBL used by "Simulator" and the tests
  gcode.py          job description -> G-code (vector, raster, frame)
  materials.py      generic starting-point table and never-laser list
  library.py        your own materials (saved and tested settings)
  saved.py          saved designs
  bugs.py           bug reports: diagnostics, redaction, filing the GitHub issue
  mcp.py            MCP server: tools for Claude Code and others, relayed to the open page
  config.py         saved settings
  static/           the browser app (plain ES modules, no build step); js/canvasedit.js applies MCP canvas edits
    js/camera.js    webcam capture, calibration maths, corrected bed photo
```

The browser does the geometry: line layers are traced from the live SVG into polylines, fill layers are rendered to a bitmap at the layer's line gap. The server turns those into G-code and streams it with GRBL's character-counting protocol. The camera is the browser's too: it captures the picture and corrects it to the bed; the server only keeps the calibration.

## Tests

```bash
uv run pytest                      # controller vs simulator, G-code, API, MCP
uv run pytest --cov                # the same, with coverage (fails under 85 %)
uv run ruff check .                # lint
uv run ruff format .               # format
```

Browser test (needs Node):

```bash
(cd tests/e2e && npm ci && npx playwright install chromium)   # once
ENGRAVER_SIM_SPEED=20 ENGRAVER_BUG_DRY_RUN=1 ENGRAVER_CONFIG=/tmp/engraver-e2e.json uv run engraver --no-browser &
node tests/e2e/smoke.mjs
```

The site's screenshots (`docs/img/`) are taken the same way: with the server running on a fresh `ENGRAVER_CONFIG` and `HOME`, `node docs/screenshots.mjs`.

The browser test runs Chromium with a fake camera that plays a made-up picture of the bed (`tests/e2e/fakecamera.mjs`), calibrates it by clicking the marks, and checks the corrected photo against where the board really is.

CI (`.github/workflows/ci.yml`) runs all of this on every pull request and on `main`: lint and format, the unit tests on Python 3.11 to 3.14, the browser test against the simulator, and a wheel build that checks the frontend is packaged.

## Not there yet

- Text can't be traced as outlines on a line layer (it engraves fine on a fill layer).
- No node editing, boolean operations or image tracing.
- The material test card is new and has only been burned on the simulator so far.

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up, test and what a change must keep intact, and [SECURITY.md](SECURITY.md) for reporting a vulnerability privately. Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © 2026 Allan Napier. Free to use, change and share, including commercially, as long as the copyright and license notice stay with it. The software is provided "as is", without warranty of any kind, and the author is not liable for any damage or injury arising from its use.
