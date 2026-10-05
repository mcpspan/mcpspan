"""Instrumentation for the official MCP Python SDK, `mcp`, in both major versions.

v1 serves tools through `mcp.server.fastmcp.FastMCP`, v2 through
`mcp.server.mcpserver.MCPServer`. Both keep their tools in a `ToolManager`,
with the same four methods this relies on: `add_tool`, which returns the tool
it registered, `get_tool`, `list_tools`, and `call_tool`, which every
`tools/call` request goes through and which refuses unknown tools and invalid
arguments by raising.

The manager is private to the server (`_tool_manager`). Nothing public offers
the same view, and the server's own public `call_tool` cannot be wrapped
instead: v1 hands the protocol layer a reference to it while the server is
being built, before instrumentation could replace it. If a later version moves
the manager, instrument() finds nothing to wrap and leaves the server as it
was, which is the safe way for it to fail.
"""

from __future__ import annotations

import contextlib
import functools
import time
import weakref
from typing import Any

from ._call import CallState, cannot_ask, current_call
from ._client import client_from_request
from ._definition import note_listing
from ._marks import is_excluded, is_marked
from ._primitives import instrument_primitives
from ._repeats import continues_earlier_call, note_arguments
from ._session import session_for
from ._track import (
    is_recording,
    now_iso,
    record_call,
    record_refused_call,
    server_version_of,
    track,
)

_REQUIRED = ("add_tool", "call_tool", "get_tool", "list_tools")

_instrumented: weakref.WeakSet[Any] = weakref.WeakSet()


def instrument_official(server: Any) -> bool:
    """Wraps the server's tool manager. False if it has none we know."""
    manager = getattr(server, "_tool_manager", None)
    if manager is None or not all(callable(getattr(manager, name, None)) for name in _REQUIRED):
        return False

    if manager in _instrumented:
        return True
    _instrumented.add(manager)

    # Tools registered before instrument() ran. In Python the usual shape is
    # decorators at module level and instrument() wherever the server starts,
    # so these are most of them.
    for tool in manager.list_tools():
        _wrap_tool(tool)

    _wrap_add_tool(manager)
    _wrap_call_tool(server, manager)
    _watch_listings(server)
    instrument_primitives(server)

    return True


def _watch_listings(server: Any) -> None:
    """Notes the tools each `tools/list` answer describes (contract, 3.8).

    v2 lists through the server's own `list_tools`, looked up on every
    request, so wrapping it on the instance is enough. v1 binds that method
    into the protocol handler when the server is built, so there the handler
    for ListToolsRequest is wrapped instead. Both together are harmless: the
    same listing noted twice is the same fingerprints.
    """
    with contextlib.suppress(Exception):
        list_tools = server.list_tools

        @functools.wraps(list_tools)
        async def listed(*args: Any, **kwargs: Any) -> Any:
            tools = await list_tools(*args, **kwargs)
            if is_recording():
                note_listing(tools)
            return tools

        server.list_tools = listed

    with contextlib.suppress(Exception):
        import mcp.types as types

        handlers = server._mcp_server.request_handlers
        request = getattr(types, "ListToolsRequest", None)
        handler = handlers.get(request) if request is not None else None
        if handler is None:
            return

        @functools.wraps(handler)
        async def handled(*args: Any, **kwargs: Any) -> Any:
            result = await handler(*args, **kwargs)
            if is_recording():
                answer = getattr(result, "root", result)
                note_listing(getattr(answer, "tools", None) or [])
            return result

        handlers[request] = handled


def _wrap_tool(tool: Any) -> None:
    """Swaps the function a registered tool runs for a tracked one.

    After registration, not before: by then the server has built the tool's
    schema, found its context parameter and decided whether it is async, all
    from the original function, and none of that is disturbed. Only what runs
    on each call changes.
    """
    try:
        fn = getattr(tool, "fn", None)
        name = getattr(tool, "name", None)
        if not callable(fn) or not isinstance(name, str) or is_marked(fn):
            return
        tool.fn = track(name, fn)
    except Exception:
        # A tool that cannot be wrapped runs unmeasured, and otherwise as before.
        pass


def _wrap_add_tool(manager: Any) -> None:
    original = manager.add_tool

    @functools.wraps(original)
    def add_tool(*args: Any, **kwargs: Any) -> Any:
        tool = original(*args, **kwargs)
        _wrap_tool(tool)
        return tool

    manager.add_tool = add_tool


def _request_context(context: Any) -> Any:
    """The protocol-level request context behind the server's `Context`, if any.

    Both versions raise when asked outside a request, as when a server's own
    code calls `call_tool` directly.
    """
    if context is None:
        return None
    try:
        return context.request_context
    except Exception:
        return None


def _begin(
    server: Any, args: tuple[Any, ...], kwargs: dict[str, Any]
) -> tuple[str, CallState, Any]:
    # call_tool(name, arguments, context, convert_result), in both versions.
    name = args[0] if args else kwargs.get("name")
    arguments = args[1] if len(args) > 1 else kwargs.get("arguments")
    context = args[2] if len(args) > 2 else kwargs.get("context")

    request_context = _request_context(context)

    call = CallState(
        session_id=session_for(server, request_context) if request_context is not None else None,
        client=client_from_request(request_context),
        arguments=arguments,
        server_version=server_version_of(server),
    )
    if (
        call.session_id is not None
        and isinstance(name, str)
        and not continues_earlier_call(context)
    ):
        call.repeated = note_arguments(call.session_id, name, arguments)

    return str(name), call, request_context


def _wrap_call_tool(server: Any, manager: Any) -> None:
    original = manager.call_tool

    @functools.wraps(original)
    async def call_tool(*args: Any, **kwargs: Any) -> Any:
        if not is_recording():
            return await original(*args, **kwargs)

        try:
            name, call, request_context = _begin(server, args, kwargs)
        except Exception:
            return await original(*args, **kwargs)

        timestamp = now_iso()
        started = time.perf_counter()
        token = current_call.set(call)

        # Whatever the server answers or raises goes back unchanged. This
        # only looks at it on its way past.
        try:
            result = await original(*args, **kwargs)
        except Exception as error:
            _note_refusal(manager, name, call, error, timestamp, started)
            raise
        finally:
            current_call.reset(token)

        if call.interim:
            with contextlib.suppress(Exception):
                _note_undeliverable_interim(name, call, request_context, timestamp, started)

        return result

    manager.call_tool = call_tool


def _note_undeliverable_interim(
    name: str, call: CallState, request_context: Any, timestamp: str, started: float
) -> None:
    """Records a tool's request for input that the client will get as an error.

    The tracked function leaves an interim result uncounted, because the retry
    that follows is the call. Where the protocol cannot carry the question,
    no retry follows: the client sees an error, and that is what is recorded.
    """
    if not cannot_ask(request_context):
        return

    record_call(
        name,
        call,
        timestamp=timestamp,
        duration_ms=(time.perf_counter() - started) * 1000,
        success=False,
        errorSource="result",
    )


def _is_validation_error(error: BaseException | None) -> bool:
    """A pydantic ValidationError, recognised without importing pydantic."""
    return error is not None and any(
        cls.__name__ == "ValidationError" for cls in type(error).__mro__
    )


def _note_refusal(
    manager: Any,
    name: str,
    call: CallState,
    error: Exception,
    timestamp: str,
    started: float,
) -> None:
    """Records a call the server turned away before its tool ran.

    Whether the tool ran is observed directly: the tracked function marks the
    call as reached. What the refusal was is then decided by which tool it
    was and what the server raised. Anything that fits neither kind is left
    out rather than miscounted.
    """
    try:
        if call.reached:
            # The tool ran, and its own outcome is already recorded.
            return

        tool = manager.get_tool(name)

        if tool is not None and is_excluded(getattr(tool, "fn", None)):
            return

        if tool is None:
            source = "unknown_tool" if "unknown tool" in str(error).lower() else None
        else:
            source = "arguments" if _is_validation_error(error.__cause__) else None

        if source is None:
            return

        record_refused_call(
            tool_name=name,
            error_source=source,
            call=call,
            timestamp=timestamp,
            duration_ms=(time.perf_counter() - started) * 1000,
        )
    except Exception:
        # Looking at a refusal must never change it.
        pass
