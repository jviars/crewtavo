/**
 * Quo on its app page: the business's own Quo number for its texts, and that number's replies and
 * calls on clients' timelines (apps/api/src/routes/quo.ts). Not connected: the API key made in Quo,
 * checked by listing the workspace's numbers, then the number to text from. Connected: that number,
 * whether Quo's deliveries get through (the webhook Crewtavo made in Quo, with a test), the two
 * switches, and bringing in past texts and calls. When the business has its own Twilio account too,
 * Quo takes its texts over while it's connected, and both pages say so.
 */
import { TEXT_CONSENT_HINT } from "@crewtavo/core/marketing";
import { phoneDisplay } from "@crewtavo/core/phone";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Fact, Facts, Section } from "@/components/ui/Section";
import { Select } from "@/components/ui/Select";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { T, t } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import { quoImportRunning, type AppRow, type AppsData, type QuoState } from "./catalog";
import { CodeRow, Fold, Step, Steps, SwitchLine, dotted, kit } from "./PanelKit";
import { canTest, hookState, importProgress, importResult, importSince, type ImportRange, type QuoNumber } from "./quo";

/** How long a test waits for Quo's sample to arrive, and how often it looks. */
const TEST_WAIT_MS = 30_000;
const TEST_EVERY_MS = 3000;

const bold = (s: ReactNode) => <strong>{s}</strong>;

/** The number in words: its name in Quo, then the number when the name isn't the number itself. */
export const numberLabel = (n: Pick<QuoNumber, "name" | "number">) => {
  const shown = phoneDisplay(n.number);
  return n.name && n.name !== shown ? `${n.name} · ${shown}` : shown;
};

/** Puts what the server says about Quo straight on the Apps list, so a switch or a fix shows without waiting for it to be read again. */
function useKeepQuo() {
  const session = useSession();
  const queryClient = useQueryClient();
  return (quo: QuoState) =>
    queryClient.setQueryData<AppsData>(["apps", session.company.id], (data) => (data ? { ...data, apps: data.apps.map((a) => (a.id === "quo" ? { ...a, quo } : a)) } : data));
}

export function QuoPanel({ app, onChanged }: { app: AppRow; onChanged: () => void }) {
  const quo = app.quo ?? null;
  const [changingKey, setChangingKey] = useState(false);
  if (quo?.number && app.status !== "disconnected" && !changingKey) return <Connected app={app} quo={quo} onChanged={onChanged} onChangeKey={() => setChangingKey(true)} />;
  return (
    <ConnectForm
      twilio={Boolean(quo?.twilio)}
      changing={changingKey}
      onSaved={() => {
        setChangingKey(false);
        onChanged();
      }}
      onCancel={changingKey ? () => setChangingKey(false) : undefined}
    />
  );
}

/** The workspace's numbers as radio rows, each its name and number. */
function NumberChoices({ numbers, value, current, onChange }: { numbers: QuoNumber[]; value: string | null; current?: string | null; onChange: (id: string) => void }) {
  return (
    <fieldset className={kit.choices}>
      <legend className="sr-only">{t("Your Quo numbers")}</legend>
      {numbers.map((n) => {
        // A number with no name of its own in Quo is named by the number: said once.
        const shown = phoneDisplay(n.number);
        const named = Boolean(n.name) && n.name !== shown;
        const sub = dotted(named && shown, current === n.id && t("Texts go from it now"));
        return (
          <label key={n.id} className={kit.choice}>
            <input type="radio" name="quo-number" checked={value === n.id} onChange={() => onChange(n.id)} />
            <span className={kit.rowText}>
              <span className={kit.rowTitle}><span>{named ? n.name : shown}</span></span>
              {sub && <span className={kit.rowSub}>{sub}</span>}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

/** Connecting, or using another key: the key made in Quo, checked by listing its numbers, then the one to text from. */
function ConnectForm({ twilio, changing, onSaved, onCancel }: { twilio: boolean; changing: boolean; onSaved: () => void; onCancel?: () => void }) {
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const [numbers, setNumbers] = useState<QuoNumber[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const check = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<{ numbers: QuoNumber[] }>("/apps/quo/numbers", { api_key: key.trim() }),
    onSuccess: (res) => {
      setNumbers(res.numbers);
      // One number: nothing to choose.
      setPicked(res.numbers.length === 1 ? res.numbers[0]!.id : null);
    },
  });
  const connect = useMutation({
    meta: { inline: true, success: (res: { quo: QuoState }) => (res.quo.webhook.problem && res.quo.reachable ? t("Quo connected. Replies and calls need one more thing: see below.") : t("Quo connected")) },
    mutationFn: () => api.put<{ quo: QuoState }>("/apps/quo/account", { api_key: key.trim(), phone_number_id: picked }),
    onSuccess: () => {
      setKey("");
      setNumbers(null);
      onSaved();
    },
  });
  // A key changed after it was checked has to be checked again.
  const typeKey = (value: string) => {
    setKey(value);
    setNumbers(null);
    setPicked(null);
    check.reset();
    connect.reset();
  };
  return (
    <Section className={kit.panel} id="app-setup" title={changing ? t("Use a different Quo API key") : t("Connect your Quo number")}>
      {twilio && !changing && (
        <div className="callout callout-info" role="note">
          <Icon name="info" size={16} />
          <div className="grow">
            <div>{t("Your texts go out through Twilio now")}</div>
            {t("Once Quo is connected, they go out from your Quo number instead. If you disconnect Quo later, Twilio takes over again.")}
          </div>
        </div>
      )}
      <p className={kit.note}>
        {t("About five minutes. Quo charges for texts sent through its API from your workspace's prepaid credits, about a cent a segment. To text US numbers, Quo has your business registered for US texting (A2P 10DLC) first; that's done in Quo, not here.")}
      </p>
      <p className={kit.note}>{TEXT_CONSENT_HINT}</p>
      <Steps>
        <Step>
          <T text="In Quo, open <b>Workspace Settings → API</b> and click <b>Generate API key</b>. A workspace owner or admin can. Name it so you'll know it later, like crewtavo." b={bold} />
        </Step>
        <Step>
          <span>{t("Copy the key, paste it here and check it. Crewtavo asks Quo for your numbers, at no cost.")}</span>
          <form className="stack-sm" onSubmit={(e: FormEvent) => { e.preventDefault(); if (key.trim()) check.mutate(); }}>
            <Field label={t("Quo API key")} hint={t("Kept encrypted and never shown again.")}>
              <div className={kit.pasteRow}>
                <div className="input-group grow">
                  <input className="input" type={show ? "text" : "password"} value={key} onChange={(e) => typeKey(e.target.value)} autoComplete="off" spellCheck={false} maxLength={500} style={{ paddingLeft: 12, paddingRight: 36 }} />
                  <button type="button" className="icon-btn addon-right" style={{ position: "absolute", right: 2, pointerEvents: "auto" }} aria-label={show ? t("Hide key") : t("Show key")} onClick={() => setShow(!show)}><Icon name={show ? "eye" : "lock"} size={14} /></button>
                </div>
                <Button type="submit" loading={check.isPending} disabled={!key.trim()} done={Boolean(numbers)} doneLabel={t("Checked")}>{t("Check key")}</Button>
              </div>
            </Field>
            <FormError error={check.error} />
          </form>
        </Step>
        <Step>
          <span>{t("Pick the number to text from, and connect.")}</span>
          {numbers && (
            <form className={kit.form} onSubmit={(e: FormEvent) => { e.preventDefault(); if (picked) connect.mutate(); }}>
              <NumberChoices numbers={numbers} value={picked} onChange={(id) => { setPicked(id); connect.reset(); }} />
              <FormError error={connect.error} />
              <div className={kit.actions}>
                <Button type="submit" variant="primary" loading={connect.isPending} disabled={!picked}>{changing ? t("Save") : t("Connect")}</Button>
                {onCancel && <Button variant="ghost" onClick={onCancel}>{t("Cancel")}</Button>}
              </div>
            </form>
          )}
        </Step>
      </Steps>
      {!numbers && onCancel && <div className={kit.actions}><Button variant="ghost" onClick={onCancel}>{t("Cancel")}</Button></div>}
    </Section>
  );
}

function Connected({ app, quo, onChanged, onChangeKey }: { app: AppRow; quo: QuoState; onChanged: () => void; onChangeKey: () => void }) {
  return (
    <>
      <NumberSection app={app} quo={quo} onChanged={onChanged} onChangeKey={onChangeKey} />
      <DeliveriesSection quo={quo} />
      <SwitchesSection quo={quo} />
      <ImportSection quo={quo} />
    </>
  );
}

/** The number texts go from, with Change number (the kept key's numbers) and Use a different API key. */
function NumberSection({ app, quo, onChanged, onChangeKey }: { app: AppRow; quo: QuoState; onChanged: () => void; onChangeKey: () => void }) {
  const [numbers, setNumbers] = useState<QuoNumber[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const list = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<{ numbers: QuoNumber[] }>("/apps/quo/numbers", {}),
    onSuccess: (res) => {
      setNumbers(res.numbers);
      setPicked(quo.number?.id ?? null);
    },
  });
  const save = useMutation({
    meta: { inline: true, success: t("Texts go out from that number now") },
    mutationFn: () => api.put<{ quo: QuoState }>("/apps/quo/account", { phone_number_id: picked }),
    onSuccess: () => {
      setNumbers(null);
      onChanged();
    },
  });
  const stop = () => {
    setNumbers(null);
    list.reset();
    save.reset();
  };
  const number = quo.number!;
  return (
    <Section
      className={kit.panel}
      title={t("Quo number")}
      action={!numbers && <button type="button" onClick={() => list.mutate()} disabled={list.isPending}><Icon name="edit" size={14} />{t("Change number")}</button>}
    >
      {app.status === "error" && (
        <div className="callout callout-danger" role="alert">
          <Icon name="alert" size={16} />
          <div className={`grow ${kit.calloutBody}`}>
            <div>{t("Quo isn't accepting this API key anymore")}</div>
            {app.last_error && <span>{app.last_error}</span>}
            <div className={kit.actions}><Button size="sm" onClick={onChangeKey}>{t("Use a different API key")}</Button></div>
          </div>
        </div>
      )}
      {numbers ? (
        <form className={kit.form} onSubmit={(e: FormEvent) => { e.preventDefault(); if (picked && picked !== number.id) save.mutate(); }}>
          <p className={kit.label}>{t("Pick the number to text from")}</p>
          <NumberChoices numbers={numbers} value={picked} current={number.id} onChange={(id) => { setPicked(id); save.reset(); }} />
          <p className={kit.note}>{t("Replies and calls come from the new number from then on. What's already on clients' timelines stays.")}</p>
          <FormError error={save.error} />
          <div className={kit.actions}>
            <Button type="submit" variant="primary" loading={save.isPending} disabled={!picked || picked === number.id}>{t("Use this number")}</Button>
            <Button variant="ghost" onClick={stop}>{t("Cancel")}</Button>
          </div>
        </form>
      ) : (
        <>
          <Facts>
            <Fact label={t("Texts go from")}>{numberLabel(number)}</Fact>
          </Facts>
          <p className={kit.note}>{t("Reminders, on-my-way texts and the texts you send from Messages go out from this number, and show in your Quo inbox.")}</p>
          <FormError error={list.error} />
          <div className={kit.actions}>
            <Button size="sm" variant="ghost" onClick={onChangeKey}>{t("Use a different API key")}</Button>
          </div>
        </>
      )}
    </Section>
  );
}

/**
 * Whether Quo's deliveries (replies, texts sent from the Quo app, failures and calls) get through:
 * the webhook Crewtavo made in Quo, what's in its way, and a test that asks Quo for a sample and
 * looks for it every few seconds.
 */
function DeliveriesSection({ quo }: { quo: QuoState }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const keepQuo = useKeepQuo();
  const state = hookState(quo);
  const setUp = useMutation({
    meta: { inline: true, success: t("Quo sends replies and calls here now") },
    mutationFn: () => api.post<{ quo: QuoState }>("/apps/quo/webhook"),
    onSuccess: (res) => keepQuo(res.quo),
    // A problem is kept on the integration too: read it back to show it.
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["apps", session.company.id] }),
  });
  // A test asked for: what heard_at was then, and until when to look.
  const [testing, setTesting] = useState<{ before: string | null; until: number } | null>(null);
  const [tested, setTested] = useState<"arrived" | "missing" | null>(null);
  const test = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<{ sent: boolean; asked_at: string }>("/apps/quo/test"),
    onMutate: () => setTested(null),
    onSuccess: () => setTesting({ before: quo.heard_at, until: Date.now() + TEST_WAIT_MS }),
  });
  useEffect(() => {
    if (!testing) return;
    if (quo.heard_at && quo.heard_at !== testing.before) {
      setTesting(null);
      setTested("arrived");
      return;
    }
    const look = setInterval(() => {
      if (Date.now() > testing.until) {
        setTesting(null);
        setTested("missing");
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ["apps", session.company.id] });
    }, TEST_EVERY_MS);
    return () => clearInterval(look);
  }, [testing, quo.heard_at, queryClient, session.company.id]);
  const testButton = canTest(quo) && (
    <Button size="sm" loading={test.isPending || Boolean(testing)} onClick={() => test.mutate()}>{testing ? t("Waiting for Quo…") : t("Send a test")}</Button>
  );

  return (
    <Section className={kit.panel} title={t("Replies and calls")}>
      {state === "unreachable" && (
        <div className="callout callout-info" role="note">
          <Icon name="info" size={16} />
          <div className="grow">{t("Quo only sends replies and calls to a public https address, and this Crewtavo doesn't have one yet. Texts still go out from your Quo number.")}</div>
        </div>
      )}
      {state === "problem" && (
        <div className="callout callout-danger" role="alert">
          <Icon name="alert" size={16} />
          <div className={`grow ${kit.calloutBody}`}>
            <div>{t("Replies and calls can't come in yet")}</div>
            <span>{quo.webhook.problem}</span>
            <div className={kit.actions}><Button size="sm" loading={setUp.isPending} onClick={() => setUp.mutate()}>{t("Try again")}</Button></div>
          </div>
        </div>
      )}
      {state === "moved" && (
        <div className="callout callout-warning" role="alert">
          <Icon name="alert" size={16} />
          <div className={`grow ${kit.calloutBody}`}>
            <div>{t("This Crewtavo's address changed")}</div>
            <span>{t("Quo still sends replies and calls to the old one. Update it in Quo to have them come here.")}</span>
            <div className={kit.actions}><Button size="sm" variant="primary" loading={setUp.isPending} onClick={() => setUp.mutate()}>{t("Update in Quo")}</Button></div>
          </div>
        </div>
      )}
      {state === "unset" && (
        <div className={kit.statusLine}>
          <span className={kit.note}>{t("Quo isn't sending replies and calls here yet.")}</span>
          <Button size="sm" variant="primary" loading={setUp.isPending} onClick={() => setUp.mutate()}>{t("Set it up in Quo")}</Button>
        </div>
      )}
      {state === "working" && (
        <div className={kit.statusLine}>
          <span className="app-status">
            <Icon name="check" size={16} />
            {quo.calls
              ? t("Replies, texts sent from the Quo app and calls come in. Last heard from Quo {when}.", { when: timeAgo(quo.heard_at!) })
              : t("Replies and texts sent from the Quo app come in. Last heard from Quo {when}.", { when: timeAgo(quo.heard_at!) })}
          </span>
          {testButton}
        </div>
      )}
      {state === "waiting" && (
        <div className={kit.statusLine}>
          <span className={kit.note}>{t("Set up in Quo. Nothing has come in through it yet: send a test to see that it gets through.")}</span>
          {testButton}
        </div>
      )}
      {tested === "arrived" && (
        <div className="callout callout-good" role="status">
          <Icon name="check" size={16} />
          <div className="grow">{t("Quo's test arrived. Replies and calls come in here.")}</div>
        </div>
      )}
      {tested === "missing" && (
        <div className="callout callout-warning" role="alert">
          <Icon name="alert" size={16} />
          <div className={`grow ${kit.calloutBody}`}>
            <div>{t("Quo's test didn't arrive in 30 seconds")}</div>
            <span>{t("Quo may still be trying. Send another in a minute, or set it up in Quo again.")}</span>
            <div className={kit.actions}><Button size="sm" loading={setUp.isPending} onClick={() => setUp.mutate()}>{t("Set it up again")}</Button></div>
          </div>
        </div>
      )}
      {/* A failed setup is kept with Quo's state, and its callout above says it already. */}
      <FormError error={test.error ?? (state === "problem" ? null : setUp.error)} />
      <Fold summary={t("The address Quo sends to")}>
        <CodeRow value={quo.webhook.url} name={t("Address for Quo's deliveries")} done={t("Address copied")} />
        <p className={kit.note}>
          <T text="Crewtavo sets this up in Quo for you, as a webhook named Crewtavo under <b>Workspace Settings → Webhooks</b>. Don't add it there yourself: Quo signs what it sends with a key only the webhook Crewtavo made knows." b={bold} />
        </p>
      </Fold>
    </Section>
  );
}

/** Calls on timelines, and automatic texts out of Quo's inbox. */
function SwitchesSection({ quo }: { quo: QuoState }) {
  const keepQuo = useKeepQuo();
  const save = useMutation({
    meta: { inline: true },
    mutationFn: (change: { calls?: boolean; quiet?: boolean }) => api.patch<{ quo: QuoState }>("/apps/quo/settings", change),
    onSuccess: (res) => keepQuo(res.quo),
  });
  // While a change is on its way, its switch shows where it's going.
  const calls = save.isPending && save.variables?.calls !== undefined ? save.variables.calls : quo.calls;
  const quiet = save.isPending && save.variables?.quiet !== undefined ? save.variables.quiet : quo.quiet;
  return (
    <Section className={kit.panel} title={t("Calls and your Quo inbox")}>
      <SwitchLine
        label={t("Put calls on client timelines")}
        checked={calls}
        disabled={save.isPending}
        onChange={(on) => save.mutate({ calls: on })}
        hint={<T text="Answered and missed calls and voicemails on your Quo number, with Quo's summary, next steps and the voicemail's words when your Quo plan has them. Missed calls and voicemails from numbers that aren't clients wait under <link>Unknown numbers</link> in Messages." link={(s) => <Link to="/messages" style={{ textDecoration: "underline" }}>{s}</Link>} />}
      />
      <SwitchLine
        label={t("Keep automatic texts out of your Quo inbox")}
        checked={quiet}
        disabled={save.isPending}
        onChange={(on) => save.mutate({ quiet: on })}
        hint={t("Reminders, on-my-way texts and other texts Crewtavo sends by itself go to Quo's Done view. A reply reopens the conversation.")}
      />
      <FormError error={save.error} />
    </Section>
  );
}

/** Bringing in the number's past texts and calls, in the background, with its progress while it runs. */
function ImportSection({ quo }: { quo: QuoState }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [range, setRange] = useState<ImportRange>("12m");
  const start = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post("/apps/quo/import", { since: importSince(range) }),
    // The Apps list follows it every few seconds while it runs (appsPollMs).
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["apps", session.company.id] }),
  });
  const state = quo.import;
  const running = quoImportRunning(state);
  return (
    <Section className={kit.panel} title={t("Bring in past texts and calls")}>
      <p className={kit.note}>
        {t("Texts and calls from your Quo number's history go on the timelines of the clients they were with. Nobody is texted, and it's safe to run again: nothing is added twice.")}
      </p>
      {running ? (
        <span className="app-status" role="status">
          <span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" />
          {t("Bringing them in…")} {importProgress(state!)}
        </span>
      ) : (
        <div className="row wrap" style={{ gap: 8 }}>
          <Select className="select grow" style={{ maxWidth: 320 }} value={range} onChange={(e) => setRange(e.target.value as ImportRange)} aria-label={t("How far back")}>
            <option value="3m">{t("Last 3 months")}</option>
            <option value="12m">{t("Last 12 months")}</option>
            <option value="all">{t("Everything Quo has")}</option>
          </Select>
          <Button icon="download" loading={start.isPending} onClick={() => start.mutate()}>{state ? t("Bring in again") : t("Bring them in")}</Button>
        </div>
      )}
      {state?.status === "done" && (
        <p className={kit.note} role="status">
          {state.finished_at ? t("Done {when}.", { when: timeAgo(state.finished_at) }) : t("Done.")} {importResult(state)}
        </p>
      )}
      {state?.status === "failed" && <span className="field-error">{t("It stopped: {problem} Start it again; anything already brought in is kept.", { problem: sentence(state.error) })}</span>}
      {state?.status === "running" && state.stopped && <span className="field-error">{t("It stopped partway, as the server restarted. Start it again; anything already brought in is kept.")}</span>}
      <FormError error={start.error} />
    </Section>
  );
}

/** Quo's or the server's words as a sentence of their own: ending in a full stop. */
const sentence = (words: string | undefined) => {
  const text = (words ?? "").trim() || t("something went wrong.");
  return /[.!?]$/.test(text) ? text : `${text}.`;
};
