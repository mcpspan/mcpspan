from __future__ import annotations

from types import SimpleNamespace

from mcpspan._session import MAX_SESSIONS_PER_SERVER, session_for


class Server:
    pass


def http(session: str | None) -> SimpleNamespace:
    headers = {} if session is None else {"mcp-session-id": session}
    return SimpleNamespace(request=SimpleNamespace(headers=headers))


STDIO = SimpleNamespace(request=None)


def test_one_session_for_a_server_over_stdio() -> None:
    server = Server()

    first = session_for(server, STDIO)
    assert first is not None
    assert session_for(server, STDIO) == first
    assert session_for(Server(), STDIO) != first


def test_follows_the_transport_session_over_http_without_using_it() -> None:
    server = Server()

    a = session_for(server, http("transport-a"))
    assert a == session_for(server, http("transport-a"))
    assert a != session_for(server, http("transport-b"))
    assert a is not None and "transport-a" not in a


def test_none_over_http_without_a_transport_session() -> None:
    assert session_for(Server(), http(None)) is None


def test_forgets_the_oldest_idle_session() -> None:
    server = Server()
    first = session_for(server, http("first"))
    for index in range(MAX_SESSIONS_PER_SERVER):
        session_for(server, http(f"s{index}"))

    assert session_for(server, http("first")) != first
