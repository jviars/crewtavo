// Run by connection.test.ts in a process of its own (the answer then arrives while the upload is
// still being sent, as it does over a network): uploads that are refused before they're read, each
// followed by a request on the same connections. Prints the statuses, or the errors, as JSON.
const [port, size, rounds] = process.argv.slice(2).map(Number);
const body = new Uint8Array(size);
const status = (r) => r.status;
const failed = (e) => e.cause?.code ?? e.message;
const results = [];
for (let i = 0; i < rounds; i++) {
  const upload = await fetch(`http://127.0.0.1:${port}/upload`, { method: "POST", body }).then(status, failed);
  const next = await fetch(`http://127.0.0.1:${port}/next`).then(status, failed);
  results.push([upload, next]);
}
console.log(JSON.stringify(results));
