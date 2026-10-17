/**
 * A small SMTP client for sending through a company's own mailbox (Gmail, Zoho, Microsoft 365...)
 * with an app password. It speaks just enough SMTP to send one message: EHLO, STARTTLS when the port
 * needs it, AUTH PLAIN or LOGIN, MAIL FROM, RCPT TO, DATA. Bodies are base64, so long lines and
 * leading dots never need special handling.
 * Runs on Node (Railway, Docker, local), using node:net and node:tls.
 */

export interface SmtpSettings {
  host: string;
  port: number;
  security: "tls" | "starttls";
  username: string;
  password: string;
}

export interface SmtpMessage {
  from: { name?: string | null; email: string };
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

/** A failure with a message the office can act on. */
export class SmtpError extends Error {
  override name = "SmtpError";
  constructor(message: string, readonly code?: number) {
    super(message);
  }
}

interface Connection {
  write(data: string): Promise<void>;
  /** Next chunk of text from the server, or null when the connection closed. */
  read(): Promise<string | null>;
  startTls(): Promise<void>;
  close(): void;
}

const TIMEOUT_MS = 20_000;

async function open({ host, port, security }: SmtpSettings): Promise<Connection> {
  const net = await import("node:net");
  const tls = await import("node:tls");
  type Sock = import("node:net").Socket;
  const chunks: string[] = [];
  let waiting: ((value: string | null) => void) | null = null;
  let closed = false;
  let failure: Error | null = null;

  const deliver = (value: string | null) => {
    if (waiting) {
      const w = waiting;
      waiting = null;
      w(value);
    } else if (value !== null) chunks.push(value);
  };
  const attach = (s: Sock) => {
    s.setEncoding("utf8");
    s.on("data", (d: string) => deliver(d));
    s.on("error", (e: Error) => {
      failure = e;
      closed = true;
      deliver(null);
    });
    s.on("close", () => {
      closed = true;
      deliver(null);
    });
  };

  let socket: Sock = await new Promise<Sock>((resolve, reject) => {
    const s: Sock = security === "tls" ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    s.setTimeout(TIMEOUT_MS, () => s.destroy(new Error("timed out")));
    s.once(security === "tls" ? "secureConnect" : "connect", () => resolve(s));
    s.once("error", reject);
  });
  attach(socket);

  return {
    write: (data) => new Promise((resolve, reject) => socket.write(data, (e) => (e ? reject(e) : resolve()))),
    read: () => {
      if (chunks.length) return Promise.resolve(chunks.shift()!);
      if (closed) return failure ? Promise.reject(failure) : Promise.resolve(null);
      return new Promise((resolve) => (waiting = resolve));
    },
    startTls: async () => {
      const plain = socket;
      plain.removeAllListeners("data");
      plain.removeAllListeners("close");
      plain.removeAllListeners("error");
      socket = await new Promise<Sock>((resolve, reject) => {
        const s = tls.connect({ socket: plain, servername: host });
        s.setTimeout(TIMEOUT_MS, () => s.destroy(new Error("timed out")));
        s.once("secureConnect", () => resolve(s));
        s.once("error", reject);
      });
      attach(socket);
    },
    close: () => socket.destroy(),
  };
}

/** Reads whole SMTP replies ("250-..." continuation lines up to the "250 ..." final line). */
class Replies {
  private buffer = "";
  constructor(private readonly conn: Connection) {}

  async next(): Promise<{ code: number; text: string }> {
    for (;;) {
      const lines = this.buffer.split("\r\n");
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i]!) || /^\d{3}$/.test(lines[i]!)) {
          const reply = lines.slice(0, i + 1);
          this.buffer = lines.slice(i + 1).join("\r\n");
          return { code: Number(reply.at(-1)!.slice(0, 3)), text: reply.map((l) => l.slice(4)).join("\n") };
        }
      }
      const chunk = await this.conn.read();
      if (chunk === null) throw new SmtpError("The mail server closed the connection.");
      this.buffer += chunk;
    }
  }
}

/** Header values: no line breaks (they'd start new headers), non-ASCII as RFC 2047 words. */
function headerValue(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ").trim();
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${base64(clean)}?=`;
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const wrap76 = (b64: string) => b64.replace(/.{1,76}/g, "$&\r\n");
const address = (email: string) => {
  const clean = email.replace(/[\r\n<>\s]/g, "");
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(clean)) throw new SmtpError(`"${email}" isn't a valid email address.`);
  return clean;
};

function smtpDate(d: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()]}, ${p(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

/** The message as it goes after DATA: headers, a text part and an optional HTML part. */
export function buildMime(message: SmtpMessage, now = new Date(), id = crypto.randomUUID()): { mime: string; messageId: string } {
  const from = address(message.from.email);
  const domain = from.split("@")[1]!;
  const messageId = `<${id}@${domain}>`;
  const boundary = `crewtavo-${id.replace(/-/g, "")}`;
  const headers: string[] = [
    `From: ${message.from.name ? `${headerValue(message.from.name.replace(/["\\]/g, ""))} <${from}>` : from}`,
    `To: ${address(message.to)}`,
    ...(message.replyTo ? [`Reply-To: ${address(message.replyTo)}`] : []),
    `Subject: ${headerValue(message.subject)}`,
    `Date: ${smtpDate(now)}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    ...Object.entries(message.headers ?? {})
      .filter(([k]) => /^[A-Za-z0-9-]+$/.test(k) && !/^(from|to|subject|date|message-id|mime-version|content-type|reply-to)$/i.test(k))
      .map(([k, v]) => `${k}: ${headerValue(v)}`),
  ];
  const part = (type: string, body: string) => `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(base64(body))}`;
  const body = message.html
    ? [`Content-Type: multipart/alternative; boundary="${boundary}"`, "", `--${boundary}`, part("text/plain", message.text), `--${boundary}`, part("text/html", message.html), `--${boundary}--`, ""].join("\r\n")
    : part("text/plain", message.text);
  return { mime: `${headers.join("\r\n")}\r\n${body}`, messageId };
}

/** Turn a server reply into something the office can fix. */
function explain(step: string, reply: { code: number; text: string }, settings: SmtpSettings): SmtpError {
  const text = reply.text.replace(/\s+/g, " ").trim();
  if (step === "auth") {
    if (/5\.7\.30|basic authentication is (disabled|not supported)/i.test(text)) {
      return new SmtpError("Microsoft has turned off password sign-in for sending from this mailbox. Ask your Microsoft 365 admin to turn on Authenticated SMTP for it, or connect a Gmail or Zoho mailbox instead.", reply.code);
    }
    if (/application-specific password|app password/i.test(text) || settings.host.includes("gmail")) {
      return new SmtpError("Google didn't accept that sign-in. Use an app password (16 letters), not your regular password, and check the email address.", reply.code);
    }
    return new SmtpError(`The mail server didn't accept the email address and password (${reply.code}). Check them, and use an app password if your provider has them.`, reply.code);
  }
  if (step === "rcpt") return new SmtpError(`The mail server wouldn't send to that address: ${text.slice(0, 200)}`, reply.code);
  if (step === "from") return new SmtpError(`The mail server wouldn't send from ${settings.username}: ${text.slice(0, 200)}. The "from" address usually has to be the mailbox you signed in with.`, reply.code);
  return new SmtpError(`The mail server said: ${reply.code} ${text.slice(0, 200)}`, reply.code);
}

/**
 * Connect, sign in, and (unless `message` is null, which only checks the sign-in) send one message.
 * Returns the Message-ID.
 */
export async function smtpSend(settings: SmtpSettings, message: SmtpMessage | null): Promise<{ id: string }> {
  let conn: Connection;
  try {
    conn = await open(settings);
  } catch (error) {
    throw new SmtpError(`Couldn't connect to ${settings.host} on port ${settings.port}. Check the server name and port${error instanceof Error && /timed out/i.test(error.message) ? " (the connection timed out)" : ""}.`);
  }
  const deadline = setTimeout(() => conn.close(), TIMEOUT_MS * 2);
  try {
    const replies = new Replies(conn);
    const expect = async (step: string, ok: number[]) => {
      const reply = await replies.next();
      if (!ok.includes(reply.code)) throw explain(step, reply, settings);
      return reply;
    };
    const command = async (line: string, step: string, ok: number[]) => {
      await conn.write(`${line}\r\n`);
      return expect(step, ok);
    };

    try {
      await expect("greeting", [220]);
    } catch (error) {
      throw new SmtpError(`${settings.host} didn't answer like a mail server on port ${settings.port}. Check the port and the security setting (port 465 uses SSL, port 587 uses STARTTLS).${error instanceof SmtpError && error.code ? ` (${error.message})` : ""}`);
    }
    const helo = settings.username.split("@")[1]?.replace(/[^a-z0-9.-]/gi, "") || "crewtavo.local";
    let ehlo = await command(`EHLO ${helo}`, "ehlo", [250]);
    if (settings.security === "starttls") {
      if (!/\bSTARTTLS\b/i.test(ehlo.text)) throw new SmtpError(`${settings.host} doesn't offer a secure connection on port ${settings.port}. Try port 465 with SSL.`);
      await command("STARTTLS", "starttls", [220]);
      await conn.startTls();
      ehlo = await command(`EHLO ${helo}`, "ehlo", [250]);
    }

    const auth = ehlo.text.match(/^AUTH[ =](.*)$/im)?.[1]?.toUpperCase() ?? "";
    if (auth.includes("PLAIN") || !auth.includes("LOGIN")) {
      await command(`AUTH PLAIN ${base64(`\0${settings.username}\0${settings.password}`)}`, "auth", [235]);
    } else {
      await command("AUTH LOGIN", "auth", [334]);
      await command(base64(settings.username), "auth", [334]);
      await command(base64(settings.password), "auth", [235]);
    }

    if (!message) {
      await conn.write("QUIT\r\n").catch(() => undefined);
      return { id: "" };
    }
    const { mime, messageId } = buildMime(message);
    await command(`MAIL FROM:<${address(message.from.email)}>`, "from", [250]);
    await command(`RCPT TO:<${address(message.to)}>`, "rcpt", [250, 251]);
    await command("DATA", "data", [354]);
    // Dot-stuffing: a line that starts with "." gets another one (headers could; base64 can't).
    await conn.write(`${mime.replace(/\r\n\./g, "\r\n..")}\r\n.\r\n`);
    await expect("send", [250]);
    await conn.write("QUIT\r\n").catch(() => undefined);
    return { id: messageId };
  } catch (error) {
    if (error instanceof SmtpError) throw error;
    throw new SmtpError(`Sending through ${settings.host} failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(deadline);
    conn.close();
  }
}
