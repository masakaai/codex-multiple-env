<p align="center">
  <img width="100%" src="./docs/assets/masaka-banner.png" alt="Masaka routes one isolated Codex profile into the native Codex CLI">
</p>

<h1 align="center">Masaka · Codex Multiple Environments</h1>

<p align="center">
  Switch isolated ChatGPT account + workspace profiles for the native Codex CLI—without repeated logout/login.
</p>

<p align="center">
  English · <a href="./README.zh-CN.md">简体中文</a> · <a href="./README.ja.md">日本語</a> · <a href="./README.ko.md">한국어</a> · <a href="./README.de.md">Deutsch</a> · <a href="./README.fr.md">Français</a> · <a href="./README.es.md">Español</a> · <a href="./README.pt-BR.md">Português</a>
</p>

<p align="center">
  <img alt="Node.js 22+" src="https://img.shields.io/badge/Node.js-22%2B-292622?style=flat-square">
  <img alt="macOS and Linux" src="https://img.shields.io/badge/macOS%20%7C%20Linux-supported-e87532?style=flat-square">
  <img alt="Apache-2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-e87532?style=flat-square">
  <a href="https://github.com/masakaai/codex-multiple-env/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/masakaai/codex-multiple-env/actions/workflows/ci.yml/badge.svg"></a>
</p>

Masaka is a small standalone account manager. It does not replace the Codex UI
and it is not another agent CLI. Open `masaka` to add, inspect, renew, delete,
or select profiles; then run the native `codex` command normally.

Each profile represents exactly one `(ChatGPT account, ChatGPT workspace)` pair
and owns a separate `CODEX_HOME`. Codex continues to own the official browser
login, token refresh, and credential file.

## What it solves

- Keep Personal, Business, and Enterprise workspaces signed in at the same time.
- Keep multiple ChatGPT accounts isolated, even when they share a workspace name.
- Inspect every profile's authentication state, token activity, 5-hour/weekly
  quota windows, reset time, and available rate-limit reset cards.
- Select the identity used by the next native Codex process with `/use`.
- Renew one profile without logging out or invalidating the others.
- Prevent concurrent reauthentication while that profile is in use.

## Install

Requirements: macOS or Linux, Node.js 22+, Python 3, and the official
[Codex CLI](https://developers.openai.com/codex/cli/reference/).

```bash
npm install -g github:masakaai/codex-multiple-env
masaka doctor
```

Enable profile selection for ordinary `codex` commands:

```bash
echo 'eval "$(masaka shell-init)"' >> ~/.zshrc
eval "$(masaka shell-init)"
```

Use `~/.bashrc` instead of `~/.zshrc` for Bash. Masaka prints the integration;
it never edits your shell files automatically.

If you previously used a `codex` alias for default flags, move those flags into
an array before the integration line:

```bash
MASAKA_CODEX_DEFAULT_ARGS=(--search -m gpt-5.6-sol)
eval "$(masaka shell-init)"
```

## First run

```bash
masaka
```

```text
masaka
Type /help for commands.
masaka> /add
[official Codex browser login opens]
masaka> /profiles
1. Alice (alice@example.com) · Personal
2. Alice (alice@example.com) · Acme (Business) [default]
masaka> /use 1
Selected for new native Codex processes: Alice (alice@example.com) · Personal
masaka> /exit
```

Then start Codex exactly as usual:

```bash
codex
codex --search
codex exec "summarize this repository"
```

The shell function resolves the selected profile and then `exec`s the real
Codex binary. It rejects `codex login`, `codex logout`, and authentication
configuration overrides; use Masaka's `/add` and `/renew` flows instead.

## Commands

| Command | Result |
| --- | --- |
| `/status` | All profiles: login status, plan, token activity, 5-hour and other quota windows |
| `/usage` | Available reset-card count and returned card expiry details for all profiles |
| `/profiles` | Saved account, workspace, plan, and active-profile information |
| `/use NAME\|NUMBER` | Select the profile for newly started native Codex processes |
| `/add [NAME]` | Run official `codex login` in a new isolated profile; name is automatic by default |
| `/renew NAME\|NUMBER` | Re-run official login for the same identity after its sessions close |
| `/delete NAME\|NUMBER` | Require exact-name confirmation, then move the profile to Masaka's recoverable trash |
| `/exit` | Close only the Masaka manager |

Every slash command also has a terminal form, such as `masaka status` or
`masaka use 2`.

## Status and reset cards

Masaka uses the official Codex App Server's read-only account methods:
`account/read`, `account/rateLimits/read`, and `account/usage/read`. The status
view labels a 300-minute window as `5h`, calculates remaining percentage from
the returned usage percentage, and displays the server's reset timestamp.

`/usage` reports the server's authoritative `availableCount`. Card detail rows
can be capped or absent, so the count can be larger than the number of displayed
rows. See the official [Codex App Server account endpoints](https://developers.openai.com/codex/app-server/#auth-endpoints).

## Switching model—and the hot-switch boundary

`/use` changes the default for future Codex processes. It does **not** change
the identity of an already-running Codex process or move a conversation between
workspace governance boundaries.

This is intentional. A running Codex process caches an authentication manager,
the active account, and workspace policy. Replacing `auth.json`, swapping a
symlink, or injecting a different token can race token refresh and produce:

```text
Your access token could not be refreshed because you have since logged out
or signed in to another account.
```

There is no supported external command that safely converts an existing native
Codex TUI to another account in place. The reliable workflow is `/use`, then
start a new `codex`; existing sessions continue under their original profiles.
No logout is required.

## Credential and process safety

- One profile, one account/workspace identity, one `CODEX_HOME`.
- The global `~/.codex/auth.json` is never copied, linked, or replaced.
- Ambient API/access-token variables and auth endpoint overrides are removed
  before the native Codex process starts.
- Profile credentials must be regular files—not symlinks or hard links.
- Multiple native Codex sessions may share one profile; renewal and deletion
  require an exclusive profile lock and fail while a managed session is active.
- Profile directories are mode `0700`; metadata and credential files are mode
  `0600` where the platform supports POSIX permissions.
- Masaka stores only display metadata in `~/.config/cx/cx-state.json`; secrets
  remain in Codex-owned profile homes under `~/.codex-workspaces/profiles/`.

By explicit design, Masaka does not add another encryption layer. With
`cli_auth_credentials_store="file"`, Codex stores credentials in `auth.json`
under the profile's `CODEX_HOME`. Treat those files as passwords. OpenAI's
[authentication documentation](https://developers.openai.com/codex/auth/#credential-storage)
describes the supported file, keyring, automatic, and ephemeral stores.

## Architecture

```text
masaka (standalone manager)
  ├─ /add, /renew ───────> official `codex login`
  ├─ /status, /usage ────> official `codex app-server` read APIs
  └─ /use ───────────────> selected profile marker

ordinary `codex` shell function
  └─ profile launcher ───> native Codex with isolated CODEX_HOME
```

Masaka never proxies prompts, tool calls, or conversation content.

## Development

```bash
git clone https://github.com/masakaai/codex-multiple-env.git
cd codex-multiple-env
npm ci
npm run check
npm run bootstrap
```

CI runs the Node and Python checks on macOS and Linux. No test fixture contains
real credentials.

## Scope and trademark note

This is an independent open-source project by MASAKA AI. It is not an official
OpenAI product and is not endorsed by OpenAI. “OpenAI”, “ChatGPT”, and “Codex”
are used only to identify compatibility with their respective products.

Apache-2.0 licensed. Security reports: [SECURITY.md](./SECURITY.md).
