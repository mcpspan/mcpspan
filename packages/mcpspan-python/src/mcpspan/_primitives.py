"""Resource reads and prompt gets (contract, 3.5), on the official MCP Python SDK.

Both major versions serve them the same way. `read_resource` asks the
resource manager for the resource (`get_resource(uri, context)`, which is
where a template's function runs) and then reads it (`resource.read()`,
where a fixed resource's function runs). `get_prompt` asks the prompt
manager for the prompt (`get_prompt(name)`) and renders it
(`prompt.render(arguments, context)`), which checks for missing arguments
before it calls the prompt's function.

The server hands those two methods to the protocol layer while it is being
built, in v1, so they cannot be wrapped on the server; the managers can, as
the tool manager is. They are private (`_resource_manager`,
`_prompt_manager`); if a version moves them, resources and prompts go
unrecorded and the server runs as it did.

What was asked for is named before anything runs, from the managers' own
records: a fixed resource by its URI, a templated one by its template, never
by the address the client sent, and an address with neither by its scheme
alone, since the rest of it came from the client.
"""

from __future__ import annotations

import contextlib
import functools
import inspect
import re
import time
import weakref
from contextvars import ContextVar
from typing import Any

from ._call import CallState
from ._client import client_from_request
from ._failure import describe_exception
from ._session import session_for
from ._track import is_recording, now_iso, record_call, server_version_of

_instrumented: weakref.WeakSet[Any] = weakref.WeakSet()

_SCHEME = re.compile(r"^([a-zA-Z][a-zA-Z0-9+.-]*):")


def scheme_of(uri: str) -> str:
    """The scheme of an address, which is all of an unknown one that may be kept: `db://`."""
    match = _SCHEME.match(uri)
    return f"{match.group(1)}://" if match else "unknown://"


class _Prompting:
    """What the prompt's own function saw of the get being measured."""

    def __init__(self) -> None:
        self.reached = False
        self.raised: BaseException | None = None


_prompting: ContextVar[_Prompting | None] = ContextVar("mcpspan_prompting", default=None)

# The request's context, as v2's server hands it to its own get_prompt; the
# prompt manager is given none, and v2 has no other way to reach it there.
_prompt_request: ContextVar[Any] = ContextVar("mcpspan_prompt_request", default=None)


def instrument_primitives(server: Any) -> None:
    """Wraps the server's resource and prompt managers, where it has them."""
    resources = getattr(server, "_resource_manager", None)
    if callable(getattr(resources, "get_resource", None)) and resources not in _instrumented:
        _instrumented.add(resources)
        _wrap_get_resource(server, resources)

    prompts = getattr(server, "_prompt_manager", None)
    if callable(getattr(prompts, "get_prompt", None)) and prompts not in _instrumented:
        _instrumented.add(prompts)
        _wrap_prompt_manager(server, prompts)
        _wrap_server_get_prompt(server)


def _call_state(server: Any, context: Any, arguments: Any) -> CallState:
    request_context = None
    if context is not None:
        try:
            request_context = context.request_context
        except Exception:
            request_context = None
    return CallState(
        session_id=session_for(server, request_context) if request_context is not None else None,
        client=client_from_request(request_context),
        arguments=arguments,
        server_version=server_version_of(server),
    )


def _current_context(server: Any) -> Any:
    """The request's context, where the prompt manager is not handed one."""
    handed = _prompt_request.get()
    if handed is not None:
        return handed
    try:
        return server.get_context()
    except Exception:
        return None


def _wrap_server_get_prompt(server: Any) -> None:
    """Notes the context v2's server passes to its own get_prompt.

    v2 calls `self.get_prompt(name, arguments, context)` from its request
    handler, so a wrapper on the server sees it. v1 handed the protocol layer
    its method while being built and never comes through here, which is fine:
    v1 finds the context through `get_context()` instead.
    """
    original = getattr(server, "get_prompt", None)
    if not callable(original):
        return

    @functools.wraps(original)
    async def get_prompt(*args: Any, **kwargs: Any) -> Any:
        context = args[2] if len(args) > 2 else kwargs.get("context")
        token = _prompt_request.set(context)
        try:
            return await original(*args, **kwargs)
        finally:
            _prompt_request.reset(token)

    with contextlib.suppress(Exception):
        server.get_prompt = get_prompt


def _record(
    kind: str,
    name: str,
    call: CallState,
    timestamp: str,
    started: float,
    response: Any = None,
    **outcome: str,
) -> None:
    record_call(
        name,
        call,
        timestamp=timestamp,
        duration_ms=(time.perf_counter() - started) * 1000,
        success=not outcome,
        response=response,
        kind=kind,
        **outcome,
    )


def _exception(error: BaseException) -> dict[str, str]:
    # The SDK wraps what the developer's function raised, with `from` (v2) or
    # without (v1, where Python keeps it as the context): either is what it was.
    original = error.__cause__ or error.__context__ or error
    error_type, message = describe_exception(original)
    return {"errorSource": "exception", "errorType": error_type} | (
        {"errorMessage": message} if message else {}
    )


def _is_interim(value: Any) -> bool:
    return type(value).__name__ == "InputRequiredResult"


def _resolve_resource(manager: Any, uri: str) -> tuple[str, bool, Any]:
    """The name to record, whether the server has it, and a template's variables."""
    fixed = getattr(manager, "_resources", {}) or {}
    if uri in fixed:
        return uri, True, None
    for template in (getattr(manager, "_templates", {}) or {}).values():
        try:
            variables = template.matches(uri)
        except Exception:
            variables = None
        if variables is not None:
            return str(template.uri_template), True, variables
    return scheme_of(uri), False, None


class _Measured:
    """A resource handed back to the server, measured when it is read."""

    def __init__(self, resource: Any, finish: Any) -> None:
        self._resource = resource
        self._finish = finish

    def __getattr__(self, name: str) -> Any:
        return getattr(self._resource, name)

    async def read(self) -> Any:
        try:
            content = await self._resource.read()
        except BaseException as error:
            self._finish(error)
            raise
        self._finish(None, content)
        return content


def _wrap_get_resource(server: Any, manager: Any) -> None:
    original = manager.get_resource

    @functools.wraps(original)
    async def get_resource(uri: Any, *args: Any, **kwargs: Any) -> Any:
        if not is_recording():
            return await original(uri, *args, **kwargs)

        timestamp = now_iso()
        started = time.perf_counter()
        try:
            name, exists, variables = _resolve_resource(manager, str(uri))
            context = args[0] if args else kwargs.get("context")
            call = _call_state(server, context, variables)
        except Exception:
            return await original(uri, *args, **kwargs)

        try:
            resource = await original(uri, *args, **kwargs)
        except BaseException as error:
            if isinstance(error, Exception):
                outcome = _exception(error) if exists else {"errorSource": "unknown_resource"}
                _record("resource", name, call, timestamp, started, **outcome)
            raise

        if resource is None or _is_interim(resource):
            return resource

        def finish(error: BaseException | None, content: Any = None) -> None:
            if error is None:
                _record("resource", name, call, timestamp, started, content)
            elif isinstance(error, Exception):
                _record("resource", name, call, timestamp, started, **_exception(error))

        return _Measured(resource, finish)

    manager.get_resource = get_resource


def _note_reached(fn: Any) -> Any:
    """Wraps a prompt's function to say it was reached, and what it raised."""
    if getattr(fn, "__mcpspan_prompt__", False):
        return fn

    def seen() -> _Prompting | None:
        state = _prompting.get()
        if state is not None:
            state.reached = True
        return state

    if inspect.iscoroutinefunction(fn):

        @functools.wraps(fn)
        async def wrapped_async(*args: Any, **kwargs: Any) -> Any:
            state = seen()
            try:
                return await fn(*args, **kwargs)
            except BaseException as error:
                if state is not None:
                    state.raised = error
                raise

        wrapped: Any = wrapped_async
    else:

        @functools.wraps(fn)
        def wrapped_sync(*args: Any, **kwargs: Any) -> Any:
            state = seen()
            try:
                return fn(*args, **kwargs)
            except BaseException as error:
                if state is not None:
                    state.raised = error
                raise

        wrapped = wrapped_sync

    wrapped.__mcpspan_prompt__ = True
    return wrapped


def _is_validation_error(error: BaseException | None) -> bool:
    return error is not None and any(
        cls.__name__ == "ValidationError" for cls in type(error).__mro__
    )


class _MeasuredPrompt:
    """A prompt handed back to the server, measured when it is rendered."""

    def __init__(self, prompt: Any, server: Any, timestamp: str, started: float) -> None:
        self._prompt = prompt
        self._server = server
        self._timestamp = timestamp
        self._started = started

    def __getattr__(self, name: str) -> Any:
        return getattr(self._prompt, name)

    async def render(
        self, arguments: Any = None, context: Any = None, *args: Any, **kwargs: Any
    ) -> Any:
        name = str(getattr(self._prompt, "name", ""))
        call = _call_state(self._server, context, arguments)
        state = _Prompting()
        token = _prompting.set(state)
        try:
            result = await self._prompt.render(arguments, context, *args, **kwargs)
        except BaseException as error:
            if isinstance(error, Exception):
                # Missing arguments are refused before the function runs;
                # arguments of the wrong type, by the validation it runs behind.
                if not state.reached or _is_validation_error(state.raised):
                    outcome: dict[str, str] = {"errorSource": "arguments"}
                else:
                    outcome = _exception(state.raised or error)
                _record("prompt", name, call, self._timestamp, self._started, **outcome)
            raise
        finally:
            _prompting.reset(token)

        if not _is_interim(result):
            _record("prompt", name, call, self._timestamp, self._started, result)
        return result


def _wrap_prompt_manager(server: Any, manager: Any) -> None:
    for prompt in list((getattr(manager, "_prompts", {}) or {}).values()):
        _wrap_prompt_fn(prompt)

    add_prompt = getattr(manager, "add_prompt", None)
    if callable(add_prompt):

        @functools.wraps(add_prompt)
        def added(prompt: Any, *args: Any, **kwargs: Any) -> Any:
            _wrap_prompt_fn(prompt)
            return add_prompt(prompt, *args, **kwargs)

        manager.add_prompt = added

    original = manager.get_prompt

    @functools.wraps(original)
    def get_prompt(name: str, *args: Any, **kwargs: Any) -> Any:
        prompt = original(name, *args, **kwargs)
        if not is_recording():
            return prompt

        timestamp = now_iso()
        started = time.perf_counter()
        if prompt is None:
            # The server raises next; the get ends here, and so does its measurement.
            try:
                call = _call_state(server, _current_context(server), None)
                _record("prompt", str(name), call, timestamp, started, errorSource="unknown_prompt")
            except Exception:
                pass
            return prompt
        return _MeasuredPrompt(prompt, server, timestamp, started)

    manager.get_prompt = get_prompt


def _wrap_prompt_fn(prompt: Any) -> None:
    try:
        fn = getattr(prompt, "fn", None)
        if callable(fn):
            prompt.fn = _note_reached(fn)
    except Exception:
        pass
