# CloudCLI-Mobile

A downstream fork of [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) (CloudCLI) focused on **self-hosting on a home machine and using it from a phone** — over the LAN or a VPN, as a browser tab or an iOS/Android home-screen web app.

## Relationship to upstream

- This fork is **independent and not affiliated with** the upstream authors.
- We **only pull** from upstream to stay current. We never push, open pull requests, or file issues against the upstream repository on behalf of this fork.
- Every change here is kept as a separate, clearly marked commit on top of upstream (code comments are tagged `[local]`), so other platforms and authors can pick individual changes.
- License: unchanged from upstream (see [LICENSE](LICENSE)).

## Branches

| Branch | Content |
|---|---|
| `main` | upstream + this fork's changes. This is what we run. |
| `upstream-main` | an untouched mirror of upstream `main`, for diffing and syncing. |
| `fix/*`, `feat/*` | one change each, merged into `main` through a pull request. |

## Changes in this fork

| Change | What it does | Config |
|---|---|---|
| File viewer: extra read roots | The in-chat file viewer can open files outside `WORKSPACES_ROOT` (e.g. data on other drives). Read-only; writes stay limited to the project. | `CLOUDCLI_EXTRA_READ_ROOTS` — semicolon-separated directories |
| File tree: large projects | The entry cap is configurable and, when hit, the tree is returned truncated instead of failing. Cut-off folders are loaded on demand when expanded. | `CLOUDCLI_FILE_TREE_MAX_ENTRIES` (default 10000) |
| Claude model list | The model picker shows the list Claude Code itself reports (same as `/model` in the official client) instead of a hard-coded alias list. Cached 10 min; falls back to the built-in list. | — |
| Mobile scrolling | Smooth upward scrolling of long chats on touch devices (iOS Safari has no scroll anchoring for `content-visibility:auto`). | — |
| iOS home-screen app | Fixes the blank band at the bottom of the iOS standalone web app and tightens the header under the status bar. | — |

Changes still in review live in open pull requests.

## Install / run

Same requirements as upstream (Node.js 22+). Build from this repo and run it in place:

```bash
git clone https://github.com/Aztech-Lab/CloudCLI-Mobile.git
cd CloudCLI-Mobile
npm ci
npm run build
npm run server            # serves on SERVER_PORT (default 3001), HOST (default 0.0.0.0)
```

Or install upstream globally (`npm i -g @cloudcli-ai/cloudcli`) and copy this repo's `dist/` and `dist-server/` over the installed package. Do **not** run `cloudcli update` afterwards — it replaces the build with upstream's.

Security notes for phone access: CloudCLI serves plain HTTP and a logged-in user effectively has a shell on the host. Restrict the port to your LAN/VPN with a firewall, use a strong password, and prefer an encrypted VPN (IPsec/WireGuard/Tailscale) over PPTP or port forwarding.

## Syncing with upstream

```bash
git fetch upstream
git checkout upstream-main && git merge --ff-only upstream/main
git checkout main && git merge upstream-main   # resolve conflicts, run tests, build
```

## Contributing

Each change goes on its own branch off `main` and is merged through a pull request. See [docs/fork/SESSION-GUIDE.md](docs/fork/SESSION-GUIDE.md).
