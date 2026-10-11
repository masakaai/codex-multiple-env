#!/usr/bin/env python3

import json
import os
import signal
import sys
import time

if os.environ.get("FAKE_CWS_STUBBORN") == "1":
    signal.signal(signal.SIGTERM, lambda *_: None)
    while True:
        time.sleep(1)

if "app-server" in sys.argv:
    event_log = os.environ.get("FAKE_CWS_EVENT_LOG")
    if event_log:
        with open(event_log, "a", encoding="utf-8") as stream:
            stream.write(f"{os.getpid()} {time.time_ns()}\n")
    start_delay_ms = int(os.environ.get("FAKE_CWS_START_DELAY_MS", "0"))
    if start_delay_ms:
        time.sleep(start_delay_ms / 1000)
    for line in sys.stdin:
        request = json.loads(line)
        request_id = request.get("id")
        if request_id is None:
            continue
        method = request.get("method")
        if method == "initialize":
            result = {"userAgent": "fake", "codexHome": "/fake"}
        elif method == "account/read":
            result = {
                "account": {"type": "chatgpt", "email": "alice@example.com", "planType": "business"},
                "requiresOpenaiAuth": True,
            }
        elif method == "account/rateLimits/read":
            result = {
                "rateLimits": {
                    "limitId": "codex",
                    "primary": {"usedPercent": 25, "windowDurationMins": 300, "resetsAt": 4102444800},
                    "secondary": {"usedPercent": 40, "windowDurationMins": 10080, "resetsAt": 4103049600},
                    "credits": {"hasCredits": True, "unlimited": False, "balance": "1234.6"},
                    "rateLimitReachedType": None,
                },
                "rateLimitResetCredits": {
                    "availableCount": 2,
                    "credits": [{
                        "id": "credit-1", "status": "available", "title": "Full reset", "expiresAt": 4102444800
                    }],
                },
            }
        elif method == "account/usage/read":
            result = {"summary": {"lifetimeTokens": 1234567, "currentStreakDays": 8}}
        else:
            print(json.dumps({"id": request_id, "error": {"message": "unknown method"}}), flush=True)
            continue
        print(json.dumps({"id": request_id, "result": result}), flush=True)
    raise SystemExit(0)

print(
    json.dumps(
        {
            "argv": sys.argv[1:],
            "pid": os.getpid(),
            "cws_home": os.environ.get("CWS_HOME"),
            "has_access_token": "CODEX_ACCESS_TOKEN" in os.environ,
            "has_openai_key": "OPENAI_API_KEY" in os.environ,
            "has_refresh_override": "CODEX_REFRESH_TOKEN_URL_OVERRIDE" in os.environ,
            "has_authapi_override": "CODEX_AUTHAPI_BASE_URL" in os.environ,
        }
    )
)
