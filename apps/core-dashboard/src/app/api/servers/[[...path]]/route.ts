import { proxyHandlers } from '@/lib/proxy';

/** Server management, passed through to the Core API with the reader's session. */
export const { GET, POST, PATCH, DELETE } = proxyHandlers('/v1/servers');
