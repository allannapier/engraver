"""`engraver` command: start the local server and open the app in a browser."""

from __future__ import annotations

import argparse
import threading
import webbrowser

import uvicorn

from .app import create_app


def main() -> None:
    parser = argparse.ArgumentParser(prog="engraver", description="Design and run laser jobs from your browser.")
    parser.add_argument("--port", type=int, default=8642, help="port to serve on (default 8642)")
    parser.add_argument("--no-browser", action="store_true", help="don't open a browser window")
    args = parser.parse_args()

    url = f"http://127.0.0.1:{args.port}"
    if not args.no_browser:
        threading.Timer(1.0, webbrowser.open, args=(url,)).start()
    print(f"Engraver is running at {url}  (Ctrl+C to quit)")
    app = create_app()
    try:
        # Loopback only: this server can move a laser, so it never listens on the network.
        # The shutdown timeout stops an open browser tab from holding the server up on Ctrl+C.
        uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning", timeout_graceful_shutdown=2)
    finally:
        # Whatever way the server ends, don't leave a job running with nothing in control.
        controller = app.state.controller
        controller.disconnect()
        if controller.job and controller.job.error == "Disconnected while running":
            print(f"Stopped {controller.job.name.lower()} and turned the laser off before quitting.")


if __name__ == "__main__":
    main()
