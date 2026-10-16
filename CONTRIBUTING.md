# Contributing

Bug reports, fixes and features are welcome.

## Reporting a bug

The quickest route is **Report a bug** in the app's top bar: it attaches the machine state, the last job and the logs, and shows you the full text before anything is sent. Otherwise open an [issue](https://github.com/allannapier/engraver/issues) and say what you did, what happened, and what you expected.

Security problems go through [SECURITY.md](SECURITY.md), not a public issue.

## Making a change

1. For anything larger than a small fix, open an issue first so we can agree on the approach.
2. Fork the repository and work on a branch.
3. Run the checks below.
4. Open a pull request that says what changed and how you tested it. Say whether you ran it on a real laser or only on the simulator.

### Setup and checks

Needs [uv](https://docs.astral.sh/uv/) and Python 3.11+.

```bash
uv run engraver          # run the app; pick "Simulator" if no laser is plugged in
uv run pytest --cov      # tests (CI fails under 85 % coverage)
uv run ruff check .      # lint
uv run ruff format .     # format
```

The browser test is described in the [README](README.md#tests). CI runs all of it on every pull request.

### Rules a change must keep

This app drives a machine that can start a fire or damage eyesight, so a few things are not up for change without a very good reason:

- MCP clients can never start or resume a job, send console commands, home or unlock. A job starts only when the person clicks Start burning.
- Stop is feed hold, wait for motion to end, then soft reset. Any GRBL error on a job line halts the job.
- The server listens on loopback only and rejects foreign Host and Origin headers.
- Every SVG that enters the page is sanitised.
- A bug report is only filed after the person has seen its full text, and tests never file a real one.
- Tests contain no secret-shaped strings, even fake ones.

[CLAUDE.md](CLAUDE.md) has the full list and the code conventions. If you change the controller, change the simulator with it.

## Licence

Engraver is released under the [MIT License](LICENSE). By submitting a contribution you agree that it is licensed under the same terms, and that you have the right to submit it.
