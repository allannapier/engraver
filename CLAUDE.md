# Engraver

Local browser app that drives a GRBL diode laser (Atomstack A10). Python/FastAPI server, plain ES-module frontend with no build step. See README.md for the user-facing description and the module map.

## Commands

- Run: `uv run engraver` (port 8642). `ENGRAVER_SIM_SPEED=20` speeds up the simulator; `ENGRAVER_CONFIG=path` points at a throwaway settings file.
- Tests: `uv run pytest`
- Browser test: start the server as above, then `node tests/e2e/smoke.mjs [screenshot-dir]` (set `PLAYWRIGHT_PATH` if `playwright` isn't resolvable).

## Rules that must keep holding

- The assistant only returns canvas and layer edits (`llm.TOOLS`). Never add a tool or route that lets model output move the head or fire the laser.
- Stop is feed hold, wait for motion to end, then soft reset (`GrblController._begin_halt`). Don't reset mid-motion: GRBL alarms and loses position. "Ended" is judged only from status reports that arrived after the hold, and the hold is re-sent if one shows motion (a hold that lands before motion starts is ignored by GRBL).
- Any GRBL error on a job line halts the job.
- The server binds to loopback only, and `_host_ok` rejects foreign Host and Origin headers. Keep both.
- Every SVG that enters the page goes through `sanitizeSvg` or `sanitizeMarkup` (imports, pastes, assistant output, project files, saved state).
- Power is scaled by the controller's `$30`, not the saved profile, when connected.
- Frame's visible dot is capped at 2 % in `gcode.frame_gcode`.
- The built-in table in `materials.py` is never modified at runtime. Saving against a built-in material copies it into the person's library (`library.py`, ids start with `my-`).
- The assistant reads the material library but has no tool to write to it: entries are things the person saved or picked from a burned test.
- A bug report is only filed after the person has seen its full text (`bugreport.js` review step). The server files exactly the text it is given, after `bugs.scrub`. The assistant has no tool to file one.
- Anything new that goes into a bug report passes through `bugs.scrub`, and typed text is never captured by `diagnostics.js`.
- Tests must never create a real issue: replace `app.state.github` in pytest, and route `/api/bug/report` in the browser test. `ENGRAVER_BUG_DRY_RUN=1` forces the link fallback.

## Conventions

- The material test (`static/js/testgrid.js`) is an ordinary job with one layer per square, built in the browser and run in origin mode. Keep it that way rather than adding a server-side generator.
- Canvas coordinates are mm, origin top-left, Y down. Machine coordinates are origin front-left, Y away. The flip happens once, in `gcode.build_job`. Anything shown to the user or the assistant uses machine coordinates.
- Speeds are mm/min, power is percent.
- An object is SVG markup plus a viewBox, scaled into `x, y, w, h` and rotated about its centre. Geometry is never rewritten; tracing reads the live DOM.
- Change the simulator alongside the controller: tests rely on it behaving like GRBL 1.1 (128-byte RX buffer, 16-block planner, sync on `$` and `G10`).
- UI copy: plain verbs, sentence case, errors say what happened and what to do.
