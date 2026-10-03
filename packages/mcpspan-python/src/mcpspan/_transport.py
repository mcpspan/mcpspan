from __future__ import annotations

import email.utils
import http.client
import json
import time
import urllib.error
import urllib.request
from collections.abc import Sequence

from ._types import ToolCallEvent
from ._version import SDK_VERSION

EVENTS_PATH = "/v1/events"
"""Path the ingest API accepts batches on, appended to the configured endpoint."""

DEFAULT_TIMEOUT = 10.0
"""How long a single delivery attempt may take, in seconds."""

MAX_RETRY_AFTER = 5 * 60.0
"""Longest `Retry-After` followed, in seconds.

A server asking for longer is either wrong or unwell, and a telemetry queue
that stops for a day on its word loses the day.
"""

USER_AGENT = f"mcpspan/{SDK_VERSION} (python)"


class TransportError(Exception):
    """A delivery attempt that did not succeed.

    `retryable` says whether sending the same batch again could plausibly
    work. A refused key or a malformed batch is refused identically every
    time, so repeating those only burns the developer's bandwidth.
    """

    def __init__(
        self,
        message: str,
        *,
        retryable: bool,
        status: int | None = None,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.status = status
        self.retry_after = retry_after


def build_events_url(endpoint: str) -> str:
    """Joins the endpoint with the events path, tolerating a trailing slash."""
    return endpoint.rstrip("/") + EVENTS_PATH


def _is_retryable(status: int) -> bool:
    """Statuses that describe a passing condition rather than the batch itself."""
    return status in (408, 429) or status >= 500


def parse_retry_after(header: str | None, now: float | None = None) -> float | None:
    """Reads `Retry-After` in either form, whole seconds or a date, in seconds.

    None when absent or unreadable, which leaves the SDK's own backoff to decide.
    """
    if header is None:
        return None

    value = header.strip()

    if value.isdigit():
        seconds = float(value)
    else:
        try:
            at = email.utils.parsedate_to_datetime(value)
        except (TypeError, ValueError):
            return None
        if at is None:
            return None
        seconds = at.timestamp() - (time.time() if now is None else now)

    return min(max(seconds, 0.0), MAX_RETRY_AFTER)


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    """Refuses to follow redirects.

    urllib would follow a redirect on a POST by turning it into a GET and
    dropping the body, which delivers nothing while looking like success. A
    redirect is surfaced as the answer it is instead.
    """

    def redirect_request(self, *args: object, **kwargs: object) -> None:
        return None


# Built once, and our own: an opener a developer installed globally for their
# own requests is not ours to use. Proxies from the environment still apply.
_opener = urllib.request.build_opener(_NoRedirects())


def send_events(
    events: Sequence[ToolCallEvent],
    *,
    endpoint: str,
    api_key: str,
    timeout: float = DEFAULT_TIMEOUT,
) -> None:
    """Delivers one batch to the ingest API.

    Raises TransportError on any outcome that is not an accepted batch. It
    neither retries nor swallows; that is for the caller to decide.
    """
    url = build_events_url(endpoint)
    body = json.dumps({"events": list(events)}, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            # The language in brackets, as the contract asks, so an
            # installation with servers in several can tell them apart.
            "User-Agent": USER_AGENT,
        },
    )

    try:
        with _opener.open(request, timeout=timeout) as response:
            response.read()
            status = response.status
    except urllib.error.HTTPError as error:
        status = error.code
        retry_after = parse_retry_after(error.headers.get("Retry-After") if error.headers else None)
        error.close()
        raise TransportError(
            f"Ingest API rejected the batch with {status}",
            status=status,
            retryable=_is_retryable(status),
            retry_after=retry_after,
        ) from None
    except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError) as error:
        # Unreachable host, DNS failure, reset connection, our own timeout.
        # All describe the moment rather than the batch, so all retry.
        raise TransportError(f"Failed to reach {url} ({error})", retryable=True) from None

    if not 200 <= status < 300:
        raise TransportError(
            f"Ingest API answered {status}", status=status, retryable=_is_retryable(status)
        )
