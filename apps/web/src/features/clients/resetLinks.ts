/**
 * "Reset this client's links" on a client's page (ClientPage's menu, the office): what it's called
 * and what it asks before it does it. The server ends the links (POST /clients/:id/links/reset).
 */
export const RESET_LINKS_LABEL = "Reset this client's links";

/** One plain sentence on what it does, where the office confirms it. */
export const RESET_LINKS_BODY =
  "Every quote, invoice and Client Hub link sent to this client so far stops opening, for them and for anyone it was passed on to; the next one you send or copy works as usual.";

/** Where the office asks the server to do it. */
export const resetLinksPath = (clientId: string) => `/clients/${clientId}/links/reset`;
