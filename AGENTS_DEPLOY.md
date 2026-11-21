# AGENTS_DEPLOY.md — deployment instructions for agents

Audience: an AI agent (or a technical human) installing, configuring, updating or troubleshooting CloudCLI-MobileUI on a user's machine. Every step has a command and a check. Follow the steps in order, stop at every **ASK THE USER** marker, and report the final state using the template at the end.

## 0. Facts

| Item | Value |
|---|---|
| What it is | Self-hosted web UI for Claude Code (Node.js server + static web client) |
| Repository | `https://github.com/Aztech-Lab/CloudCLI-MobileUI` (branch `main`) |
| Runtime | Node.js >= 22, npm; git |
| Depends on | Claude Code CLI installed and logged in on the same machine, as the same OS user that runs the server |
| Build output | `dist/` (web client), `dist-server/` (server) |
| Start command | `npm run server` (= `node dist-server/server/index.js`) |
| Default address | `0.0.0.0:3001` (env `HOST`, `SERVER_PORT`) |
| Health check | `GET /health` → `{"status":"ok","version":"…","activeWork":{…}}` (no login needed) |
| Setup check | `GET /api/auth/status` → `{"needsSetup":true,…}` until the first account exists |
| User data | `~/.cloudcli/auth.db` (login database); Claude Code sessions are read from `~/.claude/` |
| Accounts | Exactly one. The first registration becomes the only account. |

## 1. Rules for the agent

1. Never expose the port to the internet (no router port forwarding, no tunnels) unless the user explicitly asks and accepts the risk: a logged-in user has shell-level access to the machine.
2. Do not create the login account yourself unless the user tells you to (see step 6).
3. Do not change firewall rules, services or autostart without the user's approval.
4. Run the server as the same OS user that is logged in to Claude Code.
5. Do not run `cloudcli update` against an install built from this repository; it replaces it with the upstream build.

## 2. Preconditions

Run and check each:

```bash
node -v          # must print v22.x or newer
npm -v
git --version
claude --version # Claude Code must be installed
```

- If `node` is older than 22: install Node.js 22 LTS or newer, then re-check.
- If `claude` is not found: install Claude Code (https://docs.anthropic.com/en/docs/claude-code). If it is installed somewhere not on `PATH`, note its full path for `CLAUDE_CLI_PATH` (step 4).
- Claude Code must be logged in for this OS user. If you cannot confirm that, **ASK THE USER** to run `claude` once in a terminal and complete the login.
- Native modules (`node-pty`, `better-sqlite3`) need prebuilt binaries or a C/C++ toolchain. On failure in step 3, see Troubleshooting.

## 3. Get and build

```bash
git clone https://github.com/Aztech-Lab/CloudCLI-MobileUI.git
cd CloudCLI-MobileUI
npm ci
npm run build
```

Check: `npm run build` exits 0, and both `dist/index.html` and `dist-server/server/index.js` exist.

## 4. Configure

All configuration is environment variables, set in the shell (or service definition) that starts the server. Only set what you need.

| Variable | Default | Set it when |
|---|---|---|
| `SERVER_PORT` | `3001` | the port is taken or the user wants another one |
| `HOST` | `0.0.0.0` | use `127.0.0.1` until the account exists (step 6), or permanently for this-machine-only use |
| `CLAUDE_CLI_PATH` | `claude` | `claude` is not on `PATH` for the server process (give the full path to the executable) |
| `DATABASE_PATH` | `~/.cloudcli/auth.db` | the login database should live elsewhere |
| `CLOUDCLI_EXTRA_READ_ROOTS` | none | the user wants the in-chat file viewer to open files outside their home folder. Read-only. Separator `;`. Example: `D:\Data;E:\Projects` |
| `CLOUDCLI_FILE_TREE_MAX_ENTRIES` | `10000` | very large projects; 30000 is a reasonable upper value for phones |
| `CLAUDE_TOOL_APPROVAL_TIMEOUT_MS` | `55000` | the user approves tools from the phone with delay; e.g. `86400000` (1 day). An unanswered approval is denied when it expires. Also used for Codex approvals on the `appserver` runtime (Codex questions wait at least 30 minutes) |
| `CLOUDCLI_BG_MAX_HOLD_MS` | `43200000` (12 hours) | background agents or commands (long builds, test runs) may stay silent longer than that. While a background task runs, the Claude process is kept for it until this much time passes without any output; then the tasks are stopped. Values under `1800000` (30 minutes) are ignored. A hold with nothing running still ends after 30 minutes of silence |
| `CLOUDCLI_CODEX_RUNTIME` | `exec` | the user wants to try the newer way of running Codex conversations: `appserver` sends each message as a turn to one long-lived `codex app-server` process shared by all Codex conversations, instead of one `codex exec` process per message. With it, a message sent while Codex works goes into the running turn (steer), and "Send now" stops the current step and sends it at once, as in the Codex app; with `exec` such messages wait until the turn ends. In the default permission mode, Codex's approval requests (commands, file changes, extra access) and its questions appear as cards in the chat instead of being declined, and in "Approve for me" the automatic reviewer's decisions show in the transcript with "Allow anyway" for a denial. Stop ends only the current turn: commands Codex left running in the background (dev servers, long jobs) keep running, are listed in the chat's background strip with their own stop and "Stop all background commands", and survive the next message; subagents get live cards. Idle conversations are released about 30 seconds after the last turn and the last background command or subagent ended, so the Codex desktop app can continue them; archiving or deleting a conversation stops its background commands. A phone that reconnects or a page that reloads catches up on the running turn and on the background commands and subagents; the "background command finished" / "agent finished" rows and the automatic review rows are kept in CloudCLI's database so they survive a reload; a conversation whose last send was refused because it is open in the Codex app says so at the top. Codex's background commands and subagents count in `/health` `activeWork`, and a restart that ends them leaves the same restart notice as Claude's background work. If the app-server cannot start, that message runs with `exec` and the server log says why. Restart the server after changing it |

Never set `VITE_IS_PLATFORM=true`: it disables authentication.

## 5. Start and verify

First start bound to this machine only, so nobody else can claim the account:

```bash
# macOS / Linux
HOST=127.0.0.1 npm run server
```
```powershell
# Windows PowerShell
$env:HOST = '127.0.0.1'; npm run server
```

In another shell:

```bash
curl -s http://127.0.0.1:3001/health            # expect "status":"ok"
curl -s http://127.0.0.1:3001/api/auth/status   # expect "needsSetup":true on a fresh install
```

If the port is in use, set `SERVER_PORT` and retry.

## 6. Create the account

Preferred: **ASK THE USER** to open `http://127.0.0.1:<port>` on this machine and create the account (username >= 3 characters, password >= 6; recommend a long password — there is no rate limit on logins).

Only if the user explicitly asks you to create it:

```bash
curl -s -X POST http://127.0.0.1:3001/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"<name>","password":"<password>"}'
```

Give the credentials to the user and do not keep them anywhere else. Check: `GET /api/auth/status` now returns `"needsSetup":false`.

<a id="security"></a>
## 7. Open it to the network (optional, security-relevant)

Only after step 6, and only with the user's approval:

1. Restart the server with `HOST=0.0.0.0` (or without `HOST`).
2. Restrict the port to the user's own networks with the OS firewall. **ASK THE USER** which subnets (home LAN, VPN pool). Examples:

```powershell
# Windows (admin): allow only these subnets on 3001, block the rest
New-NetFirewallRule -DisplayName "CloudCLI 3001 allow" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3001 -RemoteAddress 192.168.1.0/24
New-NetFirewallRule -DisplayName "CloudCLI 3001 block others" -Direction Inbound -Action Block -Protocol TCP -LocalPort 3001 -RemoteAddress 0.0.0.0-192.168.0.255,192.168.2.0-255.255.255.255
```
```bash
# Linux (ufw)
sudo ufw allow from 192.168.1.0/24 to any port 3001 proto tcp
sudo ufw deny 3001/tcp
```

On Windows, an existing "Node.js JavaScript Runtime" allow rule may open every port to every network; a Block rule overrides it, so the block rule above is what actually protects the port.

3. Check from another device on the allowed network: `http://<host-ip>:<port>/health` returns `"status":"ok"`.

For access from outside the home network use an encrypted VPN (IPsec, WireGuard, Tailscale). Do not use PPTP.

## 8. Keep it running (optional)

The server stops when its shell closes. Ask the user whether they want it to start automatically; do not add autostart on your own. Options: `pm2 start "npm run server" --name cloudcli` (cross-platform), a systemd user service (Linux), or a scheduled task at logon running as the user (Windows). Whatever you use must run as the user logged in to Claude Code.

## 9. Update

```bash
cd CloudCLI-MobileUI
git pull --ff-only
npm ci
npm run build
# then restart the server process
```

Check `/health` again; `version` reflects the upstream base version.

**Before restarting, check for running work.** A restart stops every Claude process the server started, and with them every turn being written and all background work (agents, workflows, backgrounded commands). It cannot be resumed. `GET /health` reports what a restart would end, as counts only:

```json
"activeWork": { "turns": 0, "backgroundSessions": 1, "backgroundTasks": 2 }
```

- `turns`: replies being written now (including a turn Claude started on its own to report finished background work).
- `backgroundSessions` / `backgroundTasks`: sessions whose turn has ended but whose background work still runs, and how many tasks they run in total. With `CLOUDCLI_CODEX_RUNTIME=appserver` this includes Codex's background commands and running subagents (they live in the shared `codex app-server` process, which a restart stops).

If any count is above 0, **ASK THE USER** before restarting, or wait and check again. A restart script can do the same check, for example:

```bash
curl -s http://127.0.0.1:3001/health | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const w=JSON.parse(s).activeWork||{};process.exit((w.turns||0)+(w.backgroundSessions||0)>0?1:0)})"
```

```powershell
$w = (Invoke-RestMethod http://127.0.0.1:3001/health).activeWork
if ($w.turns -gt 0 -or $w.backgroundSessions -gt 0) { Write-Warning "Work is running: $($w | ConvertTo-Json -Compress)"; exit 1 }
```

The field is absent on builds that predate it. When a restart does end background work, each affected session shows one notice in its history ("Background work was stopped by a server restart") at the point of the restart. The server keeps the list of sessions with background work in its database for this, updated every 2 seconds, so work started in the last 2 seconds before a hard kill may go unmentioned.

## 10. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `npm ci` fails building `node-pty` or `better-sqlite3` | No prebuilt binary for this Node/OS. Install build tools (Windows: Visual Studio Build Tools with "Desktop development with C++"; Linux: `build-essential python3`; macOS: `xcode-select --install`) and rerun `npm ci`. |
| `EADDRINUSE` on start | Port taken: choose another `SERVER_PORT`. |
| Chat says Claude Code is not installed | The server process cannot find `claude`: set `CLAUDE_CLI_PATH` to the full path. |
| Claude replies fail with authentication errors | Claude Code is not logged in for the OS user running the server. |
| Phone cannot connect, `127.0.0.1` works | Server bound to `127.0.0.1`, or the firewall blocks the phone's subnet. |
| "Unable to display this file" for a file the agent mentions | File is outside the home folder and the project: add its folder to `CLOUDCLI_EXTRA_READ_ROOTS`, restart. |
| A folder in the file tree looks empty | It is loaded on expand; if it never fills, check the server log. Raise `CLOUDCLI_FILE_TREE_MAX_ENTRIES` for very large projects. |
| Tool approvals are denied while the user is away | Raise `CLAUDE_TOOL_APPROVAL_TIMEOUT_MS`, or allow the needed tools in the tool settings. |
| Forgot the password | Stop the server, move `~/.cloudcli/auth.db` away (this removes the account), start again and register anew. |

## 11. Uninstall

Stop the server, remove any service/autostart and firewall rules you created, delete the `CloudCLI-MobileUI` folder, and optionally `~/.cloudcli/`. Claude Code and its sessions in `~/.claude/` are not affected.

## 12. Report back to the user

```
CloudCLI-MobileUI deployed
- Version (from /health):
- URL(s): http://<ip>:<port>
- Bound to: 127.0.0.1 | 0.0.0.0
- Account: created by user | created by agent (credentials handed over) | pending
- Firewall: rules added (subnets: …) | not changed
- Environment set: …
- Autostart: none | pm2 | service | task
- Open issues:
```
