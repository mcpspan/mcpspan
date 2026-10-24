import { proxyHandlers } from '@mcpspan/dashboard-ui/src/lib/proxy';

/** Read tokens, made and revoked through the Core API with the reader's session. */
export const { GET, POST, DELETE } = proxyHandlers('/v1/tokens');
