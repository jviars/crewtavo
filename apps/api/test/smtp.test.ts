/**
 * The SMTP client against a small mail server on localhost that speaks real TLS, so the switch to
 * a secure connection and each step's time limit work as they do with Gmail or Microsoft 365.
 */
import net from "node:net";
import tls from "node:tls";
import { describe, expect, it, vi } from "vitest";
import { smtpSend, SmtpError, type SmtpTimeouts } from "../src/lib/smtp";

// The client trusts the test certificate below (and only it), so certificates are still checked.
// Each connection is given it, which works on every Node version (setting the default ones needs 22.19).
vi.mock("node:tls", async (importOriginal) => {
  const tls = await importOriginal<typeof import("node:tls") & { default: typeof import("node:tls") }>();
  const connect = (options: import("node:tls").ConnectionOptions) => tls.connect({ ...options, ca: CERT });
  return { ...tls, connect, default: { ...tls.default, connect } };
});

// A self-signed certificate for "localhost", made for these tests (it's trusted nowhere else).
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg/HmMT/3t6TYZiOKs
G2Obos2ets3is8UGy+3YqGFzfkehRANCAATIBV/cyhUcXne2ewYfTb73mB07RIVJ
vy4/tJEYHZC2SezquFgJXftEpa8yhe+GPli3t3Wjcgu+gXtVqXijoFDS
-----END PRIVATE KEY-----`;
const CERT = `-----BEGIN CERTIFICATE-----
MIIBlDCCATugAwIBAgIUAbo7+/OfLxziXy8Xp/pUDuuyXbAwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAxODAwMDIyOFoYDzIxMjYwOTI0
MDAwMjI4WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAATIBV/cyhUcXne2ewYfTb73mB07RIVJvy4/tJEYHZC2SezquFgJXftE
pa8yhe+GPli3t3Wjcgu+gXtVqXijoFDSo2kwZzAdBgNVHQ4EFgQUMTPKVOgN+ZZk
Ff+xncuK1p+jVMQwHwYDVR0jBBgwFoAUMTPKVOgN+ZZkFf+xncuK1p+jVMQwDwYD
VR0TAQH/BAUwAwEB/zAUBgNVHREEDTALgglsb2NhbGhvc3QwCgYIKoZIzj0EAwID
RwAwRAIgQIVp8wtqls9l2fExL6t2T3DTSZ9FpS6yS2wudZrrcA0CIGDMzwL2R6/f
6RjJ57KTc+p6utmxD6F1EZ/A/kuj3LX4
-----END CERTIFICATE-----`;

/**
 * A port 587 mail server: STARTTLS, sign-in, one message. `afterStartTls` is written in the clear
 * right after its 220, as someone in between could; the delays are how long it takes to answer.
 */
async function mailServer(options: { afterStartTls?: string; authDelayMs?: number; sentDelayMs?: number | null } = {}) {
  const state = { commands: [] as string[], secured: false, messages: 0 };
  const context = tls.createSecureContext({ key: KEY, cert: CERT });
  const server = net.createServer((raw) => {
    let socket: net.Socket = raw;
    let inData = false;
    let buffer = "";
    const send = (text: string) => socket.write(text);
    const onLine = (line: string) => {
      if (inData) {
        if (line !== ".") return;
        inData = false;
        state.messages++;
        if (options.sentDelayMs !== null) setTimeout(() => send("250 2.0.0 Queued\r\n"), options.sentDelayMs ?? 0);
        return;
      }
      const command = line.split(" ")[0]!.toUpperCase();
      state.commands.push(command);
      if (command === "EHLO") send(`250-localhost\r\n${socket === raw ? "250-STARTTLS\r\n" : ""}250 AUTH PLAIN LOGIN\r\n`);
      else if (command === "STARTTLS") {
        send(`220 2.0.0 Ready to start TLS\r\n${options.afterStartTls ?? ""}`);
        raw.removeAllListeners("data");
        const secure = new tls.TLSSocket(raw, { isServer: true, secureContext: context });
        secure.on("secure", () => (state.secured = true));
        secure.on("error", () => undefined);
        secure.setEncoding("utf8");
        secure.on("data", onData);
        socket = secure;
      } else if (command === "AUTH") setTimeout(() => send("235 2.7.0 Accepted\r\n"), options.authDelayMs ?? 0);
      else if (command === "MAIL" || command === "RCPT") send("250 2.1.0 OK\r\n");
      else if (command === "DATA") {
        inData = true;
        send("354 Go ahead\r\n");
      } else if (command === "QUIT") send("221 2.0.0 Bye\r\n");
      else send("502 5.5.1 Unrecognized command\r\n");
    };
    const onData = (chunk: string) => {
      buffer += chunk;
      for (let i = buffer.indexOf("\r\n"); i >= 0; i = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        onLine(line);
      }
    };
    raw.setEncoding("utf8");
    raw.on("data", onData);
    raw.on("error", () => undefined);
    send("220 localhost ESMTP\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const send = (timeouts?: SmtpTimeouts) =>
    smtpSend(
      { host: "localhost", port, security: "starttls", username: "office@acme.example", password: "app-password" },
      { from: { name: "Acme", email: "office@acme.example" }, to: "ana@example.com", subject: "Your quote", text: "Hello" },
      timeouts,
    ).finally(() => server.close());
  return { state, send };
}

describe("SMTP", () => {
  it("sends one message over STARTTLS", async () => {
    const { state, send } = await mailServer();
    expect((await send()).id).toMatch(/^<.+@acme\.example>$/);
    expect(state).toMatchObject({ secured: true, messages: 1 });
    expect(state.commands.slice(0, 7)).toEqual(["EHLO", "STARTTLS", "EHLO", "AUTH", "MAIL", "RCPT", "DATA"]);
  });

  it("stops when the server sends more in the clear after agreeing to STARTTLS", async () => {
    // Read after the switch, this line would pass for the server's encrypted answer to EHLO.
    const { state, send } = await mailServer({ afterStartTls: "250 AUTH PLAIN\r\n" });
    const error = await send().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SmtpError);
    expect((error as SmtpError).message).toBe("localhost sent more than it should have before the secure connection started, so nothing was sent. Try again, or try port 465 with SSL.");
    expect(state.secured).toBe(false);
    expect(state.commands).toEqual(["EHLO", "STARTTLS"]);
  });

  it("waits longer for the answer to the message than for each step", async () => {
    const { state, send } = await mailServer({ sentDelayMs: 800 });
    expect((await send({ stepMs: 300, sentMs: 5_000 })).id).toMatch(/@acme\.example>$/);
    expect(state.messages).toBe(1);
  });

  it("still gives up on a server that never answers the message, and on a slow step", async () => {
    const silent = await mailServer({ sentDelayMs: null });
    const started = Date.now();
    await expect(silent.send({ stepMs: 300, sentMs: 1_000 })).rejects.toBeInstanceOf(SmtpError);
    expect(Date.now() - started).toBeLessThan(3_000);

    const slowSignIn = await mailServer({ authDelayMs: 800 });
    await expect(slowSignIn.send({ stepMs: 300, sentMs: 5_000 })).rejects.toBeInstanceOf(SmtpError);
    expect(slowSignIn.state.messages).toBe(0);
  });
});
