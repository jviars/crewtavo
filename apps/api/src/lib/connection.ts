import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";

/** How long the rest of an unread upload is read (and dropped) after answering it, at most. */
const LINGER_MS = 2_000;
/** Less than this, Node reads what's left of the body itself and the connection stays usable. */
const SMALL_BODY = 64 * 1024;

/**
 * Answers sent before the request's body has arrived (a 404, 401 or 413 to a large upload) close
 * the connection. Node can't keep it once it gives up on the unread body, and it would otherwise
 * have told the client to keep it: the next request sent on it, the browser's or Railway's proxy's
 * (which can be someone else's), then fails with a reset.
 *
 * The connection is closed gently: the answer is sent and the rest of the upload is read and
 * dropped for a moment. Closing with unread bytes waiting resets the connection, and a client
 * still sending its upload then loses the answer too.
 */
export function closeAfterUnreadBodies(server: Server) {
  server.prependListener("request", (req: IncomingMessage, res: ServerResponse) => {
    const writeHead = res.writeHead;
    res.writeHead = function (this: ServerResponse, ...args: unknown[]) {
      if (!res.headersSent && unread(req)) {
        res.setHeader("Connection", "close");
        lingerOnClose(req);
      }
      return (writeHead as (...a: unknown[]) => ServerResponse).apply(this, args);
    } as typeof res.writeHead;
  });
}

function unread(req: IncomingMessage) {
  const length = Number(req.headers["content-length"] ?? 0);
  if (req.headers["transfer-encoding"] === undefined && !(length > SMALL_BODY)) return false;
  // A body that's all here but not read yet (an answer given straight away) has arrived.
  return !req.complete && !(length > 0 && req.readableLength >= length);
}

/** Once the answer is sent, Node closes the socket with destroySoon: close it gently instead. */
function lingerOnClose(req: IncomingMessage) {
  const socket = req.socket as Socket & { crewtavoLingering?: boolean };
  socket.destroySoon = function (this: typeof socket) {
    if (this.crewtavoLingering) return;
    this.crewtavoLingering = true;
    const done = () => {
      clearTimeout(timer);
      this.destroy();
    };
    const timer = setTimeout(done, LINGER_MS);
    this.once("end", done);
    this.once("close", () => clearTimeout(timer));
    // Finish sending (the client sees the end of the answer) and keep reading what it still sends.
    this.end();
    req.resume();
    this.resume();
  };
}
