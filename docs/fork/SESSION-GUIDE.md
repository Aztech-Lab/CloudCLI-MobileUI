# Fix-session guide

How a working session (human or AI agent) contributes one change to CloudCLI-Mobile. One session = one change = one branch = one pull request. An integrator reviews, merges into `main`, and deploys; fix sessions do not deploy.

## Hard rules

1. **Never interact with upstream** (`siteboon/claudecodeui`): no pushes, pull requests, issues, or comments. Fetching is fine. Always pass `--repo Aztech-Lab/CloudCLI-Mobile` to `gh`.
2. **Never work in the production checkout** or touch a running server. Use your own git worktree.
3. **Do not deploy.** If something is urgent enough that you deployed anyway, say so at the top of the PR.
4. Keep behavior unchanged for everything your change is not about. Mark changed upstream code with a short `[local]` comment.
5. Do not commit machine-specific things (IP addresses, local paths, credentials, `.env`, databases).
6. **Do not edit `README.md`.** It holds the changelog, which the integrator writes when merging; `.gitattributes` keeps the `main` version on merges, so README edits in a branch are silently dropped. Put everything the changelog needs in the PR description (a one-line user-facing summary helps).

## Steps

```bash
# from the main clone
git fetch origin
git worktree add ../cloudcli-<short-name> -b fix/<short-name> origin/main   # or feat/<name>
cd ../cloudcli-<short-name>
npm ci
```

1. Make the change. Add or update tests that fail without it.
2. Check:
   - `npx tsc --noEmit -p server/tsconfig.json` and `npx tsc --noEmit -p tsconfig.json`
   - `npx oxlint <changed files>`
   - Server tests for the area you touched: `npx tsx --tsconfig server/tsconfig.json --test --test-timeout=120000 <test files>`
   - Client tests: `npx vitest run` (the whole client suite is fast and should stay green)
   - `npm run build`
   - The full server suite can hang in some environments; run the files relevant to your change instead, and say which ones in the PR. If your shell inherits CloudCLI's environment (you are running inside CloudCLI), unset `CLOUDCLI_*`, `CLAUDE_TOOL_APPROVAL_TIMEOUT_MS`, `CLAUDE_CLI_PATH`, `HOST`, `SERVER_PORT`, `DATABASE_PATH` for test runs.
3. Commit (the pre-commit hook runs oxlint on staged files) and push your branch to `origin`.
4. Open the PR against `main` of this fork:
   ```bash
   gh pr create --repo Aztech-Lab/CloudCLI-Mobile --base main --head fix/<short-name>
   ```
   Fill in the template: it is the hand-off to the integrator.
5. Leave the worktree in place until the PR is merged; the integrator may ask for changes.
