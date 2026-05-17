"""Sentry init + JSON logging.

Both are no-ops in tests / dev unless explicitly enabled.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

from pythonjsonlogger import jsonlogger

from middleware import request_id_var, user_id_var

_SCRUB_KEYS = {"authorization", "cookie", "set-cookie"}


class ContextualJsonFormatter(jsonlogger.JsonFormatter):
    def add_fields(self, log_record, record, message_dict):
        super().add_fields(log_record, record, message_dict)
        log_record.setdefault("level", record.levelname)
        log_record.setdefault("logger", record.name)
        rid = request_id_var.get()
        uid = user_id_var.get()
        if rid:
            log_record["request_id"] = rid
        if uid:
            log_record["user_id"] = uid


def init_logging() -> None:
    """Replace root handlers with a JSON formatter."""
    level = os.getenv("LOG_LEVEL", "INFO").upper()
    handler = logging.StreamHandler()
    handler.setFormatter(
        ContextualJsonFormatter(
            "%(asctime)s %(levelname)s %(name)s %(message)s",
            json_ensure_ascii=False,
        )
    )
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)


def _scrub(event: dict, _hint: Optional[dict]) -> dict:
    """Sentry before_send hook: strip auth headers / cookies."""
    try:
        headers = event.get("request", {}).get("headers", {})
        for k in list(headers.keys()):
            if k.lower() in _SCRUB_KEYS:
                headers[k] = "[scrubbed]"
    except Exception:
        pass
    return event


def init_sentry(dsn: str, env: str) -> None:
    """No-op if DSN is empty (dev / tests)."""
    if not dsn:
        return
    import sentry_sdk
    from sentry_sdk.integrations.fastapi import FastApiIntegration
    from sentry_sdk.integrations.starlette import StarletteIntegration

    sentry_sdk.init(
        dsn=dsn,
        environment=env,
        traces_sample_rate=0.1,
        integrations=[StarletteIntegration(), FastApiIntegration()],
        before_send=_scrub,
        send_default_pii=False,
    )
