# Badges

Show in your MCP server's README how much it is used and how well it answers,
like the badges for builds and downloads beside them:

![mcpspan: 12.4k calls/week](https://mcpspan.com/img/badges/calls.svg)
![mcpspan: 99.2% success](https://mcpspan.com/img/badges/success.svg)
![mcpspan: p50 84 ms](https://mcpspan.com/img/badges/latency.svg)

Each one covers the last seven days:

| Badge | Shows |
|---|---|
| Calls | Calls of every kind, rounded: `840 calls/week`, `12.4k calls/week`, `1.2M calls/week`. |
| Success rate | The share of calls that did not fail, never rounded up to 100%. Green from 99%, then through yellow to red below 80%. |
| Response time | The median response time, `p50 84 ms` or `p50 1.2 s`. |

A server with no calls in the week shows `0 calls/week` or `no calls yet`, in
grey.

## Switching them on

In Settings, Badges: switch them on for a server, tick the ones you want, and
copy the line shown into your README. Calls and success rate are ticked to
start with. The line looks like this, one link per badge:

```md
[![mcpspan calls](https://api.mcpspan.com/badge/<id>/calls.svg)](https://mcpspan.com) [![mcpspan success rate](https://api.mcpspan.com/badge/<id>/success.svg)](https://mcpspan.com)
```

Badges are off until you switch them on, for each server on its own. The
`<id>` is random and says nothing about the server or the account, and the
badges show nothing but their figures.

**New address** gives the server's badges a new `<id>`, and **Switch off**
removes it: either way the old address stops at once and shows `no data`.

## Where they are served from

On **mcpspan Cloud**, from `https://api.mcpspan.com`, which GitHub, npm and
any other site can reach. Nothing to set up.

**Self-hosted**, from the address your MCP servers report to
(`MCPSPAN_INGEST_URL`). GitHub fetches the images from there, so a badge shows
in a README only if that address is reachable from the internet. An
installation on `localhost` or a private network shows the badges in its own
Settings, but nowhere else.

## In your own style

Each badge is also JSON in the format of [shields.io](https://shields.io)'s
endpoint badges: swap `.svg` for `.json`. To have it drawn by shields.io, in
any of its styles and next to your other shields:

```md
![mcpspan](https://img.shields.io/endpoint?url=https://api.mcpspan.com/badge/<id>/calls.json&style=for-the-badge)
```

## What they say, and how fresh

The figures are what your server's own SDK sent, as everything in mcpspan is,
and the badge's tooltip says so: "Reported by this server's own mcpspan".
They are worked out again at most every five minutes, so a README with many
readers costs one query every five minutes, and GitHub may keep an image a
little longer than that.
