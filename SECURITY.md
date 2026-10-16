# Security

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting instead: on the repository's **Security** tab, choose **Report a vulnerability** ([direct link](https://github.com/allannapier/engraver/security/advisories/new)).

Include what you found, how to reproduce it, and which version or commit you tested. This is a personal project maintained in spare time, so replies are best effort.

Only the latest commit on `main` is supported.

## What counts

Engraver runs a server on `127.0.0.1` that can move a laser and switch it on. Reports of particular interest:

- another website or another machine on the network reaching the server (it binds to loopback and rejects foreign Host and Origin headers)
- imported, pasted or MCP-supplied SVG running script in the page
- an MCP client starting or resuming a job, or firing the laser beyond the 2 % frame dot, without a click
- a GitHub token leaking to the browser, a bug report or a log

## Not a vulnerability

- Someone with access to your user account reading `~/.engraver/config.json`. The optional GitHub token is stored there in plain text, readable only by you.
- Bug reports being public. They are filed as issues on a public repository, and you see the full text before sending.
- Unsafe laser settings. The app does not know your material or your enclosure; see Safety in the README.
