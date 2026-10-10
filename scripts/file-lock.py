#!/usr/bin/env python3
"""Hold one POSIX advisory lock until the parent closes stdin."""

from __future__ import annotations

import errno
import os
from pathlib import Path
import sys
import time

try:
    import fcntl
except ImportError:  # pragma: no cover - Masaka supports macOS and Linux.
    fcntl = None


def main() -> int:
    if fcntl is None:
        print("POSIX advisory locks are unavailable on this platform", file=sys.stderr)
        return 69
    if len(sys.argv) != 3:
        print("usage: file-lock.py PATH TIMEOUT_MS", file=sys.stderr)
        return 64

    path = Path(sys.argv[1])
    timeout_ms = max(0, int(sys.argv[2]))
    deadline = time.monotonic() + timeout_ms / 1000
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        while True:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as exc:
                if exc.errno not in (errno.EACCES, errno.EAGAIN):
                    raise
                if time.monotonic() >= deadline:
                    return 75
                time.sleep(0.05)

        print("ready", flush=True)
        while sys.stdin.buffer.read(4096):
            pass
        return 0
    finally:
        os.close(descriptor)


if __name__ == "__main__":
    raise SystemExit(main())
