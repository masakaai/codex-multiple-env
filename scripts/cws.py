#!/usr/bin/env python3
"""Small, profile-aware launcher for the native Codex CLI.

Credentials remain owned by Codex inside one CODEX_HOME per profile.  This
script never copies or prints tokens and never replaces ~/.codex/auth.json.
"""

from __future__ import annotations

import argparse
import base64
import errno
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from typing import Any
from urllib.parse import urlparse

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows is reported by doctor.
    fcntl = None


VERSION = "0.4.2"
PROFILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
META_FILE = ".cws-profile.json"
SESSION_LOCK = ".cws-session.lock"
PROXY_ROUTING_FILE = "masaka-proxy-routing.json"
PROXY_CLIENT_DIR = "proxy-client"
PROXY_RUNTIME_DIR = "proxy-runtime"
PROXY_CLIENT_KEY = "sk-masaka-loopback-proxy"
LEGACY_PROXY_PROVIDER_ID = "masaka-proxy"
LEGACY_PROXY_MIGRATION_MARKER = ".masaka-rollouts-imported-v1"
SENSITIVE_CONFIG_KEYS = {
    "cli_auth_credentials_store",
    "forced_chatgpt_workspace_id",
    "forced_login_method",
}
AUTH_MUTATING_COMMANDS = {"login", "logout"}
VALUE_OPTIONS = {
    "-c", "--config", "--enable", "--disable", "--remote",
    "--remote-auth-token-env", "-i", "--image", "-m", "--model",
    "--local-provider", "-p", "--profile", "-s", "--sandbox", "-C",
    "--cd", "--add-dir", "-a", "--ask-for-approval",
}
SHARED_ENTRIES = (
    "config.toml", "AGENTS.md", "AGENTS.override.md", "skills", "plugins",
    "rules", "hooks", "prompts", "themes", "pets",
)
PROXY_SHARED_DIRECTORIES = (
    "sessions",
    "archived_sessions",
    "thread-writer-locks",
    "shell_snapshots",
    "attachments",
    "generated_images",
    "memories",
)
LEGACY_PROXY_SHARED_FILES = ("history.jsonl", "session_index.jsonl", "installation_id")


class CwsError(Exception):
    pass


class RenewalInterrupted(BaseException):
    def __init__(self, signum: int):
        super().__init__(f"renewal interrupted by signal {signum}")
        self.signum = signum


def state_root() -> Path:
    value = os.environ.get("CWS_HOME")
    return (Path(value).expanduser() if value else Path.home() / ".codex-workspaces").resolve()


def base_codex_home() -> Path:
    value = os.environ.get("CWS_BASE_CODEX_HOME")
    return (Path(value).expanduser() if value else Path.home() / ".codex").resolve()


def validate_name(name: str) -> str:
    if not PROFILE_RE.fullmatch(name):
        raise CwsError("invalid internal profile name")
    return name


def profile_home(name: str) -> Path:
    return state_root() / "profiles" / validate_name(name)


def private_directory(path: Path) -> None:
    if path.is_symlink():
        raise CwsError(f"private directory must not be a symlink: {path}")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)


def atomic_write(path: Path, text: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def metadata_for(home: Path) -> dict[str, Any]:
    path = home / META_FILE
    if home.is_symlink() or path.is_symlink() or not path.is_file():
        raise CwsError(f"profile is missing or unsafe: {home.name}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CwsError(f"cannot read profile metadata: {home.name}") from exc
    if value.get("name") != home.name:
        raise CwsError(f"profile metadata mismatch: {home.name}")
    for credential in ("auth.json", ".credentials.json"):
        credential_path = home / credential
        if credential_path.is_symlink():
            raise CwsError(f"credential storage must not be a symlink: {credential_path}")
        if credential_path.exists():
            info = credential_path.stat()
            if not credential_path.is_file() or info.st_nlink != 1:
                raise CwsError(f"credential storage must be one regular, unlinked file: {credential_path}")
            global_auth = base_codex_home() / credential
            if global_auth.exists() and not global_auth.is_symlink():
                global_info = global_auth.stat()
                if (info.st_dev, info.st_ino) == (global_info.st_dev, global_info.st_ino):
                    raise CwsError("profile credential must not alias the global Codex credential")
    return value


def load_profile(name: str) -> tuple[Path, dict[str, Any]]:
    home = profile_home(name)
    return home, metadata_for(home)


def share_common_entries(home: Path) -> None:
    base = base_codex_home()
    for entry in SHARED_ENTRIES:
        source = base / entry
        destination = home / entry
        if source.exists() and not destination.exists() and not destination.is_symlink():
            try:
                destination.symlink_to(source, target_is_directory=source.is_dir())
            except FileExistsError:
                # Another launcher initialized the same home first.
                pass


def link_native_state(source: Path, destination: Path, target_is_directory: bool) -> None:
    def points_to_source() -> bool:
        return destination.is_symlink() and destination.resolve() == source.resolve()

    if points_to_source():
        return
    if destination.exists() or destination.is_symlink():
        # A concurrent launcher may have created the correct link after the
        # first check and before this existence check.
        if points_to_source():
            return
        raise CwsError(f"proxy runtime state shadows native Codex state: {destination}")
    try:
        destination.symlink_to(source, target_is_directory=target_is_directory)
    except FileExistsError:
        # Multiple terminal windows may launch Codex at the same time.
        if not points_to_source():
            raise CwsError(f"proxy runtime state changed during launch: {destination}")


def prepare_proxy_runtime_files(home: Path, base: Path) -> None:
    """Seed native root state without retaining replaceable file symlinks.

    Codex atomically replaces files such as session_index.jsonl, which can
    replace a symlink instead of updating its target. A private copy preserves
    native prompt history, installation identity, and name-based resume while
    shared session directories and CODEX_SQLITE_HOME remain authoritative.
    """
    for entry in LEGACY_PROXY_SHARED_FILES:
        source = base / entry
        destination = home / entry
        if destination.is_symlink():
            try:
                points_to_source = destination.resolve() == source.resolve()
            except OSError:
                points_to_source = False
            if not points_to_source:
                raise CwsError(f"proxy runtime state shadows native Codex state: {destination}")
        elif destination.exists():
            if not destination.is_file():
                raise CwsError(f"proxy runtime state must be a regular file: {destination}")
            continue
        if source.is_file():
            try:
                contents = source.read_text(encoding="utf-8")
            except OSError as exc:
                raise CwsError(f"cannot seed native Codex state: {source}") from exc
            # os.replace inside atomic_write replaces an old symlink itself,
            # never the native file it used to target.
            atomic_write(destination, contents)
        elif destination.is_symlink():
            try:
                destination.unlink()
            except FileNotFoundError:
                pass


def proxy_runtime_home() -> Path:
    """Create the thin API-key home while keeping native Codex state shared."""
    home = state_root() / PROXY_RUNTIME_DIR
    private_directory(home)
    if fcntl is None:
        raise CwsError("proxy runtime initialization requires macOS or Linux")
    descriptor = os.open(home / ".masaka-runtime-init.lock", os.O_RDWR | os.O_CREAT, 0o600)
    try:
        # Initialization is short, but serialization prevents one new Codex
        # process from writing state while another launcher is still seeding it.
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        share_common_entries(home)
        base = base_codex_home()
        private_directory(base)
        prepare_proxy_runtime_files(home, base)
        for entry in PROXY_SHARED_DIRECTORIES:
            source = base / entry
            source.mkdir(parents=True, exist_ok=True, mode=0o700)
            destination = home / entry
            link_native_state(source, destination, target_is_directory=True)
        auth_path = home / "auth.json"
        if auth_path.is_symlink():
            raise CwsError("proxy client auth storage must not be a symlink")
        auth = {
            # Codex AuthMode serde spelling is `apikey` (not `api_key`). Keeping
            # this in the dedicated proxy home prevents the TUI from falling back
            # to ChatGPT onboarding or touching a real Profile credential.
            "auth_mode": "apikey",
            "OPENAI_API_KEY": PROXY_CLIENT_KEY,
        }
        atomic_write(auth_path, json.dumps(auth, indent=2) + "\n")
    finally:
        os.close(descriptor)
    return home


def migrate_legacy_proxy_rollouts(legacy_home: Path, runtime_home: Path) -> None:
    """Import pre-0.4.1 Proxy rollouts without changing or deleting the originals."""
    if legacy_home == runtime_home:
        return
    marker = legacy_home / LEGACY_PROXY_MIGRATION_MARKER
    if marker.is_symlink() or (marker.exists() and not marker.is_file()):
        raise CwsError(f"legacy Proxy migration marker is unsafe: {marker}")
    if marker.is_file():
        return
    for directory in ("sessions", "archived_sessions"):
        source_root = legacy_home / directory
        if not source_root.is_dir() or source_root.is_symlink():
            continue
        for source in source_root.rglob("*.jsonl"):
            if source.is_symlink() or not source.is_file():
                continue
            relative = source.relative_to(source_root)
            destination = runtime_home / directory / relative
            if destination.exists() or destination.is_symlink():
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            descriptor, temporary = tempfile.mkstemp(
                dir=destination.parent,
                prefix=f".{destination.name}.masaka-import-",
            )
            try:
                os.fchmod(descriptor, 0o600)
                with source.open("r", encoding="utf-8") as reader, os.fdopen(
                    descriptor, "w", encoding="utf-8"
                ) as writer:
                    first = reader.readline()
                    try:
                        event = json.loads(first)
                        payload = event.get("payload") if event.get("type") == "session_meta" else None
                        if isinstance(payload, dict) and payload.get("model_provider") == LEGACY_PROXY_PROVIDER_ID:
                            payload["model_provider"] = "openai"
                            first = json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n"
                    except (AttributeError, json.JSONDecodeError):
                        pass
                    writer.write(first)
                    shutil.copyfileobj(reader, writer)
                try:
                    os.link(temporary, destination)
                except FileExistsError:
                    pass
            finally:
                try:
                    os.unlink(temporary)
                except FileNotFoundError:
                    pass
    atomic_write(marker, "completed\n")


def create_profile(args: argparse.Namespace) -> int:
    name = validate_name(args.name)
    private_directory(state_root())
    private_directory(state_root() / "profiles")
    home = profile_home(name)
    if home.exists() and not home.is_dir():
        raise CwsError(f"profile path is not a directory: {home}")
    if home.is_dir() and not (home / META_FILE).exists() and any(home.iterdir()):
        raise CwsError(f"refusing to adopt a non-empty profile directory: {home}")
    private_directory(home)
    path = home / META_FILE
    current: dict[str, Any] = {}
    if path.exists():
        current = metadata_for(home)
        old_workspace = current.get("workspace_id")
        if old_workspace and args.workspace_id and old_workspace != args.workspace_id:
            raise CwsError("a profile cannot be changed to a different workspace")
    value = {
        "format_version": 1,
        "name": name,
        "account_label": args.account or current.get("account_label"),
        "workspace_label": args.workspace or current.get("workspace_label"),
        "workspace_id": args.workspace_id or current.get("workspace_id"),
    }
    atomic_write(path, json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    share_common_entries(home)
    return 0


def codex_binary() -> str:
    configured = os.environ.get("CWS_CODEX_BIN")
    binary = configured or shutil.which("codex")
    if not binary:
        raise CwsError("cannot find Codex; install @openai/codex or set CWS_CODEX_BIN")
    return binary


def codex_environment(home: Path, proxy_enabled: bool = False) -> dict[str, str]:
    environment = os.environ.copy()
    native_sqlite_home = environment.get("CODEX_SQLITE_HOME")
    environment["CODEX_HOME"] = str(home)
    for key in (
        "CODEX_ACCESS_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_SQLITE_HOME",
        "CODEX_REFRESH_TOKEN_URL_OVERRIDE", "CODEX_REVOKE_TOKEN_URL_OVERRIDE",
        "CODEX_AUTHAPI_BASE_URL", "CODEX_APP_SERVER_LOGIN_CLIENT_ID",
    ):
        environment.pop(key, None)
    if proxy_enabled:
        # Auth stays in the thin runtime home, while every SQLite-backed state
        # database remains the same one native Codex uses. The loopback daemon
        # replaces the fixed placeholder before forwarding upstream.
        environment["CODEX_SQLITE_HOME"] = native_sqlite_home or str(base_codex_home())
    return environment


def acquire_lock(home: Path, exclusive: bool) -> int:
    if fcntl is None:
        raise CwsError("profile locking requires macOS or Linux")
    descriptor = os.open(home / SESSION_LOCK, os.O_RDWR | os.O_CREAT, 0o600)
    operation = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
    try:
        fcntl.flock(descriptor, operation | fcntl.LOCK_NB)
    except OSError as exc:
        os.close(descriptor)
        if exc.errno in (errno.EACCES, errno.EAGAIN):
            action = "change authentication" if exclusive else "start Codex"
            raise CwsError(f"cannot {action} while this profile is active") from exc
        raise
    os.set_inheritable(descriptor, True)
    return descriptor


def read_chatgpt_identity(auth_path: Path) -> dict[str, str]:
    try:
        auth = json.loads(auth_path.read_text(encoding="utf-8"))
        token = auth["tokens"]["id_token"]
        encoded = token.split(".")[1]
        payload = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
    except (OSError, KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise CwsError("renewed Codex login did not produce readable ChatGPT identity metadata") from exc
    claims = payload.get("https://api.openai.com/auth") or {}
    return {
        "user_id": str(payload.get("sub") or ""),
        "email": str(payload.get("email") or "").casefold(),
        "workspace_id": str(claims.get("chatgpt_account_id") or auth.get("tokens", {}).get("account_id") or ""),
    }


def validate_renewed_identity(auth_path: Path, args: argparse.Namespace) -> None:
    identity = read_chatgpt_identity(auth_path)
    if args.expected_user_id and identity["user_id"] != args.expected_user_id:
        raise CwsError("renewed login belongs to a different account; previous credential restored")
    if not args.expected_user_id and args.expected_email and identity["email"] != args.expected_email.casefold():
        raise CwsError("renewed login belongs to a different account; previous credential restored")
    if args.expected_workspace_id and identity["workspace_id"] != args.expected_workspace_id:
        raise CwsError("renewed login belongs to a different workspace; previous credential restored")


def proxy_base_url() -> str | None:
    if os.environ.get("MASAKA_BYPASS_PROXY") == "1":
        return None
    path = state_root() / PROXY_ROUTING_FILE
    try:
        if not path.exists():
            return None
        if path.is_symlink() or not path.is_file():
            raise CwsError("proxy routing state must be a regular file")
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CwsError("cannot read Masaka proxy routing state") from exc
    if value.get("version") != 1 or not isinstance(value.get("enabled"), bool):
        raise CwsError("invalid Masaka proxy routing state")
    if not value["enabled"]:
        return None
    base_url = value.get("baseUrl")
    if not isinstance(base_url, str):
        raise CwsError("invalid Masaka proxy base URL")
    parsed = urlparse(base_url)
    if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1"
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.path.rstrip("/") != "/backend-api/codex"
            or parsed.port is None):
        raise CwsError("Masaka proxy must use a loopback Codex endpoint")
    return base_url


def config_args(metadata: dict[str, Any], use_proxy: bool = True) -> tuple[list[str], bool]:
    base_url = proxy_base_url() if use_proxy else None
    login_method = "api" if base_url else "chatgpt"
    credential_store = "file"
    result = [
        "-c", f'cli_auth_credentials_store="{credential_store}"',
        "-c", f'forced_login_method="{login_method}"',
    ]
    workspace = metadata.get("workspace_id")
    if workspace:
        result += ["-c", f"forced_chatgpt_workspace_id={json.dumps(workspace)}"]
    if base_url:
        # Keep the built-in provider id so Codex's native resume picker does
        # not hide existing `openai` sessions. Only its supported base URL is
        # redirected to the local gateway.
        result += [
            "-c", 'model_provider="openai"',
            "-c", f"openai_base_url={json.dumps(base_url)}",
        ]
    return result, bool(base_url)


def command_for(metadata: dict[str, Any], arguments: list[str], use_proxy: bool = True) -> tuple[list[str], bool]:
    config, proxy_enabled = config_args(metadata, use_proxy)
    return [codex_binary(), *config, *arguments], proxy_enabled


def normalize_remainder(arguments: list[str]) -> list[str]:
    return arguments[1:] if arguments and arguments[0] == "--" else arguments


def forwarded_subcommand(arguments: list[str]) -> str | None:
    index = 0
    while index < len(arguments):
        item = arguments[index]
        if item == "--":
            return None
        if item in VALUE_OPTIONS:
            index += 2
            continue
        if item.startswith("-"):
            index += 1
            continue
        return item
    return None


def reject_config_override(value: str) -> None:
    key = value.split("=", 1)[0].strip().strip("'\"")
    if key in SENSITIVE_CONFIG_KEYS:
        raise CwsError(f"cannot override profile setting: {key}")


def validate_codex_arguments(arguments: list[str]) -> list[str]:
    arguments = normalize_remainder(arguments)
    if forwarded_subcommand(arguments) in AUTH_MUTATING_COMMANDS:
        raise CwsError("use masaka /renew for authentication changes")
    index = 0
    while index < len(arguments):
        item = arguments[index]
        if item in ("-c", "--config") and index + 1 < len(arguments):
            reject_config_override(arguments[index + 1])
            index += 2
            continue
        if item.startswith("--config="):
            reject_config_override(item.split("=", 1)[1])
        elif item.startswith("-c="):
            reject_config_override(item[3:])
        elif item.startswith("-c") and len(item) > 2:
            reject_config_override(item[2:])
        index += 1
    return arguments


def login(args: argparse.Namespace) -> int:
    home, metadata = load_profile(args.name)
    lock = acquire_lock(home, True)
    auth_path = home / "auth.json"
    backup_path = home / f".auth.json.masaka-renew-{os.getpid()}"
    previous_sigterm = None

    def restore_previous() -> None:
        if auth_path.exists():
            auth_path.unlink()
        if backup_path.exists():
            os.replace(backup_path, auth_path)

    if args.reauth:
        previous_sigterm = signal.getsignal(signal.SIGTERM)

        def interrupt_renewal(signum: int, _frame: Any) -> None:
            raise RenewalInterrupted(signum)

        signal.signal(signal.SIGTERM, interrupt_renewal)

    try:
        if not args.reauth:
            status_command, _ = command_for(metadata, ["login", "status"], use_proxy=False)
            status = subprocess.run(
                status_command,
                env=codex_environment(home), capture_output=True, check=False,
                pass_fds=(lock,),
            )
            if status.returncode == 0:
                raise CwsError("profile is already authenticated; use masaka /renew after closing its sessions")
        if args.reauth and auth_path.exists():
            if backup_path.exists():
                raise CwsError("stale renewal backup exists; inspect the profile before retrying")
            os.replace(auth_path, backup_path)
        arguments = ["login"]
        if args.device_auth:
            arguments.append("--device-auth")
        login_command, _ = command_for(metadata, arguments, use_proxy=False)
        result = subprocess.run(
            login_command, env=codex_environment(home),
            check=False, pass_fds=(lock,),
        )
        if result.returncode != 0:
            if args.reauth:
                restore_previous()
            return result.returncode
        if args.reauth:
            try:
                validate_renewed_identity(auth_path, args)
            except Exception:
                restore_previous()
                raise
            if backup_path.exists():
                backup_path.unlink()
        return 0
    except BaseException:
        if args.reauth and backup_path.exists():
            restore_previous()
        raise
    finally:
        if previous_sigterm is not None:
            signal.signal(signal.SIGTERM, previous_sigterm)
        os.close(lock)


def launch(name: str, arguments: list[str]) -> int:
    home, metadata = load_profile(name)
    forwarded = validate_codex_arguments(arguments)
    command, proxy_enabled = command_for(metadata, forwarded)
    legacy_proxy_home = state_root() / PROXY_CLIENT_DIR if proxy_enabled else None
    runtime_home = proxy_runtime_home() if proxy_enabled else home
    lock_home = runtime_home
    # Proxy mode keeps the built-in `openai` provider and the native Codex
    # session/state stores. Only its fixed loopback API-key credential lives in
    # the thin runtime home, so ~/.codex/auth.json is never read or replaced.
    if legacy_proxy_home is not None and legacy_proxy_home.is_dir():
        migrate_legacy_proxy_rollouts(legacy_proxy_home, base_codex_home())
    # In direct mode one process exclusively owns the refresh chain. Proxy
    # clients may share the dummy-key home because only the daemon owns OAuth.
    lock = acquire_lock(lock_home, not proxy_enabled)
    try:
        os.execvpe(command[0], command, codex_environment(runtime_home, proxy_enabled))
    finally:
        os.close(lock)
    return 127


def run_profile(args: argparse.Namespace) -> int:
    return launch(args.name, args.codex_args)


def default_path() -> Path:
    return state_root() / "default"


def set_default(args: argparse.Namespace) -> int:
    load_profile(args.name)
    atomic_write(default_path(), args.name + "\n")
    return 0


def read_default() -> str:
    path = default_path()
    if path.is_symlink() or not path.is_file():
        raise CwsError("no profile selected; open masaka and run /use")
    name = path.read_text(encoding="utf-8").strip()
    load_profile(name)
    return name


def auto(args: argparse.Namespace) -> int:
    return launch(read_default(), args.codex_args)


def remove_profile(args: argparse.Namespace) -> int:
    home, _ = load_profile(args.name)
    lock = acquire_lock(home, True)
    try:
        trash = state_root() / "trash"
        private_directory(trash)
        destination = trash / f"{home.name}-{time.strftime('%Y%m%d-%H%M%S')}"
        if destination.exists():
            destination = trash / f"{home.name}-{time.time_ns()}"
        home.rename(destination)
        try:
            if default_path().read_text(encoding="utf-8").strip() == args.name:
                default_path().unlink()
        except FileNotFoundError:
            pass
        print(str(destination))
        return 0
    finally:
        os.close(lock)


def shell_init(_: argparse.Namespace) -> int:
    python = shlex.quote(sys.executable)
    script = shlex.quote(str(Path(__file__).resolve()))
    profile_root = shlex.quote(str(state_root()))
    base_home = shlex.quote(str(base_codex_home()))
    binary = shlex.quote(str(Path(codex_binary()).resolve()))
    print("unalias codex 2>/dev/null || true")
    print(
        f"codex() {{ command env CWS_HOME={profile_root} "
        f"CWS_BASE_CODEX_HOME={base_home} CWS_CODEX_BIN={binary} "
        f"{python} {script} auto -- "
        '"${MASAKA_CODEX_DEFAULT_ARGS[@]}" "$@"; }'
    )
    return 0


def doctor(_: argparse.Namespace) -> int:
    if fcntl is None:
        raise CwsError("profile locking is unavailable on this platform")
    result = subprocess.run([codex_binary(), "--version"], capture_output=True, text=True, check=False)
    print((result.stdout or result.stderr).strip())
    print(f"profiles: {state_root() / 'profiles'}")
    return result.returncode


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="masaka-cws")
    parser.add_argument("--version", action="version", version=VERSION)
    commands = parser.add_subparsers(dest="command", required=True)

    add = commands.add_parser("add")
    add.add_argument("name")
    add.add_argument("--workspace-id")
    add.add_argument("--account")
    add.add_argument("--workspace")
    add.set_defaults(handler=create_profile)

    auth = commands.add_parser("login")
    auth.add_argument("name")
    auth.add_argument("--reauth", action="store_true")
    auth.add_argument("--device-auth", action="store_true")
    auth.add_argument("--expected-user-id")
    auth.add_argument("--expected-email")
    auth.add_argument("--expected-workspace-id")
    auth.set_defaults(handler=login)

    run = commands.add_parser("run")
    run.add_argument("name")
    run.add_argument("codex_args", nargs=argparse.REMAINDER)
    run.set_defaults(handler=run_profile)

    automatic = commands.add_parser("auto")
    automatic.add_argument("codex_args", nargs=argparse.REMAINDER)
    automatic.set_defaults(handler=auto)

    default = commands.add_parser("default")
    default.add_argument("name")
    default.set_defaults(handler=set_default)

    remove = commands.add_parser("remove")
    remove.add_argument("name")
    remove.set_defaults(handler=remove_profile)

    init = commands.add_parser("shell-init")
    init.set_defaults(handler=shell_init)

    check = commands.add_parser("doctor")
    check.set_defaults(handler=doctor)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    return int(args.handler(args) or 0)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CwsError as exc:
        print(f"masaka-cws: {exc}", file=sys.stderr)
        raise SystemExit(1)
    except RenewalInterrupted as exc:
        print("masaka-cws: renewal interrupted; previous credential restored", file=sys.stderr)
        raise SystemExit(128 + exc.signum)
    except KeyboardInterrupt:
        print("masaka-cws: renewal interrupted; previous credential restored", file=sys.stderr)
        raise SystemExit(130)
