# syntax=docker/dockerfile:1

# mcpspan-proxy in front of an MCP server over HTTP. The command is one file
# with nothing to install beside it, so the image is Node and that file.
# Built from this directory, after the command is:
#
#   pnpm --filter mcpspan-proxy build
#   docker build -t ghcr.io/mcpspan/proxy packages/mcpspan-proxy
#
# Run with the server's URL, and the key and endpoint as for an SDK:
#
#   docker run -p 6273:6273 -e MCPSPAN_API_KEY -e MCPSPAN_ENDPOINT ghcr.io/mcpspan/proxy http://server:3000/mcp

# Pinned to a patch, as the API's image is.
FROM node:24.22.1-alpine

ENV NODE_ENV=production
# In a container the proxy has to listen beyond itself to be reached.
ENV MCPSPAN_PROXY_HOST=0.0.0.0

WORKDIR /app
COPY dist/index.mjs ./index.mjs

USER node
EXPOSE 6273

ENTRYPOINT ["node", "/app/index.mjs"]
CMD ["--help"]
