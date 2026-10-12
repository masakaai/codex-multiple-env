# Changelog

## 0.4.3 — 2026-10-12

- Keep native Codex Responses WebSockets enabled while Proxy mode uses the
  built-in `openai` provider and shared native session history.
- Retry requests that produced no upstream events on the next eligible account
  when their upstream WebSocket disconnects.
- Complete the WebSocket close handshake instead of resetting Codex sockets;
  partially streamed requests close with code 1011 rather than being replayed.
- Keep Masaka's loopback WebSocket route active when users pass Codex `-c` or
  `--config` overrides after a subcommand.

## 0.4.2 — 2026-10-11

- Fix native Codex TUI onboarding in Proxy mode by loading the fixed loopback
  credential from an isolated runtime home instead of relying on the
  non-interactive-only `CODEX_API_KEY` environment variable.
- Keep the built-in `openai` provider while sharing native `~/.codex` sessions,
  SQLite state, project trust, and resume history; global `auth.json` remains
  untouched.
- Preserve a custom native `CODEX_SQLITE_HOME`, and avoid linking mutable root
  state files that Codex replaces atomically.
- Preserve global `AGENTS.md` instructions and seed the native named-session
  index into the isolated runtime under a concurrency-safe initialization lock.

## 0.4.0 — 2026-10-11

- Add optional loopback Proxy mode with a per-user launchd daemon installed by
  `masaka onboarding`; direct mode remains available with `/proxy off`.
- Add hot account/workspace routing for already-running native Codex clients,
  without copying or replacing `~/.codex/auth.json`.
- Default `/auto true` to a sticky policy that keeps prompt-cache locality and
  switches at 5-hour remaining capacity of 5% or lower.
- Add automatic plan priority, remaining-capacity ordering, `/order`, and
  purchased Workspace Credits in `/status`.
- Pin and checksum the MIT-licensed CodexMulti proxy runtime used for HTTP/SSE,
  Responses WebSocket continuation, OAuth renewal, and confirmed-429 failover.

## 0.3.0 — 2026-10-11

- Introduce the standalone `masaka` slash-command manager.
- Add isolated account + workspace profiles backed by official Codex login.
- Add aggregate status, 5-hour/weekly quota windows, token activity, and reset-card reporting through Codex App Server.
- Add `/add`, `/renew`, `/delete`, `/profiles`, and `/use` workflows.
- Add native `codex` shell integration with per-profile process locks.
- Add English, Simplified Chinese, Japanese, Korean, German, French, Spanish, and Brazilian Portuguese documentation.
