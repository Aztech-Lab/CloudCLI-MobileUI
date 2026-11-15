# CloudCLI-MobileUI

Run Claude Code on your own computer, and keep working with it from your phone.

> Setting this up with an AI agent? Point it at **[DEPLOY.md](DEPLOY.md)** — it has the exact steps, checks and settings.

## What it is

CloudCLI-MobileUI is a web interface for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) that you host yourself. Claude Code keeps running on your workstation — with your files, your tools and your login — and you open the interface from any phone, tablet or laptop on your network. On an iPhone or Android phone you can add it to the home screen, and it behaves like an app.

You get the whole Claude Code session in your hand: the conversation, the files it is working on, git, and a terminal. You can read what the agent did while you were away, answer its questions, approve a tool, or start the next task.

## Why we built it

Long agent runs — a literature search, a test suite, a data-processing job — happen on a workstation, but the questions and decisions tend to come up when you are away from the desk. We wanted to keep working with the very same session from a phone, instead of waiting until we were back at the keyboard.

[CloudCLI](https://github.com/siteboon/claudecodeui) already provided a solid open-source web interface for Claude Code, and this project is built on its code. What we kept running into was the phone side of things: moving around on a small touch screen, scrolling long conversations, the iPhone home-screen app, very large projects, files that live outside the home folder, and background agents being stopped when we sent a new message. This project collects the changes that fix those.

It is an independent project and is not affiliated with the CloudCLI authors. If something goes wrong, please [open an issue here](https://github.com/Aztech-Lab/CloudCLI-MobileUI/issues) rather than upstream.

## What is different from CloudCLI

**Easier on a phone.** Swipe left and right anywhere on the screen to move between the chat, files, git and the terminal; swipe right from the chat to open the menu. Long conversations scroll smoothly, and the iPhone home-screen app now fills the whole screen. When you open the app, your most recent conversations are right there, one tap away.

**Built for longer work.** The model picker lists exactly the models your Claude Code account offers. Projects with tens of thousands of files still show their file tree, and folders load when you open them. Files the agent mentions can be opened even when they live on another drive, as long as you allow that folder.

**Your own look.** A skin setting changes how the whole interface looks. The first skin, OTSR, is a quiet lab-white (or near-black) design with a copper accent and square edges, and you can tune its details — such as the dotted background — to taste.

**Coming next.** Sending a new message while background agents are still working will no longer stop them: they keep going and report back when they are done, the same way the official Claude Code app behaves. This is being tested now ([#1](https://github.com/Aztech-Lab/CloudCLI-MobileUI/pull/1)).

## Getting started

You need a computer that stays on, with [Node.js](https://nodejs.org) 22 or newer and Claude Code installed and logged in. Then download this project, build it and start it — the commands are in [DEPLOY.md](DEPLOY.md), and they take a few minutes.

When it is running, open `http://<your-computer's-address>:3001` in a browser. The first person to open it creates the one and only account, so do that yourself straight away. On an iPhone, open the page in Safari, tap **Share**, then **Add to Home Screen**.

## Please keep it private

Whoever logs in can do anything on that computer that you can. Use the interface only on your own network or through a VPN, never expose it directly to the internet, choose a strong password, and in the tool settings allow only the tools you actually need. [DEPLOY.md](DEPLOY.md#security) explains how.

## What's new

**In testing**
- Background agents keep running when you send a new message ([#1](https://github.com/Aztech-Lab/CloudCLI-MobileUI/pull/1)).

**15 November 2026**
- Skins now have their own settings. For OTSR you can choose how strong the dotted background is, and switch the cut corners, monospaced labels and square status dots on or off. The dotted background is softer by default.

**14 November 2026**
- New skin setting, with the OTSR skin in light and dark.
- Behind the scenes, the interface was prepared for skins; nothing changed visually.
- The home screen shows your recent conversations and projects.
- Swipe between tabs anywhere on the screen; the terminal tab moved to the end.
- Long conversations no longer stutter when you scroll up on a phone.
- The iPhone home-screen app no longer leaves an empty strip at the bottom.
- The model picker shows the models your account actually has.
- Large projects and files outside the home folder can be browsed and opened.
- First release, based on CloudCLI 1.37.8.

## License and credits

CloudCLI-MobileUI is free software under the [GNU AGPL v3](LICENSE) or later. If you run a modified version for other people, the license asks you to share its source with them.

It is based on CloudCLI by Siteboon AI B.V. and its contributors (see [NOTICE](NOTICE)). The changes in this repository and their ongoing maintenance are by [Aztech Labs](https://github.com/Aztech-Lab). For contributors and maintainers: [docs/fork/SESSION-GUIDE.md](docs/fork/SESSION-GUIDE.md) and [docs/fork/MAINTAINING.md](docs/fork/MAINTAINING.md).
