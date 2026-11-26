/**
 * Twilio on its app page: the business's own Twilio account, so texting works without anyone
 * setting up the server. Step by step to find the Account SID, Auth Token and number in Twilio; all
 * three are checked with Twilio before they're kept (the token encrypted, never shown again). Once
 * connected: the number texts go from, the address Twilio needs for incoming texts, and a button
 * that sets it on the number. A Crewtavo whose server was given a Twilio account works without any
 * of this, and says so. With Quo connected too, texts go through Quo instead, which this says first.
 */
import { TEXT_CONSENT_HINT } from "@crewtavo/core/marketing";
import { phoneExample } from "@crewtavo/core/phone";
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Fact, Facts, Section } from "@/components/ui/Section";
import { api } from "@/lib/api";
import { companyCountry } from "@/lib/format";
import { T, t } from "@/lib/i18n";
import { formatPhoneTyping } from "@/lib/validate";
import type { AppRow, TwilioState } from "./catalog";
import { CodeRow, Fold, Step, Steps, kit } from "./PanelKit";

const TWILIO_CONSOLE = "https://console.twilio.com/";
const TWILIO_NUMBERS = "https://console.twilio.com/us1/develop/phone-numbers/manage/incoming";

export function TwilioPanel({ app, onChanged }: { app: AppRow; onChanged: () => void }) {
  const state = app.twilio ?? null;
  const [changing, setChanging] = useState(false);
  const quo = state?.quo ? <QuoTakesOver /> : null;
  if (state?.own && app.status !== "disconnected" && !changing) return <>{quo}<Connected app={app} state={state} onChanged={onChanged} onChange={() => setChanging(true)} /></>;
  return (
    <>
      {quo}
      {state?.server && (
        <section className="callout callout-good" aria-label="Texting through this server">
          <Icon name="check" size={16} />
          <div className="grow">
            <div>Texts go out from the Twilio number set up for this server</div>
            Nothing to do here. To text from your own number instead, connect your Twilio account below.
          </div>
        </section>
      )}
      <ConnectForm
        app={app}
        changing={changing || Boolean(state?.own)}
        optional={Boolean(state?.server)}
        onSaved={() => {
          setChanging(false);
          onChanged();
        }}
        onCancel={changing ? () => setChanging(false) : undefined}
      />
    </>
  );
}

/** Quo is connected too: every text goes from its number while it is, and Twilio's take over again once it's disconnected. */
function QuoTakesOver() {
  return (
    <section className="callout callout-info" aria-label={t("Texting through Quo")}>
      <Icon name="info" size={16} />
      <div className="grow">
        <div>{t("Your texts go through Quo now")}</div>
        <T text="While Quo is connected (<link>Apps → Quo</link>), texts go out from your Quo number. If you disconnect Quo, Twilio takes over again." link={(s: ReactNode) => <Link to="/apps/quo">{s}</Link>} />
      </div>
    </section>
  );
}

function ConnectForm({ app, changing, optional, onSaved, onCancel }: { app: AppRow; changing: boolean; optional: boolean; onSaved: () => void; onCancel?: () => void }) {
  const [f, setF] = useState({ account_sid: "", auth_token: "", from_number: "" });
  const [show, setShow] = useState(false);
  const save = useMutation({
    meta: { inline: true, success: (res: { trial?: boolean }) => (res.trial ? "Twilio connected. A trial account only texts numbers you've verified in Twilio." : "Twilio connected") },
    mutationFn: () => api.put<{ trial?: boolean }>(`/apps/${app.id}/account`, { account_sid: f.account_sid.trim(), auth_token: f.auth_token.trim(), from_number: f.from_number.trim() }),
    onSuccess: () => {
      setF({ account_sid: "", auth_token: "", from_number: "" });
      onSaved();
    },
  });
  const set = (patch: Partial<typeof f>) => {
    setF({ ...f, ...patch });
    save.reset();
  };
  return (
    <Section className={kit.panel} id="app-setup" title={changing ? "Change your Twilio account" : optional ? "Use your own Twilio account" : "Connect your Twilio account"}>
      <p className={kit.note}>
        About five minutes once you have a Twilio number. Twilio bills you directly for the texts you send, a fraction of a cent to a few cents each. To text US numbers from a US number,
        Twilio also asks you to register your business first (A2P 10DLC), which can take a few days; texting numbers in other countries doesn't need it.
      </p>
      <p className={kit.note}>{TEXT_CONSENT_HINT}</p>
      <Steps>
        <Step>
          <a className="btn btn-sm" href={TWILIO_CONSOLE} target="_blank" rel="noreferrer">Open your Twilio console <Icon name="external" size={12} /></a>
          <p className={kit.note}>No account yet? Sign up there, then buy a phone number that can send SMS.</p>
        </Step>
        <Step>On the console's first page, under <strong>Account Info</strong>, copy the <strong>Account SID</strong> and the <strong>Auth Token</strong> (click the eye to show it).</Step>
        <Step>Copy your number from <a href={TWILIO_NUMBERS} target="_blank" rel="noreferrer">Phone Numbers → Active numbers</a>.</Step>
        <Step>Paste all three here. Crewtavo checks them with Twilio before saving, at no cost.</Step>
      </Steps>
      <form className="stack-sm" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <div className="form-grid">
          <Field label="Account SID" hint="Starts with AC." requiredMessage="Paste your Account SID.">
            <input className="input" value={f.account_sid} onChange={(e) => set({ account_sid: e.target.value.trim() })} autoComplete="off" spellCheck={false} maxLength={60} required placeholder="AC…" />
          </Field>
          <Field label="Your Twilio number" requiredMessage="Enter your Twilio number.">
            <input className="input" type="tel" value={f.from_number} onChange={(e) => set({ from_number: formatPhoneTyping(e.target.value) })} maxLength={40} required placeholder={phoneExample(companyCountry()) ?? "(555) 555-0123"} />
          </Field>
        </div>
        <Field label="Auth Token" hint="Stored encrypted and never shown again." requiredMessage="Paste your Auth Token.">
          <div className="input-group">
            <input className="input" type={show ? "text" : "password"} value={f.auth_token} onChange={(e) => set({ auth_token: e.target.value })} autoComplete="off" spellCheck={false} maxLength={200} required style={{ paddingRight: 36 }} />
            <button type="button" className="icon-btn addon-right" style={{ position: "absolute", right: 2, pointerEvents: "auto" }} aria-label={show ? "Hide token" : "Show token"} onClick={() => setShow(!show)}><Icon name={show ? "eye" : "lock"} size={14} /></button>
          </div>
        </Field>
        <FormError error={save.error} />
        <div className="row wrap" style={{ gap: 8 }}>
          <FormChecks />
          <Button type="submit" variant="primary" loading={save.isPending}>{changing ? "Save" : "Connect"}</Button>
          {onCancel && <Button onClick={onCancel}>Cancel</Button>}
        </div>
      </form>
    </Section>
  );
}

function Connected({ app, state, onChanged, onChange }: { app: AppRow; state: TwilioState; onChanged: () => void; onChange: () => void }) {
  const point = useMutation({
    meta: { inline: true, success: "Incoming texts now come to Crewtavo" },
    mutationFn: () => api.post(`/apps/${app.id}/webhook`),
    onSuccess: onChanged,
  });
  return (
    <>
      <Section className={kit.panel} title="Twilio account" action={<button type="button" onClick={onChange}><Icon name="edit" size={14} />Change account</button>}>
        {app.status === "error" && (
          <div className="callout callout-danger" role="alert">
            <Icon name="alert" size={16} />
            <div className="grow"><div>Twilio isn't accepting this account anymore</div>{app.last_error}</div>
          </div>
        )}
        {app.status !== "error" && app.last_error && <span className="field-error">{app.last_error}</span>}
        <Facts>
          <Fact label="Connected to">{app.status !== "error" && (app.account_label ?? "Connected")}</Fact>
        </Facts>
        <p className={kit.note}>Reminders, on-my-way texts and the texts you send from Messages go out from this number.</p>
      </Section>
      <Section className={kit.panel} title="Replies from clients">
        {state.webhook_set ? (
          <span className="app-status"><Icon name="check" size={16} />Texts to your number come into Messages, and STOP is honoured.</span>
        ) : (
          <>
            <p className={kit.note}>
              For replies to land in Messages, your Twilio number has to send incoming texts to this address.
              {state.other_webhook ? <> Right now it sends them to <span style={{ overflowWrap: "anywhere" }}>{state.other_webhook}</span>, which this would replace.</> : null}
            </p>
            {state.reachable ? (
              <Button variant="primary" loading={point.isPending} onClick={() => point.mutate()}>Set it up for me</Button>
            ) : (
              <div className="callout callout-warning" role="note">
                <Icon name="alert" size={16} />
                <div className="grow">Twilio can only reach a public https address, and this Crewtavo doesn't have one yet. Texts still go out.</div>
              </div>
            )}
            <FormError error={point.error} />
          </>
        )}
        <Fold summary={state.webhook_set ? "The address Twilio uses" : "Or set it yourself in Twilio"}>
          <CodeRow value={state.webhook_url} name="Address for incoming texts" done="Address copied" />
          <p className={kit.note}>In Twilio, open <a href={TWILIO_NUMBERS} target="_blank" rel="noreferrer">Phone Numbers → Active numbers</a>, click your number, and under <strong>Messaging configuration</strong> set <strong>A message comes in</strong> to Webhook, this address, HTTP POST. Then save.</p>
        </Fold>
      </Section>
    </>
  );
}
