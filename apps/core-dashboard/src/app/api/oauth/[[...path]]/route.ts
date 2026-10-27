import { proxyHandlers } from '@mcpspan/dashboard-ui/src/lib/proxy';

/** Answering an app that asks to read this account (the consent page), and the apps connected so far, through the Core API with the reader's session. */
export const { GET, POST, DELETE } = proxyHandlers('/v1/oauth');
