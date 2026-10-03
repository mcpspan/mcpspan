from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, cast

import pytest

from mcpspan._transport import (
    MAX_RETRY_AFTER,
    TransportError,
    build_events_url,
    parse_retry_after,
    send_events,
)
from mcpspan._types import ToolCallEvent
from mcpspan._version import SDK_VERSION


class Ingest:
    """A local stand-in for the ingest API, answering as told."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.status = 202
        self.headers: dict[str, str] = {}
        ingest = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                body = self.rfile.read(int(self.headers.get("content-length", 0)))
                ingest.requests.append(
                    {"path": self.path, "headers": dict(self.headers), "body": json.loads(body)}
                )
                self.send_response(ingest.status)
                for name, value in ingest.headers.items():
                    self.send_header(name, value)
                if ingest.status in (301, 302, 307):
                    self.send_header("Location", "/elsewhere")
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *args: object) -> None:
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


@pytest.fixture
def ingest() -> Iterator[Ingest]:
    fake = Ingest()
    yield fake
    fake.server.shutdown()


EVENT = cast(ToolCallEvent, {"id": "1", "toolName": "ok"})


def test_posts_json_with_key_and_user_agent(ingest: Ingest) -> None:
    send_events([EVENT], endpoint=ingest.url + "/", api_key="k")

    [request] = ingest.requests
    assert request["path"] == "/v1/events"
    assert request["body"] == {"events": [EVENT]}
    assert request["headers"]["Authorization"] == "Bearer k"
    assert request["headers"]["Content-Type"] == "application/json"
    assert request["headers"]["User-Agent"] == f"mcpspan/{SDK_VERSION} (python)"


@pytest.mark.parametrize(
    ("status", "retryable"),
    [(408, True), (429, True), (500, True), (503, True), (400, False), (401, False), (413, False)],
)
def test_classifies_refusals(ingest: Ingest, status: int, retryable: bool) -> None:
    ingest.status = status
    with pytest.raises(TransportError) as raised:
        send_events([EVENT], endpoint=ingest.url, api_key="k")

    assert raised.value.status == status
    assert raised.value.retryable is retryable


def test_passes_retry_after_on(ingest: Ingest) -> None:
    ingest.status = 429
    ingest.headers = {"Retry-After": "7"}
    with pytest.raises(TransportError) as raised:
        send_events([EVENT], endpoint=ingest.url, api_key="k")

    assert raised.value.retry_after == 7


def test_does_not_follow_a_redirect(ingest: Ingest) -> None:
    ingest.status = 307
    with pytest.raises(TransportError) as raised:
        send_events([EVENT], endpoint=ingest.url, api_key="k")

    assert raised.value.status == 307
    assert len(ingest.requests) == 1


def test_an_unreachable_endpoint_is_retryable() -> None:
    with pytest.raises(TransportError) as raised:
        send_events([EVENT], endpoint="http://127.0.0.1:9", api_key="k", timeout=2)

    assert raised.value.retryable
    assert raised.value.status is None


def test_builds_the_url() -> None:
    assert build_events_url("https://a.b//") == "https://a.b/v1/events"


def test_reads_retry_after_in_both_forms() -> None:
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    later = format_datetime(now + timedelta(seconds=30), usegmt=True)

    assert parse_retry_after(None) is None
    assert parse_retry_after("12") == 12
    assert parse_retry_after(later, now=now.timestamp()) == pytest.approx(30)
    assert parse_retry_after("99999") == MAX_RETRY_AFTER
    assert parse_retry_after("soon") is None
