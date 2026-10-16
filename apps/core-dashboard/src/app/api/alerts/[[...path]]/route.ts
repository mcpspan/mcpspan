import { proxyHandlers } from '@mcpspan/dashboard-ui/src/lib/proxy';

/** Alert rules and the webhook, passed through to the Core API with the reader's session. */
export const { GET, POST, PUT, PATCH, DELETE } = proxyHandlers('/v1/alerts');
