# Engraver

[![CI](https://github.com/allannapier/engraver/actions/workflows/ci.yml/badge.svg)](https://github.com/allannapier/engraver/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A local browser app for designing and running jobs on an Atomstack A10 (or any GRBL diode laser). A small Python server talks to the laser over USB; the app runs in your browser at `127.0.0.1`.

- **Canvas**: import SVGs and pictures, add text and shapes, then move, scale and rotate them on a to-scale bed.
- **Layers**: speed, power, passes and mode (line or fill) per layer.
- **Materials**: burn a test card on scrap, pick the best square, and keep the result in your own material library.
- **Laser control**: connect, jog, set and go to origin, frame, start, pause, resume, stop.
- **Assistant**: add your LLM provider and it can draw designs, rework the selected one, and recommend settings.
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

After that, a layer's **Presets** menu applies the saved engrave, score or cut setting, and can save a layer's current settings back to the material. **Edit** lets you type settings in by hand. The assistant is given your library and prefers it over the generic table.

Your materials live in `~/.engraver/materials.json`, next to the settings file.

## The assistant

In **Setup**, enter a model in LiteLLM form (`provider/model`, for example `anthropic/claude-sonnet-5-5` or `ollama/your-local-model`), an API key, and a base URL if the model is local or self-hosted. **Save and test** checks it.

Then use the **Assistant** tab:

- "A 90 mm coaster with a mountain line drawing, engraved, with a cut circle around it"
- Select a design: "make the lines bolder and drop the border"
- "Recommend settings for 3 mm birch ply"

It acts by editing the canvas and the layer settings, and each reply is one undo step. It has no way to move the head or fire the laser.

Settings live in `~/.engraver/config.json` (override with `ENGRAVER_CONFIG`). The API key is stored there in plain text, readable only by you, and is sent only to the provider you chose.

## Reporting a bug

**Report a bug** (top right) files a GitHub issue with what someone needs to fix it:

- your description, plus what you expected
- app version and commit, Python, OS, browser
- machine state and the controller's `$$` settings
- the last job sent (settings, size, first lines of G-code)
- the laser console, server errors with tracebacks, browser errors, failed requests and recent clicks
- layers and designs on the canvas, without pictures
- optionally, the last few assistant messages

You always see the full text first and can edit or delete any of it. API keys and tokens are stripped out, and your home folder's path is shortened to `~`. It never records what you type into text boxes.

How it files, in order of preference:

1. A GitHub token saved in Setup (or `GITHUB_TOKEN` / `GH_TOKEN`). It needs Issues read and write access to the repository.
2. The `gh` command-line tool, if it's installed and signed in. No setup needed.
3. Otherwise it opens a pre-filled issue page for you to submit, with the full report on your clipboard.

The repository defaults to `allannapier/engraver` and can be changed in Setup. That repository is public, so reports are too. Set `ENGRAVER_BUG_DRY_RUN=1` to try the form without creating anything.

## Machine notes

- The A10 speaks GRBL at 115200 baud. On connect the app reads the controller's `$$` settings: the full-power value (`$30`) and top speed (`$110`) come from the machine, and Setup offers the reported travel as the bed size.
- Jobs are refused if laser mode is off (`$32=0`); send `$32=1` from the console in the Laser tab.
- Everything runs in `M4` dynamic power, so the beam is off during travel moves and scales down in corners.
- The origin is stored with `G10 L20` (GRBL's G54 offset), so it survives a stop and a power cycle. The Laser tab shows when one is active and lets you clear it.
- The built-in material values are starting points for a 10 W diode, not measured on your machine. Use the test grid to replace them with your own.

## Safety

A 10 W diode laser blinds and starts fires. Wear goggles rated for 455 nm, ventilate, never leave a running job, and keep to the "never laser" list in the Design tab (PVC and vinyl release chlorine gas).

The server only listens on `127.0.0.1` and rejects requests that don't come from its own page, so other websites can't reach it.

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
  bugs.py           bug reports: diagnostics, redaction, filing the GitHub issue
  llm.py            assistant prompt, tools, LiteLLM call
  config.py         saved settings
  static/           the browser app (plain ES modules, no build step)
```

The browser does the geometry: line layers are traced from the live SVG into polylines, fill layers are rendered to a bitmap at the layer's line gap. The server turns those into G-code and streams it with GRBL's character-counting protocol.

## Tests

```bash
uv run pytest                      # controller vs simulator, G-code, API, assistant with a fake provider
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

CI (`.github/workflows/ci.yml`) runs all of this on every pull request and on `main`: lint and format, the unit tests on Python 3.11 to 3.14, the browser test against the simulator, and a wheel build that checks the frontend is packaged.

## Not there yet

- Text can't be traced as outlines on a line layer (it engraves fine on a fill layer).
- No node editing, boolean operations or image tracing.
- The material test card is new and has only been burned on the simulator so far.

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up, test and what a change must keep intact, and [SECURITY.md](SECURITY.md) for reporting a vulnerability privately. Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © 2026 Allan Napier. Free to use, change and share, including commercially, as long as the copyright and license notice stay with it. The software is provided "as is", without warranty of any kind, and the author is not liable for any damage or injury arising from its use.
