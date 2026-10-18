import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";

/** How long the rest of an unread upload is read (and dropped) after answering it, at most. */
const LINGER_MS = 2_000;
/**
 * A smaller body comes in with the request and Node reads what's left of it itself, so the
 * connection stays usable. (A body whose length isn't given counts as large.)
 */
const SMALL_BODY = 64 * 1024;

type Request = (req: IncomingMessage, res: ServerResponse) => void;
type Closing = Socket & { crewtavoClosing?: boolean; crewtavoLingering?: boolean };

/**
 * Answers sent before a large request body has arrived (a 404, 401 or 413 to an upload) close the
 * connection. Node can't keep it once it gives up on the unread body, and it would otherwise have
 * told the client to keep it: the next request sent on it, the browser's or Railway's proxy's
 * (which can be someone else's), then fails with a reset.
 *
 * It's closed gently: once the answer is sent the rest of the upload is read and dropped, for a
 * moment at most, before the socket closes. Closing with unread bytes waiting resets the
 * connection, and a client still sending its upload then loses the answer too. Requests sent
 * behind it on the same connection aren't run: the client was told it closes, and sends them again.
 */
export function closeAfterUnreadBodies(server: Server) {
  const handlers = server.listeners("request") as Request[];
  server.removeAllListeners("request");
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const socket = req.socket as Closing;
    if (socket.crewtavoClosing) {
      req.resume();
      return;
    }
    const writeHead = res.writeHead;
    res.writeHead = function (this: ServerResponse, ...args: unknown[]) {
      if (!res.headersSent && unread(req)) {
        res.setHeader("Connection", "close");
        socket.crewtavoClosing = true;
        lingerOnClose(req, socket);
        // The answer's own headers would otherwise win (a streamed answer says keep-alive).
        args = args.map(withoutConnection);
      }
      return (writeHead as (...a: unknown[]) => ServerResponse).apply(this, args);
    } as typeof res.writeHead;
    for (const handle of handlers) handle.call(server, req, res);
  });
}

/** writeHead's headers (an object, or a flat [name, value, ...] list) without Connection. */
function withoutConnection(arg: unknown) {
  if (Array.isArray(arg)) {
    const kept: unknown[] = [];
    for (let i = 0; i + 1 < arg.length; i += 2) if (String(arg[i]).toLowerCase() !== "connection") kept.push(arg[i], arg[i + 1]);
    return kept;
  }
  if (arg && typeof arg === "object") return Object.fromEntries(Object.entries(arg).filter(([name]) => name.toLowerCase() !== "connection"));
  return arg;
}

function unread(req: IncomingMessage) {
  const length = Number(req.headers["content-length"] ?? 0);
  return (req.headers["transfer-encoding"] !== undefined || length > SMALL_BODY) && !req.complete;
}

/** Once the answer is sent, Node closes the socket with destroySoon: close it gently instead. */
function lingerOnClose(req: IncomingMessage, socket: Closing) {
  socket.destroySoon = function (this: Closing) {
    if (this.crewtavoLingering) return;
    this.crewtavoLingering = true;
    const close = () => {
      clearTimeout(timer);
      this.destroy();
    };
    const timer = setTimeout(close, LINGER_MS);
    this.once("close", () => clearTimeout(timer));
    this.once("end", close);
    // Finish sending (the client sees the end of the answer), then drop the rest of the upload:
    // whatever was reading it (the app's view of the body) is detached, as Node does with a body
    // nobody reads, and the socket closes once it's all in.
    this.end();
    if (req.complete) return close();
    req.removeAllListeners("data");
    req.once("end", close);
    req.resume();
    this.resume();
  };
}
