/**
 * The owner's spare keys, shown once: when they create the owner account, and when they make a new
 * set in Settings → Profile. The main way to keep them is the key file (lib/keyFile.ts): download it
 * now, upload it on the sign-in page if they forget their password while Crewtavo can't email them.
 * Printing is there for people who'd rather keep paper.
 */
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { escapeHtml } from "@/lib/html";
import { KEY_FILE_NAME, keyFileText } from "@/lib/keyFile";

/** Prints just the keys, from a hidden frame, so the rest of the page stays out of it. */
function printKeys(keys: string[], email: string) {
  const frame = document.createElement("iframe");
  Object.assign(frame.style, { position: "fixed", width: "0", height: "0", border: "0" });
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>Crewtavo spare keys</title>
<style>body{font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#111;padding:40px;max-width:560px}
h1{font-size:22px;margin:0 0 4px}p{line-height:1.5}ol{columns:2;font:600 20px/2.1 ui-monospace,Menlo,Consolas,monospace;padding-left:28px}.muted{color:#555;font-size:13px}</style></head>
<body><h1>Crewtavo spare keys</h1><div class="muted">${escapeHtml(email)} · ${escapeHtml(window.location.origin)} · made ${escapeHtml(new Date().toLocaleDateString())}</div>
<ol>${keys.map((k) => `<li>${escapeHtml(k)}</li>`).join("")}</ol>
<p>Forgot your password? On the Crewtavo sign-in page, choose <b>Forgot password</b>, then <b>I'm the owner: use my key file</b>, then <b>No file? Type a key</b>, and type your email and one of these keys. Each key works once.</p>
<p class="muted">Keep this somewhere safe. Anyone with a key and your email can get into your account.</p></body></html>`);
  doc.close();
  frame.contentWindow!.focus();
  frame.contentWindow!.print();
  setTimeout(() => frame.remove(), 60_000);
}

function downloadKeyFile(keys: string[], email: string) {
  const text = keyFileText({ email, address: window.location.origin, made: new Date(), keys });
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: KEY_FILE_NAME });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SpareKeysSheet({ keys, email, doneLabel, onDone, busy = false }: { keys: string[]; email: string; doneLabel: string; onDone: () => void; busy?: boolean }) {
  const [kept, setKept] = useState(false);
  const [saved, setSaved] = useState(false);
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <p style={{ margin: 0, lineHeight: 1.5 }}>
        This is your key file. If you ever forget your password, you'll upload it on the sign-in page to get back in.
        Save it somewhere you won't lose it, like your phone's Files app or Google Drive. You won't see it again.
      </p>
      <Button variant="primary" size="lg" icon="download" onClick={() => { downloadKeyFile(keys, email); setKept(true); }}>Download key file</Button>
      <details>
        <summary className="muted small" style={{ cursor: "pointer" }}>Rather keep it on paper? See the keys</summary>
        <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
          <ol
            aria-label="Spare keys"
            // Each key on one line (a key split across lines is easy to copy wrong); two columns when they fit.
            style={{ margin: 0, padding: "12px 16px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(165px, 1fr))", columnGap: 16, listStylePosition: "inside", whiteSpace: "nowrap", borderRadius: 12, background: "var(--fill)", font: "600 15px/2 ui-monospace, Menlo, Consolas, monospace", letterSpacing: "0.02em" }}
          >
            {keys.map((key) => <li key={key}>{key}</li>)}
          </ol>
          <Button icon="printer" onClick={() => { printKeys(keys, email); setKept(true); }} style={{ justifySelf: "start" }}>Print the keys</Button>
        </div>
      </details>
      <p className="muted small" style={{ margin: 0 }}>
        Each key in the file works once, so the file gets you in up to {keys.length} times. It only works while Crewtavo can't email you; once your email is connected, Forgot password sends you a link instead. Anyone who has the file can get into your account, so don't share it.
      </p>
      <label className="row" style={{ gap: 10, alignItems: "flex-start", cursor: kept ? "pointer" : "default", opacity: kept ? 1 : 0.6 }}>
        <input type="checkbox" checked={saved} disabled={!kept} onChange={(e) => setSaved(e.target.checked)} style={{ marginTop: 3 }} />
        <span>{kept ? "I saved my key file somewhere safe" : "Download the key file (or print the keys) first"}</span>
      </label>
      <Button variant={saved ? "primary" : "secondary"} size="lg" disabled={!saved} loading={busy} onClick={onDone}>{doneLabel}</Button>
    </div>
  );
}
