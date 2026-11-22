# Changelog

All notable changes to Switchboard. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- `switchboard` on its own starts in the background and opens your inbox.
- `switchboard connect` / `disconnect` wire up every supported agent on the computer at once (or the ones you name).
- `switchboard doctor` checks Node, the daemon, notifications, agents, phone and reply tools, with a fix for each problem. The same checks are in Settings → This computer.
- **Start with your computer** (`switchboard autostart on`): a Startup-folder script on Windows, a LaunchAgent on macOS, an XDG autostart entry on Linux.
- First-run checklist: one-click **Connect all found**, and a fifth step for starting at login.
- The Connect page says when Claude Code or Codex replies need their CLI, with the install command.
- CI on Windows, macOS and Linux (Node 20, 22 and 24).
- SECURITY.md, CONTRIBUTING.md, issue templates, and a comparison with other approaches in the README.
- **Final outcome only.** A message can say which piece of work it belongs to (`work: {id, pass, continues, final, fallback}`). While the work has a pass running or queued, its updates wait in the inbox without pinging; when it finishes, only its newest message pings you. The check runs again at the moment of delivery, a stand-in "no report arrived" note is held when the work's own message exists, and work with no news for 6 hours counts as finished. Report a pass without a message with `POST /v1/work/:id`, `switchboard work`, or `client.work()`; `notify_human` takes the same fields. Messages without `work` route as before.
- An update can be only an attachment: with no `question`, its headline is made from the file names, and it's routed like any other message.

### Changed
- Claude Code permission prompts wait **60 seconds** for you by default (was 10 minutes), then Claude shows its own prompt. Change it in Settings → Delivery. The hook timeout written to Claude's settings is now only a ceiling, so changing the wait never needs a reconnect.
- Running from npx's temporary folder, Switchboard won't connect agents or set up autostart (they'd break when npm clears its cache) and tells you how to install it instead.

### Fixed
- With a custom home folder (tests, `SWITCHBOARD_AGENT_HOME`), the Claude Desktop integration used the real `%APPDATA%` on Windows.
- Replying to Claude Code or Codex on Windows no longer prints a Node deprecation warning.

## [0.1.0] - 2026-11-04

First public version: the router (status, ping budgets, credibility, deadlines and safe defaults, bundling, digests, natural breaks, snooze), the inbox, rules that learn, the Ask spec, the hash-chained ledger, one-click integrations for Claude Code, Codex, Cursor, Claude Desktop, OpenClaw, Hermes Agent and Muse Code, MCP (stdio and HTTP), the MCP proxy, agent keys, cloud agents through a tunnel, Telegram and ntfy, Windows notifications with answer buttons, calendar and activity sensing, the Now page, replies to agents, reviews and notes.
