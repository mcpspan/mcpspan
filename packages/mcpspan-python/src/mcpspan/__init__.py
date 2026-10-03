"""Analytics for MCP servers.

The usual integration is one line at startup:

    from mcp.server.fastmcp import FastMCP
    import mcpspan

    mcp = FastMCP("flights")
    mcpspan.instrument(mcp, api_key=os.environ["MCPSPAN_API_KEY"])

Every tool on the server is measured from then on, whether it was registered
before that line or after. Without an API key nothing is collected and
nothing is sent.
"""

from ._config import configure, shutdown
from ._instrument import instrument
from ._track import exclude, track
from ._types import ClientType, ErrorSource, ToolCallEvent
from ._version import SDK_VERSION

__version__ = SDK_VERSION

__all__ = [
    "ClientType",
    "ErrorSource",
    "ToolCallEvent",
    "__version__",
    "configure",
    "exclude",
    "instrument",
    "shutdown",
    "track",
]
