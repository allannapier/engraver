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
    # Loopback only: this server can move a laser, so it never listens on the network.
    uvicorn.run(create_app(), host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
