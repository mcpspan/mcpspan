"""Instrumentation for FastMCP (the `fastmcp` package), from version 4.

FastMCP has a public middleware API, and every `tools/call` passes through
it with the tool's name, the arguments as the client sent them, and the
request's context. mcpspan adds one middleware and touches nothing else.

What FastMCP raises tells a refusal from a failure. Its `call_tool` is
documented to raise `NotFoundError` for a tool it does not have or has
disabled, and `ValidationError` for arguments that fail validation, both
before the tool runs. A tool that fails is raised as a `ToolError` whose
cause is what the tool itself raised, and that cause is what is recorded.

`fastmcp` is imported only once a FastMCP server is handed to instrument(),
so the package stays free of it everywhere else.
"""

from __future__ import annotations

import contextlib
import time
import weakref
from typing import Any

from ._call import CallState, cannot_ask
from ._client import client_from_request
from ._definition import note_listing
from ._failure import (
    describe_error_result,
    describe_exception,
    is_error_result,
    is_input_required,
)
from ._marks import is_excluded
from ._primitives import scheme_of
from ._repeats import continues_earlier_call, note_arguments
from ._session import session_for
from ._track import is_recording, now_iso, record_call, server_version_of

_instrumented: weakref.WeakSet[Any] = weakref.WeakSet()


def is_fastmcp(server: Any) -> bool:
    return type(server).__module__.split(".")[0] == "fastmcp" and callable(
        getattr(server, "add_middleware", None)
    )


def instrument_fastmcp(server: Any) -> bool:
    """Adds mcpspan's middleware to a FastMCP server. False if it is not one."""
    if not is_fastmcp(server):
        return False

    if server in _instrumented:
        return True

    from fastmcp.server.middleware import Middleware

    class McpspanMiddleware(Middleware):  # type: ignore[misc, unused-ignore]
        async def on_call_tool(self, context: Any, call_next: Any) -> Any:
            if not is_recording():
                return await call_next(context)

            try:
                name, call, request_context = await _begin(server, context)
            except Exception:
                return await call_next(context)

            if name is None:
                return await call_next(context)

            timestamp = now_iso()
            started = time.perf_counter()

            try:
                result = await call_next(context)
            except Exception as error:
                with contextlib.suppress(Exception):
                    _record_failure(name, call, error, timestamp, started)
                raise

            # Whatever the look at the result finds, the result goes back as it was.
            with contextlib.suppress(Exception):
                _record_result(name, call, result, request_context, timestamp, started)
            return result

        async def on_read_resource(self, context: Any, call_next: Any) -> Any:
            return await _measure_primitive(server, context, call_next, "resource")

        async def on_get_prompt(self, context: Any, call_next: Any) -> Any:
            return await _measure_primitive(server, context, call_next, "prompt")

        async def on_list_tools(self, context: Any, call_next: Any) -> Any:
            tools = await call_next(context)
            if is_recording():
                note_listing(tools)
            return tools

    server.add_middleware(McpspanMiddleware())
    _instrumented.add(server)

    return True


async def _begin(server: Any, context: Any) -> tuple[str | None, CallState, Any]:
    message = context.message
    name = getattr(message, "name", None)
    arguments = getattr(message, "arguments", None)

    fastmcp_context = getattr(context, "fastmcp_context", None)
    try:
        request_context = fastmcp_context.request_context if fastmcp_context else None
    except Exception:
        request_context = None

    call = CallState(
        session_id=session_for(server, request_context) if request_context is not None else None,
        client=client_from_request(request_context),
        arguments=arguments,
        server_version=server_version_of(server),
    )

    if not isinstance(name, str) or await _is_excluded(server, name):
        return None, call, request_context

    if call.session_id is not None and not continues_earlier_call(message):
        call.repeated = note_arguments(call.session_id, name, arguments)

    return name, call, request_context


async def _resolve(server: Any, message: Any, kind: str) -> tuple[str, bool, Any, list[str]]:
    """What was asked for: the name to record, whether the server has it, the
    arguments or template variables, and any required argument left out.

    From FastMCP's public lookups, before the request runs: a fixed resource by
    its URI, a templated one by its template, an address with neither by its
    scheme alone (the rest came from the client), a prompt by its name.
    """
    if kind == "prompt":
        name = str(getattr(message, "name", ""))
        arguments = getattr(message, "arguments", None) or {}
        prompt = await server.get_prompt(name)
        if prompt is None:
            return name, False, arguments, []
        required = [
            a.name
            for a in (getattr(prompt, "arguments", None) or [])
            if getattr(a, "required", False)
        ]
        return name, True, arguments, [a for a in required if a not in arguments]

    uri = str(getattr(message, "uri", ""))
    if await server.get_resource(uri) is not None:
        return uri, True, None, []
    template = await server.get_resource_template(uri)
    if template is not None:
        return str(template.uri_template), True, template.matches(uri), []
    return scheme_of(uri), False, None, []


async def _measure_primitive(server: Any, context: Any, call_next: Any, kind: str) -> Any:
    """Measures a resource read or a prompt got (contract, 3.5)."""
    if not is_recording():
        return await call_next(context)

    timestamp = now_iso()
    started = time.perf_counter()
    try:
        name, exists, arguments, missing = await _resolve(server, context.message, kind)
        _, call, _ = await _begin(server, context)
        call.arguments = arguments
    except Exception:
        return await call_next(context)

    def record(response: Any = None, **outcome: str) -> None:
        record_call(
            name,
            call,
            timestamp=timestamp,
            duration_ms=_elapsed(started),
            success=not outcome,
            response=response,
            kind=kind,
            **outcome,
        )

    try:
        result = await call_next(context)
    except Exception as error:
        with contextlib.suppress(Exception):
            # FastMCP raises what the function raised as the cause of its own error.
            original = error.__cause__ or error
            if not exists:
                record(errorSource=f"unknown_{kind}")
            elif kind == "prompt" and (missing or _is_validation_error(original)):
                record(errorSource="arguments")
            else:
                error_type, message = describe_exception(original)
                record(
                    errorSource="exception",
                    errorType=error_type,
                    **({"errorMessage": message} if message else {}),
                )
        raise

    if not is_input_required(result):
        with contextlib.suppress(Exception):
            record(result)
    return result


def _is_validation_error(error: BaseException | None) -> bool:
    return error is not None and any(
        cls.__name__ == "ValidationError" for cls in type(error).__mro__
    )


async def _is_excluded(server: Any, name: str) -> bool:
    try:
        tool = await server.get_tool(name)
    except Exception:
        return False

    return tool is not None and is_excluded(getattr(tool, "fn", None))


def _elapsed(started: float) -> float:
    return (time.perf_counter() - started) * 1000


def _record_result(
    name: str, call: CallState, result: Any, request_context: Any, timestamp: str, started: float
) -> None:
    if is_input_required(result):
        # Asking the client for more; the retry that follows is the call.
        # Unless the protocol cannot carry the question: FastMCP then answers
        # the client with an error, no retry follows, and that is the call.
        if cannot_ask(request_context):
            record_call(
                name,
                call,
                timestamp=timestamp,
                duration_ms=_elapsed(started),
                success=False,
                errorSource="result",
            )
        return

    if not is_error_result(result):
        record_call(
            name,
            call,
            timestamp=timestamp,
            duration_ms=_elapsed(started),
            success=True,
            response=result,
        )
        return

    message = describe_error_result(result)
    record_call(
        name,
        call,
        timestamp=timestamp,
        duration_ms=_elapsed(started),
        success=False,
        response=result,
        errorSource="result",
        **({"errorMessage": message} if message is not None else {}),
    )


def _record_failure(
    name: str, call: CallState, error: Exception, timestamp: str, started: float
) -> None:
    kind = type(error).__name__
    from_fastmcp = type(error).__module__.split(".")[0] == "fastmcp"

    if from_fastmcp and kind == "NotFoundError":
        # No message: the tool name is already the event's own.
        record_call(
            name,
            call,
            timestamp=timestamp,
            duration_ms=_elapsed(started),
            success=False,
            errorSource="unknown_tool",
        )
        return

    if from_fastmcp and kind == "ValidationError":
        # No message: validation errors can quote the value that was sent.
        record_call(
            name,
            call,
            timestamp=timestamp,
            duration_ms=_elapsed(started),
            success=False,
            errorSource="arguments",
        )
        return

    # FastMCP reports a failing tool as a ToolError caused by what the tool
    # raised. A ToolError the tool raised on purpose has no cause, and is
    # recorded as itself.
    raised = error.__cause__ if from_fastmcp and error.__cause__ is not None else error
    error_type, message = describe_exception(raised)
    record_call(
        name,
        call,
        timestamp=timestamp,
        duration_ms=_elapsed(started),
        success=False,
        errorSource="exception",
        errorType=error_type,
        **({"errorMessage": message} if message is not None else {}),
    )
