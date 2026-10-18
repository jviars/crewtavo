// Run by connection.test.ts in a process of its own: a client that sends its whole upload before
// it reads anything (as Python's http.client and many scripts do), so it only gets the answer if
// the server keeps reading after refusing it. It then keeps its side of the connection open for a
// while, as a client that doesn't close would. Prints the status line, or the error, and how long
// the answer took, as JSON.
import { connect } from "node:net";

const [port, size] = process.argv.slice(2).map(Number);
const started = Date.now();
const socket = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
let answer = "";
socket.on("data", () => undefined).pause();
socket.on("connect", () => {
  socket.write(`POST /upload HTTP/1.1\r\nHost: x\r\nContent-Type: application/octet-stream\r\nContent-Length: ${size}\r\n\r\n`);
  socket.write(Buffer.alloc(size), () => {
    socket.removeAllListeners("data");
    socket.on("data", (d) => (answer += d));
    socket.resume();
  });
});
const done = (error) => {
  console.log(JSON.stringify({ status: answer.split("\r\n")[0] || null, error: error?.code ?? null, ms: Date.now() - started }));
  process.exit(0);
};
socket.on("end", () => {
  const status = answer.split("\r\n")[0] || null;
  const ms = Date.now() - started;
  setTimeout(() => {
    console.log(JSON.stringify({ status, error: null, ms }));
    process.exit(0);
  }, 2_500);
});
socket.on("error", done);
setTimeout(() => done({ code: "TIMEOUT" }), 15_000);
