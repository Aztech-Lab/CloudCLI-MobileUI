# CloudCLI-MobileUI

**Run Claude Code on your own computer. Drive it from your phone.**

CloudCLI-MobileUI is a self-hosted web UI for [Claude Code](https://docs.anthropic.com/en/docs/claude-code), tuned for one setup: the agent runs on a machine at home or in the lab, and you use it from a phone or tablet over your LAN or a VPN — in the browser or as a home-screen web app.

It is a downstream fork of [CloudCLI (claudecodeui)](https://github.com/siteboon/claudecodeui) by Siteboon. Upstream provides the foundation — chat, sessions, file browser, git, terminal, multiple providers. This fork adds what makes it comfortable and safe to use from a phone. It is independent and not affiliated with upstream: report problems with this fork [here](https://github.com/Aztech-Lab/CloudCLI-MobileUI/issues), not upstream.

**Current base:** upstream `1.37.8` · **Latest update:** 2026-11-15 · [Changelog](#changelog)

---

## Highlights

### On the phone
- **Swipe between tabs** — swipe left/right anywhere to move between Chat, Files, Git and Shell; swipe right on Chat (or on the home screen) to open the menu. Edge swipes stay with the system back gesture, and code blocks and tables scroll first.
- **Pick up where you left off** — the home screen lists your five most recent conversations and their projects; one tap to continue.
- **Smooth scrolling** — long conversations scroll up without stutter on iOS and Android.
- **Full-screen iPhone app** — added to the home screen, the app fills the whole display with no blank band at the bottom.

### Look and feel
- **Skins** — *Settings › Appearance › Skin*. Ships with **OTSR**: lab white / near-black, a copper accent, square corners with chamfered edges, monospace labels. Works in light and dark mode.
- **Per-skin options** — each skin exposes its own dials (for OTSR: dot-field strength, chamfers, mono labels, square status marks), saved per skin and synced across your devices.
- **Theme-ready UI** — every colour, radius and font is a design token, so a new skin is a list of overrides with no component changes ([docs/fork/THEMING.md](docs/fork/THEMING.md)).

### Working with Claude
- **The real model list** — the model picker shows exactly what Claude Code offers your account (the same list as `/model`), instead of a fixed list that goes stale.

### Files
- **Files from anywhere on the machine** — open files the agent mentions even outside your home folder (other drives, data directories), read-only, limited to folders you configure.
- **Big projects** — projects with tens of thousands of files still show their tree; folders that did not fit load when you open them.

---

## Install

Requirements: Node.js 22+, and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and logged in on the host.

```bash
git clone https://github.com/Aztech-Lab/CloudCLI-MobileUI.git
cd CloudCLI-MobileUI
npm ci
npm run build
npm run server
```

Open `http://<host-ip>:3001` and create the single admin account on the first visit. **Do this before exposing the port** — the first visitor becomes the admin.

On iOS, use **Share › Add to Home Screen** for the full-screen app.

Do not run `cloudcli update` on an install built from this repo — it replaces it with the upstream build.

## Configuration

Environment variables, set before starting the server:

| Variable | Default | Purpose |
|---|---|---|
| `SERVER_PORT` | `3001` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address (`127.0.0.1` = this machine only) |
| `CLAUDE_CLI_PATH` | `claude` | Path to the Claude Code executable |
| `DATABASE_PATH` | `~/.cloudcli/auth.db` | Login database |
| `CLOUDCLI_EXTRA_READ_ROOTS` | — | Extra folders the in-chat file viewer may read, separated by `;` (e.g. `E:\Projects;F:\Data`) |
| `CLOUDCLI_FILE_TREE_MAX_ENTRIES` | `10000` | How many entries the file tree loads up front |
| `CLAUDE_TOOL_APPROVAL_TIMEOUT_MS` | `55000` | How long a tool-approval prompt waits before it is denied — raise it if you approve from your phone later |

## Using it safely from a phone

Logging in to CloudCLI gives the same power as a shell on the host.

- It serves **plain HTTP**. Use it on your own network or through an encrypted VPN (IPsec, WireGuard, Tailscale). Do not forward the port to the internet, and avoid PPTP (its encryption is broken).
- Restrict the port with a firewall to the networks you actually use.
- Use a strong password — there is no limit on login attempts.
- In the tool settings (gear icon), allow only the tools you need.

---

## Changelog

Newest first. Entries in review link to their pull request.

### In review
- **Keep working while background agents run** — send a subagent off on a long job and keep talking to the main thread; your message goes into the live Claude Code process as a new turn while background agents keep running, like the official CLI (upstream stops them). Stop ends only the current turn. — [#1](https://github.com/Aztech-Lab/CloudCLI-MobileUI/pull/1)

### 2026-11-15
- **Added** Per-skin options, declared by each skin and rendered in Settings automatically; OTSR gets dot field (off / faint / normal / strong), chamfers, mono labels and square marks. The OTSR dot field is softer by default.

### 2026-11-14
- **Added** Skin setting and the OTSR skin (light + dark), applied before the page renders so there is no flash.
- **Changed** The UI is theme-ready: colours, radii and fonts are design tokens. No visible change — verified declaration-by-declaration against the previous stylesheet.
- **Added** Home screen "pick up where you left off": recent conversations and projects.
- **Added** Swipe anywhere to switch workspace tabs; swipe back on Chat or the home screen opens the menu. **Changed** the Shell tab moves to the end of the tab strip.
- **Fixed** Stuttering upward scroll in long chats on touch devices.
- **Fixed** Blank band at the bottom of the iOS home-screen app; header tucked under the status bar.
- **Added** Model picker shows the list Claude Code itself reports.
- **Added** Read-only extra roots for the file viewer (`CLOUDCLI_EXTRA_READ_ROOTS`); configurable file-tree cap (`CLOUDCLI_FILE_TREE_MAX_ENTRIES`) with on-demand loading of folders that did not fit.
- Fork created from upstream `1.37.8`.

---

## Staying current with upstream

CloudCLI-MobileUI is its own project built on the upstream codebase. It only **pulls** from [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui); it never pushes, opens pull requests, or files issues there.

Upstream code enters this repository as **versioned snapshots**: the `upstream-snapshots` branch holds one commit per imported upstream release (code only, no upstream history), and `main` merges each new snapshot on top of this project's changes. To import a new release:

```bash
git remote add upstream https://github.com/siteboon/claudecodeui.git   # once
git config merge.ours.driver true                                      # once: keeps this README on merges
git fetch upstream
git checkout upstream-snapshots
git read-tree -u --reset upstream/main                                 # replace the snapshot with the new upstream code
git commit -m "Import upstream CloudCLI <version>"
git checkout main && git merge upstream-snapshots                      # resolve conflicts, test, build
```

Every change in this project is its own commit and is marked `[local]` in the code, so other projects can take just the pieces they want.

## Contributing

One change per branch, merged into `main` through a pull request — see [docs/fork/SESSION-GUIDE.md](docs/fork/SESSION-GUIDE.md). Describe the change in the pull request; the maintainer adds the changelog entry here when merging (do not edit this README in a feature branch — merges keep the `main` version).

## License

[AGPL-3.0-or-later](LICENSE), same as upstream. If you run a modified version as a network service, the AGPL requires you to offer its source to its users; this repository is that source for CloudCLI-MobileUI.

Original project: [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) © Siteboon and contributors.
