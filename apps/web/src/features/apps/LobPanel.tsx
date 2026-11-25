/**
 * Lob on its app page: the business's own Lob account, which prints and mails postcard campaigns
 * (Marketing → Campaigns). Step by step to find the secret key in Lob's dashboard; the key is
 * checked with Lob before it's kept (encrypted, never shown again). Once connected, whether it's a
 * test key, which makes cards Lob never prints or mails, or a live one, which mails them and costs
 * money, is said first and plainly. A business outside the US is told first that the cards are
 * mailed in the US only (core postcardsUsOnly); it can still connect, for a US address of its own.
 */
import { businessCountry } from "@crewtavo/core/countries";
import { postcardsMailHere, postcardsUsOnly } from "@crewtavo/core/postcards";
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Section } from "@/components/ui/Section";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { AppRow } from "./catalog";
import { Step, Steps, kit } from "./PanelKit";

const LOB_KEYS = "https://dashboard.lob.com/settings/api-keys";

/** What a key of each kind does, in a sentence. */
export const LOB_MODE_WORDS = {
  test: "Test key: postcards are made in your Lob dashboard so you can see them, but nothing is printed or mailed, and nothing is charged.",
  live: "Live key: postcards are printed and mailed, and Lob charges your account for each one.",
} as const;

export function LobMode({ mode }: { mode: "test" | "live" | null | undefined }) {
  if (!mode) return null;
  return (
    <div className={`callout ${mode === "live" ? "callout-warning" : "callout-info"}`} role="note">
      <Icon name={mode === "live" ? "mail" : "info"} size={16} />
      <div className="grow">
        <div>{mode === "live" ? "Live: cards are mailed" : "Test: nothing is mailed"}</div>
        {LOB_MODE_WORDS[mode]}
      </div>
    </div>
  );
}

/** For a business outside the US: what Lob mails, and where. Nothing for one in the US. */
export function PostcardsUsOnly() {
  const country = businessCountry(useSession().company);
  if (postcardsMailHere(country)) return null;
  return (
    <div className="callout callout-info" role="note">
      <Icon name="info" size={16} />
      <div className="grow">{postcardsUsOnly(country)}</div>
    </div>
  );
}

export function LobPanel({ app, onChanged }: { app: AppRow; onChanged: () => void }) {
  const connected = app.status !== "disconnected";
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const save = useMutation({
    meta: { inline: true, success: (res: { lob?: { mode: "test" | "live" } }) => (res.lob?.mode === "live" ? "Lob connected with a live key" : "Lob connected with a test key") },
    mutationFn: () => api.put<{ lob?: { mode: "test" | "live" } }>(`/apps/${app.id}/key`, { api_key: key.trim() }),
    onSuccess: () => {
      setKey("");
      onChanged();
    },
  });
  const typed = key.trim();
  const kind = /^live_/.test(typed) ? "live" : /^test_/.test(typed) ? "test" : null;
  return (
    <>
      <PostcardsUsOnly />
      {connected && <LobMode mode={app.lob?.mode} />}
      <Section className={kit.panel} id="app-setup" title={connected ? "Lob key" : "Connect your Lob account"}>
        <p className={kit.note}>
          {connected
            ? <>Saved: {app.account_label}. Postcard campaigns are made in <Link to="/marketing?tab=campaigns">Marketing → Campaigns</Link>. Paste a new key to replace this one.</>
            : "About three minutes. Lob prints and mails each card and bills your Lob account directly. Start with the test key to see your cards without mailing anything."}
        </p>
        {!connected && (
          <Steps>
            <Step>
              <a className="btn btn-sm" href={LOB_KEYS} target="_blank" rel="noreferrer">Open your Lob API keys <Icon name="external" size={12} /></a>
              <p className={kit.note}>No account yet? Sign up at lob.com first. Mailing for real needs a payment method in Lob.</p>
            </Step>
            <Step>Copy the <strong>secret</strong> key: the test one starts with <code>test_</code>, the live one with <code>live_</code>. Not the publishable key.</Step>
            <Step>Paste it here. Crewtavo checks it with Lob before saving, at no cost.</Step>
          </Steps>
        )}
        <form className="stack-sm" onSubmit={(e: FormEvent) => { e.preventDefault(); if (typed.length >= 10) save.mutate(); }}>
          <div className="row" style={{ gap: 8 }}>
            <div className="input-group grow">
              <input className="input" type={show ? "text" : "password"} autoComplete="off" spellCheck={false} placeholder={connected ? "Paste a new key to replace it" : "test_… or live_…"} value={key} onChange={(e) => { setKey(e.target.value); save.reset(); }} aria-label="Lob secret API key" style={{ paddingLeft: 12, paddingRight: 36 }} />
              <button type="button" className="icon-btn addon-right" style={{ position: "absolute", right: 2, pointerEvents: "auto" }} aria-label={show ? "Hide key" : "Show key"} onClick={() => setShow(!show)}><Icon name={show ? "eye" : "lock"} size={14} /></button>
            </div>
            <Button type="submit" variant="primary" loading={save.isPending} disabled={typed.length < 10}>{connected ? "Save" : "Connect"}</Button>
          </div>
          {kind && <span className="app-status" data-tone={kind === "live" ? "warning" : undefined}>{kind === "live" ? "This is a live key: cards will be mailed and charged." : "This is a test key: nothing will be mailed."}</span>}
          <FormError error={save.error} />
        </form>
      </Section>
    </>
  );
}
