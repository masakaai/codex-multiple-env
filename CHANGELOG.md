# Changelog

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
