"""Request-scoped context for logs + tracing.

Each request gets a stable request_id (from the X-Request-ID header
if the client provided one, otherwise a fresh UUID). Once auth resolves,
get_current_user sets user_id on the same context. Both are pulled by
the JSON log formatter and included in every record for the request.
"""

from __future__ import annotations

import time
import uuid
from contextvars import ContextVar
from typing import Optional

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

REQUEST_ID_HEADER = "X-Request-ID"

request_id_var: ContextVar[Optional[str]] = ContextVar("request_id", default=None)
user_id_var: ContextVar[Optional[str]] = ContextVar("user_id", default=None)


class RequestIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        rid = request.headers.get(REQUEST_ID_HEADER) or uuid.uuid4().hex
        rid_token = request_id_var.set(rid)
        uid_token = user_id_var.set(None)
        start = time.perf_counter()
        try:
            response: Response = await call_next(request)
        finally:
            request_id_var.reset(rid_token)
            user_id_var.reset(uid_token)
        response.headers[REQUEST_ID_HEADER] = rid
        response.headers["X-Response-Time-Ms"] = str(
            int((time.perf_counter() - start) * 1000)
        )
        return response
