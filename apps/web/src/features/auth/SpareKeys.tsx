/**
 * The owner's spare keys, shown once: when they create the owner account, and when they make a new
 * set in Settings → Profile. The main way to keep them is the key file (lib/keyFile.ts): download it
 * now, upload it on the sign-in page if they forget their password while Crewtavo can't email them.
 * Printing is there for people who'd rather keep paper.
 */
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { escapeHtml } from "@/lib/html";
import { KEY_FILE_NAME, keyFileText } from "@/lib/keyFile";
import styles from "./auth.module.css";

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

/**
 * The key file to download (or the keys to print), then "I saved it" before going on. `bar` puts
 * the last button in the screen's action bar (a setup screen, not a dialog).
 */
export function SpareKeysSheet({ keys, email, doneLabel, onDone, busy = false, bar = false }: { keys: string[]; email: string; doneLabel: string; onDone: () => void; busy?: boolean; bar?: boolean }) {
  const [kept, setKept] = useState(false);
  const [saved, setSaved] = useState(false);
  const done = <Button variant={saved ? "primary" : "secondary"} disabled={!saved} loading={busy} onClick={onDone}>{doneLabel}</Button>;
  const sheet = (
    <div className={styles.keySheet}>
      <p className={styles.sub} style={{ margin: 0 }}>
        This is your key file. If you ever forget your password, you'll upload it on the sign-in page to get back in.
        Save it somewhere you won't lose it, like your phone's Files app or Google Drive. You won't see it again.
      </p>
      <div className={styles.keyFile}>
        <span className={styles.keyIcon} aria-hidden="true"><Icon name="lock" size={20} /></span>
        <span className="grow" style={{ minWidth: 0 }}>
          <span className={styles.keyName}>{KEY_FILE_NAME}</span>
          <span className={styles.hint}>{keys.length} keys, each works once</span>
        </span>
        <Button variant={kept ? "secondary" : "primary"} icon="download" onClick={() => { downloadKeyFile(keys, email); setKept(true); }}>Download</Button>
      </div>
      <details className={styles.fold}>
        <summary>Rather keep it on paper? See the keys</summary>
        {/* Each key on one line (a key split across lines is easy to copy wrong); two columns when they fit. */}
        <ol className={styles.keys} aria-label="Spare keys">
          {keys.map((key) => <li key={key}>{key}</li>)}
        </ol>
        <div className={styles.foldActs}><Button size="sm" icon="printer" onClick={() => { printKeys(keys, email); setKept(true); }}>Print the keys</Button></div>
      </details>
      <p className={styles.note}>
        Each key in the file works once, so the file gets you in up to {keys.length} times. It only works while Crewtavo can't email you; once your email is connected, Forgot password sends you a link instead. Anyone who has the file can get into your account, so don't share it.
      </p>
      <label className={styles.saved} data-off={!kept || undefined}>
        <input type="checkbox" checked={saved} disabled={!kept} onChange={(e) => setSaved(e.target.checked)} />
        <span>{kept ? "I saved my key file somewhere safe" : "Download the key file (or print the keys) first"}</span>
      </label>
      {!bar && done}
    </div>
  );
  return bar ? <>{sheet}<div className={styles.acts}>{done}</div></> : sheet;
}
