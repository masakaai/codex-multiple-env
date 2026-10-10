#!/usr/bin/env python3

import base64
import json
import os
from pathlib import Path
import sys
import time

if "login" in sys.argv and os.environ.get("FAKE_LOGIN_IDENTITY"):
    if os.environ.get("FAKE_LOGIN_DELAY"):
        time.sleep(float(os.environ["FAKE_LOGIN_DELAY"]))
    identity = json.loads(os.environ["FAKE_LOGIN_IDENTITY"])
    payload = {
        "sub": identity["user_id"],
        "email": identity["email"],
        "https://api.openai.com/auth": {"chatgpt_account_id": identity["workspace_id"]},
    }
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    auth = {"tokens": {"id_token": f"header.{encoded}.signature"}}
    Path(os.environ["CODEX_HOME"], "auth.json").write_text(json.dumps(auth))
    raise SystemExit(0)

print(json.dumps({
    "argv": sys.argv[1:],
    "codex_home": os.environ.get("CODEX_HOME"),
    "has_access_token": "CODEX_ACCESS_TOKEN" in os.environ,
    "has_openai_key": "OPENAI_API_KEY" in os.environ,
    "has_auth_override": "CODEX_AUTHAPI_BASE_URL" in os.environ,
}))
