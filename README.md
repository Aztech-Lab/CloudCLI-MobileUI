# CloudCLI-Mobile

**Run Claude Code on your own computer and drive it from your phone.**

CloudCLI-Mobile is a self-hosted web UI for [Claude Code](https://docs.anthropic.com/en/docs/claude-code), tuned for one setup: the agent runs on a machine at home or in the lab, and you use it from a phone or tablet — over your LAN or a VPN, in the browser or as a home-screen web app.

It is a downstream fork of [CloudCLI / claudecodeui](https://github.com/siteboon/claudecodeui) by Siteboon. The upstream project does the heavy lifting (chat, sessions, file browser, git, terminal, multiple providers); this fork adds the changes that make it pleasant and safe to use from a phone. It is independent and not affiliated with upstream — please report problems with this fork [here](https://github.com/Aztech-Lab/CloudCLI-Mobile/issues), not upstream.

## What this fork changes

### Keep working while background agents run *(in review — [PR #1](https://github.com/Aztech-Lab/CloudCLI-Mobile/pull/1))*
Send a subagent off on a long job (a literature search, a test run) and keep talking to the main thread. Your new message goes into the live Claude Code process as a new turn; background agents keep running and report back when done — the same as the official CLI. Upstream stops the background work when you send. Stop only ends the current turn; model, permission-mode and effort changes are applied to the running process.

### Smooth scrolling on phones
Long chats scroll up without stutter on iOS and Android (messages that were never on screen no longer resize under your finger).

### iPhone home-screen app
The iOS standalone web app fills the whole screen (no blank band at the bottom) and the header sits right under the status bar.

### Files from anywhere on the machine
Open files the agent mentions even when they live outside your home folder (other drives, data directories) — read-only, configured by you.

### Big projects in the file tree
Projects with tens of thousands of files no longer fail to show: the tree loads what fits and fetches the rest of a folder when you open it.

### The real model list
The model picker shows exactly what Claude Code itself offers for your account (same as `/model`), instead of a fixed list that goes stale.

## Install

Requirements: Node.js 22+, and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and logged in on the host.

```bash
git clone https://github.com/Aztech-Lab/CloudCLI-Mobile.git
cd CloudCLI-Mobile
npm ci
npm run build
npm run server
```

Open `http://<host-ip>:3001` from your phone and create the single admin account on first visit (do this before exposing the port — the first visitor becomes the admin).

On iOS, use **Share → Add to Home Screen** for the full-screen app.

## Configuration

Set these as environment variables before starting the server.

| Variable | Default | Purpose |
|---|---|---|
| `SERVER_PORT` | `3001` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address (`127.0.0.1` = this machine only) |
| `CLAUDE_CLI_PATH` | `claude` | Path to the Claude Code executable |
| `DATABASE_PATH` | `~/.cloudcli/auth.db` | Login database |
| `CLOUDCLI_EXTRA_READ_ROOTS` | — | Extra folders the in-chat file viewer may read, separated by `;` (Windows) — e.g. `E:\Projects;F:\Data` |
| `CLOUDCLI_FILE_TREE_MAX_ENTRIES` | `10000` | How many entries the file tree loads up front |
| `CLAUDE_TOOL_APPROVAL_TIMEOUT_MS` | `55000` | How long a tool-approval prompt waits before it is denied; raise it if you approve from your phone later |

## Using it safely from a phone

Logging in to CloudCLI gives the same power as a shell on the host.

- It serves **plain HTTP**. Use it on your own LAN or through an encrypted VPN (IPsec, WireGuard, Tailscale). Do not forward the port to the internet, and avoid PPTP (its encryption is broken).
- Restrict the port with a firewall to the networks you actually use.
- Use a strong password — there is no rate limit on login attempts.
- In the tool settings (gear icon), allow only the tools you need.

## Staying current with upstream

This fork only **pulls** from upstream; it never pushes, opens pull requests, or files issues there. `main` = upstream + this fork's changes, `upstream-main` is an untouched mirror.

```bash
git remote add upstream https://github.com/siteboon/claudecodeui.git
git fetch upstream
git checkout upstream-main && git merge --ff-only upstream/main
git checkout main && git merge upstream-main
```

Every change in this fork is a separate commit and is marked `[local]` in the code, so other projects can take just the pieces they want. To keep this README during merges, enable the bundled merge rule once per clone: `git config merge.ours.driver true`.

Do not run `cloudcli update` on an install built from this repo — it replaces it with the upstream build.

## Contributing

One change per branch, merged into `main` through a pull request — see [docs/fork/SESSION-GUIDE.md](docs/fork/SESSION-GUIDE.md).

## License

[AGPL-3.0-or-later](LICENSE), same as upstream. If you run a modified version as a network service, the AGPL requires you to offer its source to its users; this repository is that source for CloudCLI-Mobile.

Original project: [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) © Siteboon and contributors.
