import type { Server } from "node:http";

/**
 * Answers sent before the request's body has all arrived (a 404, 401 or 413 to a large upload)
 * close the connection. Node can't keep it once it gives up on the unread body, and it would
 * otherwise have told the client to keep it: the next request sent on it, the browser's or
 * Railway's proxy's (which can be someone else's), then fails with a reset.
 */
export function closeAfterUnreadBodies(server: Server) {
  server.prependListener("request", (req, res) => {
    const writeHead = res.writeHead;
    res.writeHead = function (this: typeof res, ...args: unknown[]) {
      const body = req.headers["transfer-encoding"] !== undefined || Number(req.headers["content-length"] ?? 0) > 0;
      if (body && !req.complete && !res.headersSent) res.setHeader("Connection", "close");
      return (writeHead as (...a: unknown[]) => typeof res).apply(this, args);
    } as typeof res.writeHead;
  });
}
