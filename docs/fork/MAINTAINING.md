# Maintaining CloudCLI-MobileUI

For the maintainer who merges changes and imports upstream releases. Contributors only need [SESSION-GUIDE.md](SESSION-GUIDE.md); deployers only need [DEPLOY.md](../../DEPLOY.md).

## Branches

- `main` — this project. Its root commit imports upstream CloudCLI 1.37.8; every later commit is ours.
- `upstream-snapshots` — one code-only commit per imported upstream release. No upstream history is kept in this repository.
- `fix/*`, `feat/*` — one change each, merged into `main` through a pull request.

This project only pulls from [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui). It never pushes, opens pull requests, or files issues there.

## Importing an upstream release

```bash
git remote add upstream https://github.com/siteboon/claudecodeui.git   # once
git config merge.ours.driver true                                      # once: keeps our README on merges
git fetch upstream
git checkout upstream-snapshots
git read-tree -u --reset upstream/main     # replace the snapshot with the new upstream code
git commit -m "Import upstream CloudCLI <version>"
git push origin upstream-snapshots:upstream-snapshots
git checkout main
git merge upstream-snapshots               # 3-way merge against the previous snapshot
```

Resolve conflicts, run the tests and the build, then update the README's "What's new" and push `main`. Always push named branches; never push tags.

## Merging a pull request

1. Review the change and its PR description.
2. Merge it locally into `main` and run: typecheck (`npx tsc --noEmit -p tsconfig.json`, `-p server/tsconfig.json`), `npx vitest run`, the server tests for the touched area, and `npm run build`.
3. Add a plain-language line to "What's new" in `README.md` under today's date (move it out of "In testing" if it was listed there). Contributors do not edit the README; `.gitattributes` keeps `main`'s copy on merges.
4. Push `main`.

Every change is its own commit and is marked `[local]` in the code, so others can take individual pieces.
