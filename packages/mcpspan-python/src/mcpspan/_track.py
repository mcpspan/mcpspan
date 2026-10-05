from __future__ import annotations

import contextlib
import functools
import inspect
import time
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Any, TypeVar, overload

from ._call import CallState, current_call
from ._client import ClientInfo, client_name, detect_client
from ._failure import (
    MAX_NAME_LENGTH,
    describe_error_result,
    describe_exception,
    is_error_result,
    is_input_required,
    response_bytes,
    truncate,
)
from ._marks import is_marked, mark_excluded, mark_handler
from ._parameters import describe_parameters
from ._types import ToolCallEvent
from ._version import SDK_VERSION

F = TypeVar("F", bound=Callable[..., Any])

Sink = Callable[[ToolCallEvent], None]

_sink: Sink | None = None
_capture_parameter_names = False
_configured_server_version: str | None = None

MAX_VERSION_LENGTH = 100


def set_event_sink(sink: Sink | None) -> None:
    """Points recorded events somewhere, or nowhere.

    None turns collection off: wrapped functions then return through an early
    check, without a timestamp, an identifier or an event ever being built.
    That is the state of an unconfigured SDK, and it has to cost nothing.
    Internal; not part of the package's API.
    """
    global _sink
    _sink = sink


def set_capture_parameter_names(enabled: bool) -> None:
    global _capture_parameter_names
    _capture_parameter_names = enabled


def set_server_version(version: str | None) -> None:
    """Records every call under this version, whatever the server gives itself."""
    global _configured_server_version
    _configured_server_version = version


def server_version_of(server: Any) -> str | None:
    """The version an MCP server gives itself, as it was built, or None.

    v2 of the official SDK and FastMCP take a version when the server is
    built and say it on `version`. v1's FastMCP takes none: its handshake then
    names the `mcp` package's own version, which is not the server's, so only
    a version set on its protocol-level server counts.
    """
    try:
        for candidate in (
            getattr(server, "version", None),
            getattr(getattr(server, "_mcp_server", None), "version", None),
        ):
            if isinstance(candidate, (str, int, float)) and not isinstance(candidate, bool):
                text = str(candidate).strip()
                if text:
                    return text
    except Exception:
        pass
    return None


def is_recording() -> bool:
    return _sink is not None


def now_iso() -> str:
    """The current time as ISO 8601 in UTC, to the millisecond."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class _Measurement:
    """One call through a tracked function, from start to settling."""

    def __init__(self, sink: Sink, tool_name: str, args: tuple[Any, ...], kwargs: dict[str, Any]):
        self._sink = sink
        self._tool_name = tool_name
        # Read first, before the function can start anything else.
        self._call = current_call.get()
        if self._call is not None:
            self._call.reached = True
            self._call.interim = False
        self._arguments: Any = self._call.arguments if self._call is not None else kwargs
        self._timestamp = now_iso()
        # Monotonic, so a clock adjustment mid-call cannot distort a duration.
        self._started = time.perf_counter()
        self._recorded = False

    def settle(self, result: Any) -> None:
        # Looking at a result must never change what the tool returns. A
        # result object whose attributes raise, or warn, is the host's to have.
        with contextlib.suppress(Exception):
            self._settle(result)

    def fail(self, error: BaseException) -> None:
        # An exception whose __str__ raises is still re-raised unchanged.
        with contextlib.suppress(Exception):
            self._fail(error)

    def _settle(self, result: Any) -> None:
        if is_input_required(result):
            # An interim answer on the 2026-07-28 protocol, asking the client
            # for more. The retry that follows is the call that completes;
            # counting this one too would show one call as two.
            self._recorded = True
            if self._call is not None:
                self._call.interim = True
            return

        size = response_bytes(result)
        if not is_error_result(result):
            self._emit(success=True, size=size)
            return

        message = describe_error_result(result)
        self._emit(
            success=False,
            size=size,
            outcome={
                "errorSource": "result",
                **({"errorMessage": message} if message is not None else {}),
            },
        )

    def _fail(self, error: BaseException) -> None:
        error_type, message = describe_exception(error)
        self._emit(
            success=False,
            outcome={
                "errorSource": "exception",
                "errorType": error_type,
                **({"errorMessage": message} if message is not None else {}),
            },
        )

    def _emit(
        self, *, success: bool, size: int | None = None, outcome: dict[str, str] | None = None
    ) -> None:
        if self._recorded:
            return
        self._recorded = True

        try:
            client = self._call.client if self._call is not None else None
            session = self._call.session_id if self._call is not None else None
            event = _build_event(
                tool_name=self._tool_name,
                duration_ms=(time.perf_counter() - self._started) * 1000,
                success=success,
                client=client,
                session_id=session,
                arguments=self._arguments,
                timestamp=self._timestamp,
                server_version=self._call.server_version if self._call is not None else None,
            )
            event.update(outcome or {})  # type: ignore[typeddict-item]
            if size is not None:
                event["responseBytes"] = size
            self._sink(event)
        except Exception:
            # Recording a call must never disturb the call itself.
            pass


def _build_event(
    *,
    tool_name: str,
    duration_ms: float,
    success: bool,
    client: ClientInfo | None,
    session_id: str | None,
    arguments: Any,
    timestamp: str,
    server_version: str | None = None,
) -> ToolCallEvent:
    event: ToolCallEvent = {
        "id": str(uuid.uuid4()),
        "toolName": truncate(tool_name, MAX_NAME_LENGTH),
        "durationMs": duration_ms,
        "success": success,
        "clientType": detect_client(client),
        "timestamp": timestamp,
        "sdkVersion": SDK_VERSION,
    }

    name = client_name(client)
    if name is not None:
        event["clientName"] = name
    client_version = client.version.strip() if client is not None and client.version else ""
    if client_version:
        event["clientVersion"] = truncate(client_version, MAX_VERSION_LENGTH)
    version = _configured_server_version or server_version
    if version:
        event["serverVersion"] = truncate(version, MAX_VERSION_LENGTH)
    if session_id is not None:
        event["sessionId"] = session_id
    if _capture_parameter_names:
        parameters = describe_parameters(arguments)
        if parameters is not None:
            event["parameters"] = parameters

    return event


def _is_async(fn: Any) -> bool:
    while isinstance(fn, functools.partial):
        fn = fn.func

    # An object whose __call__ is a coroutine function, as well as a function.
    return inspect.iscoroutinefunction(fn) or inspect.iscoroutinefunction(type(fn).__call__)


async def _settle_later(measurement: _Measurement, awaitable: Awaitable[Any]) -> Any:
    try:
        result = await awaitable
    except Exception as error:
        measurement.fail(error)
        raise
    measurement.settle(result)
    return result


def _wrap(tool_name: str, handler: Callable[..., Any]) -> Callable[..., Any]:
    if _is_async(handler):

        @functools.wraps(handler)
        async def tracked_async(*args: Any, **kwargs: Any) -> Any:
            sink = _sink
            if sink is None:
                return await handler(*args, **kwargs)

            measurement = _Measurement(sink, tool_name, args, kwargs)
            try:
                result = await handler(*args, **kwargs)
            except Exception as error:
                measurement.fail(error)
                raise
            measurement.settle(result)
            return result

        return tracked_async

    @functools.wraps(handler)
    def tracked(*args: Any, **kwargs: Any) -> Any:
        sink = _sink
        if sink is None:
            return handler(*args, **kwargs)

        measurement = _Measurement(sink, tool_name, args, kwargs)
        try:
            result = handler(*args, **kwargs)
        except Exception as error:
            measurement.fail(error)
            raise

        if inspect.isawaitable(result):
            # A plain function handing back something to await: the call
            # lasts until that settles, since that is what the agent waits for.
            return _settle_later(measurement, result)

        measurement.settle(result)
        return result

    return tracked


@overload
def track(name: str) -> Callable[[F], F]: ...
@overload
def track(name: str, handler: F) -> F: ...
def track(name: str, handler: F | None = None) -> F | Callable[[F], F]:
    """Records every call to a tool function.

    The returned function keeps the original's signature, name and docstring,
    so an MCP server builds the same schema from it, and it returns and
    raises exactly what the original does. Used as a decorator or a call:

        @mcpspan.track("search_flights")
        def search_flights(destination: str) -> str: ...

    `instrument` does this for every tool on a server; `track` is for a tool
    registered in a way instrumentation does not see. A function tracked here
    and then registered on an instrumented server is counted once.

    A call is recorded when it settles: a success, a result marked `isError`,
    or a raised exception, which is re-raised unchanged. Arguments are never
    read, except for their names and types when that was turned on.
    """
    if handler is None:
        return lambda fn: track(name, fn)

    if is_marked(handler):
        return handler

    wrapped = _wrap(name, handler)
    mark_handler(wrapped)

    return wrapped


def exclude(handler: F) -> F:
    """Keeps a tool out of the numbers entirely.

        @mcp.tool()
        @mcpspan.exclude
        def health_check() -> str: ...

    For tools called by machinery rather than agents: a health check polled
    every few seconds would outnumber everything a person did, and drag the
    whole server's error rate and response time towards its own. Refused
    calls to it are left out too.

    Takes no tool name on purpose: a name repeated here could drift from the
    real one in a rename, and the exclusion would quietly stop applying. The
    function is returned exactly as given.
    """
    mark_excluded(handler)

    return handler


def record_call(
    tool_name: str,
    call: CallState,
    *,
    timestamp: str,
    duration_ms: float,
    success: bool,
    response: Any = None,
    **outcome: str,
) -> None:
    """Records a call measured outside a tracked function, with its outcome.

    For integrations that see a call whole from outside the tool, as
    FastMCP's middleware does. `outcome` holds the failure fields, in the
    event's own spelling. `response` is the answer, when there was one, to be
    measured (contract, 3.7).
    """
    sink = _sink
    if sink is None:
        return

    try:
        event = _build_event(
            tool_name=tool_name,
            duration_ms=duration_ms,
            success=success,
            client=call.client,
            session_id=call.session_id,
            arguments=call.arguments,
            timestamp=timestamp,
            server_version=call.server_version,
        )
        event.update(outcome)  # type: ignore[typeddict-item]
        size = response_bytes(response) if response is not None else None
        if size is not None:
            event["responseBytes"] = size
        sink(event)
    except Exception:
        # Recording a call must never disturb the answer the client gets.
        pass


def record_refused_call(
    *,
    tool_name: str,
    error_source: str,
    call: CallState,
    timestamp: str,
    duration_ms: float,
) -> None:
    """Records a call the server turned away before its tool ran.

    It carries no message: the text comes from a validation library, which
    can quote the offending value back. Names and types of what was sent are
    recorded instead, when asked for.
    """
    record_call(
        tool_name,
        call,
        timestamp=timestamp,
        duration_ms=duration_ms,
        success=False,
        errorSource=error_source,
    )
