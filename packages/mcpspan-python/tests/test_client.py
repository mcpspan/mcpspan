from __future__ import annotations

from types import SimpleNamespace

from mcpspan._client import (
    CLIENT_INFO_META_KEY,
    ClientInfo,
    client_from_request,
    client_name,
)


def test_no_name_without_a_client() -> None:
    assert client_name(None) is None


def test_keeps_the_name_as_sent_but_cut() -> None:
    assert client_name(ClientInfo(" cursor ", None)) == "cursor"
    assert len(client_name(ClientInfo("c" * 400, None)) or "") == 200


def test_reads_the_2026_request_first() -> None:
    handshake = SimpleNamespace(client_params=SimpleNamespace(clientInfo=ClientInfo("old", "1")))
    context = SimpleNamespace(
        meta={CLIENT_INFO_META_KEY: {"name": "claude-code", "version": "2"}},
        session=handshake,
    )
    assert client_from_request(context) == ClientInfo("claude-code", "2")


def test_reads_meta_kept_as_a_v1_model() -> None:
    meta = SimpleNamespace(model_extra={CLIENT_INFO_META_KEY: {"name": "cursor"}})
    assert client_from_request(SimpleNamespace(meta=meta)) == ClientInfo("cursor", None)


def test_falls_back_to_the_handshake_in_either_spelling() -> None:
    v1 = SimpleNamespace(
        meta=None,
        session=SimpleNamespace(client_params=SimpleNamespace(clientInfo=ClientInfo("a", "1"))),
    )
    v2 = SimpleNamespace(
        meta={},
        connection=SimpleNamespace(client_params=SimpleNamespace(client_info=ClientInfo("b", "2"))),
    )
    assert client_from_request(v1) == ClientInfo("a", "1")
    assert client_from_request(v2) == ClientInfo("b", "2")


def test_unknown_from_nothing_or_a_broken_context() -> None:
    class Broken:
        @property
        def meta(self) -> object:
            raise RuntimeError("no")

    assert client_from_request(None) is None
    assert client_from_request(SimpleNamespace(meta=None)) is None
    assert client_from_request(Broken()) is None


def test_reads_the_raw_params_when_meta_was_trimmed() -> None:
    context = SimpleNamespace(
        meta={"progressToken": 1},
        params={"_meta": {CLIENT_INFO_META_KEY: {"name": "cursor", "version": "3"}}},
    )
    assert client_from_request(context) == ClientInfo("cursor", "3")
