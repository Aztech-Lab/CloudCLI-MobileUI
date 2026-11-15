# Contributing to CloudCLI-MobileUI

Thank you for helping. CloudCLI-MobileUI is a self-hosted web interface for Claude Code, made for phones and built on [CloudCLI](https://github.com/siteboon/claudecodeui). Help of any size is welcome: bug reports, testing on your own phone, translations, skins, documentation and code.

**Please open issues and pull requests in this repository** ([Aztech-Lab/CloudCLI-MobileUI](https://github.com/Aztech-Lab/CloudCLI-MobileUI)), not in the original CloudCLI repository. This is an independent project, and the CloudCLI authors should not receive reports about our changes.

## Ways to help

- **Report a bug.** [Open an issue](https://github.com/Aztech-Lab/CloudCLI-MobileUI/issues/new/choose) and say which phone and browser you used, and whether you opened the page in the browser or from the home screen.
- **Test on a real phone**, especially Android phones and tablets. Most testing so far has been on iPhones.
- **Translate.** Missing strings are in `src/modules/i18n/locales/<language>/*.json`; English (`en`) is the reference.
- **Design a skin.** [docs/fork/THEMING.md](docs/fork/THEMING.md) explains the design tokens a skin can set.
- **Fix or build something** from the [Help wanted](README.md#help-wanted) list or the open issues.

For a bigger change, please open an issue first so that we can agree on the approach before you spend time on it.

## Setting up

You need [Node.js](https://nodejs.org) 22 or newer and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and logged in. Fork the repository on GitHub, then:

```bash
git clone https://github.com/<you>/CloudCLI-MobileUI.git
cd CloudCLI-MobileUI
npm install
npm run dev        # server and interface together, in development mode
```

`npm run server` and `npm run client` start one side only, and `npm run build` makes a production build.

## Making a change

- **One change per pull request**, on its own branch from `main` (`fix/<name>` or `feat/<name>`). Everything your change is not about should keep working as before.
- **Mark edits to the original CloudCLI code** with a short `[local]` comment, so that others can find and reuse individual changes.
- **Add or update tests** that fail without your change.
- **Leave `README.md` alone.** The maintainer writes the "What's new" entry when merging. Put a one-line, user-facing summary in your pull request instead.
- **Keep personal details out**: no IP addresses, local paths, credentials, `.env` files or databases.

Before you open the pull request, run:

```bash
npm run typecheck                 # TypeScript, interface and server
npx oxlint <changed files>        # the pre-commit hook runs this too
npx vitest run                    # interface tests; fast, and should stay green
npx tsx --tsconfig server/tsconfig.json --test <server test files for your area>
npm run build
```

The full server suite (`npm test`) can hang in some environments. Running the test files for the area you changed is fine; say which ones in the pull request.

## Commit messages

Commits follow [Conventional Commits](https://conventionalcommits.org/), checked by commitlint: `<type>(optional scope): <description>`, with a lowercase description in the imperative mood. For example:

```
fix(chat): keep the scroll position when the phone rotates
feat(skins): add a high-contrast skin
docs: explain the skin tokens for buttons
```

Common types are `feat`, `fix`, `perf`, `refactor`, `docs`, `style`, `test` and `chore`.

## Pull requests

Open the pull request against `main` of this repository. The template asks what changed and why, which areas it touches, how you tested it, and whether the server needs a restart. Screenshots or a short screen recording help a lot for anything visible. A maintainer reviews and merges it and lists it under "What's new" in the README.

AI coding agents working on this repository should also follow [docs/fork/SESSION-GUIDE.md](docs/fork/SESSION-GUIDE.md).

## License

By contributing, you agree that your contributions are licensed under the [AGPL-3.0-or-later](LICENSE), including the additional terms in Section 7 of the LICENSE file.
