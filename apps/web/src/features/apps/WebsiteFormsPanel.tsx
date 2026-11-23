/**
 * Crewtavo - Website Forms on its Apps page, the way Formspree works. Install makes a form with its
 * own address: put the address in the action of the form on your website (or paste a form that's
 * ready to go), and each message lands in Requests and the inboxes listed here. Uninstall stops
 * taking messages and keeps every form, its address and its requests (routes/websiteForms.ts).
 *
 * Crewtavo - Careers uses the same page for its careers forms (kind "careers"): each application
 * lands in Applicants, résumé and all, instead of Requests.
 *
 * Keep bots out, on each form: the hidden field and the limits every form has, and on top of them
 * Crewtavo's own check (one line on the website) or Cloudflare Turnstile (the business's own keys,
 * whose secret key is tested before they're saved). A check that's on only watches: the card says
 * when a message last came through with it and how many came without, and it's the owner's or
 * admin's own button that makes the form start refusing those, once a test has come through.
 */
import { exampleApplicationForm } from "@crewtavo/core/careers";
import { botCheckLines, exampleForm, type BotCheck } from "@crewtavo/core/websiteForms";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { Button, cx, Spinner, useJustDone } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Field } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Section } from "@/components/ui/Section";
import { SectionSkeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { formatDate, timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { CodeBlock, CodeRow, Fold, kit, Step, Steps } from "./PanelKit";
import styles from "./WebsiteFormsPanel.module.css";

export interface WebsiteForm {
  id: string;
  key: string;
  name: string;
  email_to: string[];
  redirect_url: string | null;
  allowed_sites: string[];
  /** What keeps bots out beyond the hidden field. Older servers leave these seven out. */
  bot_check?: BotCheck;
  /** When a message last came through with the check. */
  bot_check_passed_at?: string | null;
  /** Messages kept while the check was on that came without it, and when the last one was. */
  bot_check_missed?: number;
  bot_check_missed_at?: string | null;
  /** Refusing messages without the check since then; null while it only watches. */
  bot_check_armed_at?: string | null;
  bots_blocked?: number;
  last_blocked_at?: string | null;
  created_at: string;
  /** Where the form sends: https://<this Crewtavo>/f/<key>. */
  url: string;
  last_message_at: string | null;
}

export type FormKind = "contact" | "careers";

export interface WebsiteFormsSetup {
  enabled: boolean;
  /** Whether this Crewtavo can send email: without it, messages only show in Requests. */
  email_ready: boolean;
  /** The business has a promo code turned on, so the form to paste has a box for one. Older servers leave it out. */
  promo_codes?: boolean;
  /** The business's Turnstile site key, once it saved its keys (for all its forms). */
  turnstile_site_key?: string | null;
  /** The keys are saved, but this Crewtavo can't read the secret one any more: nothing is checked until they're entered again. */
  turnstile_keys_unreadable?: boolean;
  forms: WebsiteForm[];
}

export function useWebsiteFormsSwitch(kind: FormKind = "contact") {
  const session = useSession();
  const queryClient = useQueryClient();
  const careers = kind === "careers";
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.post<{ enabled: boolean }>("/website-forms/enabled", { enabled, kind }),
    onSuccess: async (res) => {
      // Careers adds Applicants to the sidebar, from the company's settings.
      if (careers) await session.refresh();
      await queryClient.invalidateQueries({ queryKey: ["apps"] });
      queryClient.invalidateQueries({ queryKey: ["website-forms"] });
      return res;
    },
    meta: { success: (res: { enabled: boolean }) => (res.enabled ? null : careers ? "Careers uninstalled" : "Website Forms uninstalled") },
  });
  const turnOff = async () => {
    const ok = await confirm({
      title: careers ? "Uninstall Careers?" : "Uninstall Website Forms?",
      body: careers
        ? "Your website's Apply form stops sending to Crewtavo right away, and people who fill it in are told it wasn't sent. Applicants leaves the sidebar, but every applicant and résumé is kept and every form keeps its address, so installing it again picks up where you left off."
        : "Forms on your website stop sending to Crewtavo right away, and people who fill one in are told it wasn't sent. Every form keeps its address and its messages stay in Requests, so installing it again picks up where you left off.",
      confirmLabel: "Uninstall",
      danger: true,
    });
    if (ok) toggle.mutate(false);
  };
  return { toggle, turnOff };
}

const list = (text: string) => text.split(/[,\s;]+/).map((s) => s.trim()).filter(Boolean);

/** Installed: each form's address, who gets its email, and the rest of its settings. */
export function WebsiteFormsPanel({ kind = "contact" }: { kind?: FormKind }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const careers = kind === "careers";
  const setup = useQuery({
    queryKey: ["website-forms", session.company.id, kind],
    queryFn: () => api.get<WebsiteFormsSetup>(careers ? "/website-forms?kind=careers" : "/website-forms"),
    // Until the first message arrives, look again every few seconds, so a test from the website shows here.
    // The same while a form's bot check waits for a test to come through with it.
    refetchInterval: (q) => {
      const forms = q.state.data?.forms ?? [];
      const waiting = forms.some((f) => (f.bot_check ?? "off") !== "off" && !f.bot_check_passed_at);
      return forms.length && (waiting || !forms.some((f) => f.last_message_at)) ? 10_000 : false;
    },
  });
  const [adding, setAdding] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: (name: string) => api.post<WebsiteForm>("/website-forms", { name, kind }),
    onSuccess: () => {
      setAdding(null);
      queryClient.invalidateQueries({ queryKey: ["website-forms"] });
    },
    meta: { success: "Form added" },
  });

  if (setup.error) return <ErrorState error={setup.error} onRetry={() => setup.refetch()} />;
  if (!setup.data) return <div aria-busy="true" aria-label="Loading"><SectionSkeleton rows={3} /></div>;
  const { forms, email_ready, promo_codes = false, turnstile_site_key: siteKey = null, turnstile_keys_unreadable: keysUnreadable = false } = setup.data;
  const submitAdd = (e: FormEvent) => {
    e.preventDefault();
    if (adding?.trim()) add.mutate(adding.trim());
  };

  return (
    <>
      {!email_ready && (
        <div className="callout callout-warning" role="status">
          <Icon name="mail" size={16} />
          <div className="grow">
            Email isn't set up in Crewtavo yet, so {careers ? "applications only show in Applicants" : "messages only show in Requests"}. <Link to="/settings?tab=email" className="strong">Connect your email</Link> to get each one in your inbox too.
          </div>
        </div>
      )}
      {forms.map((form, i) => <FormCard key={form.id} form={form} first={i === 0} kind={kind} promoBox={promo_codes} siteKey={siteKey} keysUnreadable={keysUnreadable} />)}
      <Section id="website-forms-add" title={forms.length ? "Another form" : "Add a form"} className={kit.panel}>
        <p className={kit.note}>
          {careers
            ? "One for each website, or a separate one for seasonal hiring: each gets its own address and its own people to email."
            : "A quote form and a contact form, or one for each website: each gets its own address, and its name on each request."}
        </p>
        {adding === null ? (
          <div className={kit.actions}><Button icon="plus" onClick={() => setAdding("")}>Add a form</Button></div>
        ) : (
          <form className={styles.addForm} onSubmit={submitAdd}>
            <input className="input" autoFocus maxLength={80} placeholder={careers ? "Seasonal crew" : "Quote form"} aria-label="The new form's name" value={adding} onChange={(e) => setAdding(e.target.value)} />
            <Button type="submit" variant="primary" loading={add.isPending} disabled={!adding.trim()}>Add</Button>
            <Button variant="ghost" onClick={() => setAdding(null)}>Cancel</Button>
          </form>
        )}
      </Section>
    </>
  );
}

/**
 * One form, as a section of its own: whether messages are coming, how to point a website's form at
 * it (in steps, each value with Copy), a form to paste, who gets its email, keeping bots out and the
 * rest of its settings. Copying, a new address and deleting it are in its menu.
 */
function FormCard({ form, first, kind, promoBox, siteKey, keysUnreadable }: { form: WebsiteForm; first: boolean; kind: FormKind; promoBox: boolean; siteKey: string | null; keysUnreadable: boolean }) {
  const careers = kind === "careers";
  const queryClient = useQueryClient();
  const [name, setName] = useState(form.name);
  const [emails, setEmails] = useState(form.email_to.join(", "));
  const [ownPage, setOwnPage] = useState(Boolean(form.redirect_url));
  const [redirect, setRedirect] = useState(form.redirect_url ?? "");
  const [sites, setSites] = useState(form.allowed_sites.join(", "));
  const savedCheck: BotCheck = form.bot_check ?? "off";
  const [check, setCheck] = useState<BotCheck>(savedCheck);
  // Removing the Turnstile keys turns the check off on the server, for every form that used it.
  useEffect(() => setCheck(savedCheck), [savedCheck]);
  // Turnstile can't be saved for a form until the business's keys are (saving the keys saves it, below).
  const checkReady = check !== "turnstile" || (Boolean(siteKey) && !keysUnreadable);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["website-forms"] });

  const changes = {
    ...(name.trim() !== form.name ? { name: name.trim() } : {}),
    ...(list(emails).join(",") !== form.email_to.join(",") ? { email_to: list(emails) } : {}),
    ...((ownPage ? redirect.trim() : "") !== (form.redirect_url ?? "") ? { redirect_url: ownPage ? redirect.trim() || null : null } : {}),
    ...(list(sites).join(",") !== form.allowed_sites.join(",") ? { allowed_sites: list(sites) } : {}),
    ...(check !== savedCheck && checkReady ? { bot_check: check } : {}),
  };
  const dirty = Object.keys(changes).length > 0;
  const save = useMutation({
    mutationFn: () => api.patch<WebsiteForm>(`/website-forms/${form.id}`, changes),
    onSuccess: (saved) => {
      // In one spelling, as it was saved: greenlawn.com for https://www.greenlawn.com/contact.
      setEmails(saved.email_to.join(", "));
      setSites(saved.allowed_sites.join(", "));
      setRedirect(saved.redirect_url ?? "");
      setOwnPage(Boolean(saved.redirect_url));
      refresh();
    },
  });
  const newAddress = useMutation({
    mutationFn: () => api.post<WebsiteForm>(`/website-forms/${form.id}/address`),
    onSuccess: () => {
      toast.success("New address made", {
        description: savedCheck === "script" ? "Put it in your form's action, and swap the check's line for the new one: it has the address in it." : savedCheck === "turnstile" ? "Put it in your form's action. The check refuses nothing until you say so again." : "Put it in your form's action.",
      });
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/website-forms/${form.id}`),
    onSuccess: refresh,
    meta: { success: `${form.name} deleted` },
  });
  const justSaved = useJustDone(save);

  // A careers form sends its résumé along: multipart, or the file never leaves the browser.
  const opening = careers ? `<form action="${form.url}" method="POST" enctype="multipart/form-data">` : `<form action="${form.url}" method="POST">`;
  // The form to paste comes with the check that's chosen, once it can be used.
  const exampleCheck = { botCheck: checkReady ? check : "off", siteKey } as const;
  const example = careers ? exampleApplicationForm(form.url, exampleCheck) : exampleForm(form.url, { promo: promoBox, ...exampleCheck });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (dirty) save.mutate();
  };
  const askNewAddress = async () => {
    const ok = await confirm({
      title: `Get a new address for ${form.name}?`,
      body: "The address on your website stops taking messages right away. Put the new one in your form's action straight after. Use this when bots have found your form."
        + (savedCheck === "script" ? " The check's line on your website has the address in it too, so swap that for the new line. Until a test comes through with it and you say so again, nothing is refused." : savedCheck === "turnstile" ? " The check starts over with it: nothing is refused until a test comes through and you say so again." : ""),
      confirmLabel: "Get a new address",
    });
    if (ok) newAddress.mutate();
  };
  const askDelete = async () => {
    const ok = await confirm({
      title: `Delete ${form.name}?`,
      body: careers ? "Its address stops taking applications right away. The applicants it brought in stay in Applicants." : "Its address stops taking messages right away. The messages it already sent stay in Requests.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (ok) remove.mutate();
  };
  const more: MenuEntry[] = [
    { label: "Copy the address", icon: "copy", kbd: "C", onSelect: () => copyText(form.url, "Address copied") },
    { label: "Copy a form to paste", icon: "code", onSelect: () => copyText(example, "Form copied") },
    { separator: true },
    { label: "Get a new address", icon: "refresh", description: "When bots have found your form", disabled: newAddress.isPending, onSelect: askNewAddress },
    { separator: true },
    { label: "Delete form", icon: "trash", danger: true, disabled: remove.isPending, onSelect: askDelete },
  ];

  return (
    <Section id={first ? "app-setup" : undefined} title={form.name} className={kit.panel} action={<Menu items={more} label={`More for ${form.name}`} title={form.name} />}>
      <div className={styles.status} role="status">
        <StatusPill label={form.last_message_at ? (careers ? "Taking applications" : "Taking messages") : careers ? "Waiting for an application" : "Waiting for a message"} tone={form.last_message_at ? "good" : "pending"} />
        <span className={kit.note}>
          {form.last_message_at
            ? careers
              ? <>Last application {timeAgo(form.last_message_at)}. <Link to="/applicants">See them in Applicants</Link></>
              : <>Last message {timeAgo(form.last_message_at)}. <Link to="/requests?from=website">See them in Requests</Link></>
            : <>Send a test from your website once the address is in your form. It shows up here and in {careers ? "Applicants" : "Requests"} within seconds.</>}
        </span>
        {(newAddress.isPending || remove.isPending) && <Spinner size={14} label={remove.isPending ? "Deleting" : "Making a new address"} />}
      </div>

      <Steps label="Point your website's form here">
        <Step>
          <span>Point your form at this address.</span>
          <CodeRow label="Address" value={form.url} name="The form's address" done="Address copied" />
        </Step>
        <Step>
          <span>
            In your website's form, set the <code className={kit.code}>action</code> to it and the <code className={kit.code}>method</code> to POST{careers && <>, with <code className={kit.code}>enctype="multipart/form-data"</code> so résumés come along</>}:
          </span>
          <CodeRow label="First line" value={opening} name="Your form's first line" />
          {careers ? (
            <p className={kit.note}>
              Fields named <strong>name</strong>, <strong>email</strong>, <strong>phone</strong>, <strong>position</strong>, <strong>start_date</strong>, <strong>availability</strong>, <strong>pay</strong>, <strong>experience</strong>, <strong>drivers_license</strong>, <strong>location</strong> and <strong>message</strong> fill in the applicant, in the usual spellings of each.
              Anything else your form asks comes along too. A file field named <strong>resume</strong> is their résumé: up to 3 files of 10 MB each, PDF, Word or a photo. <code className={kit.code}>_gotcha</code>, <code className={kit.code}>_subject</code> and <code className={kit.code}>_next</code> work as they do with Formspree. <code className={kit.code}>_next</code> only goes to your own website: the one in Settings → Company, your thank-you page's, or one you only take messages from.
            </p>
          ) : (
            <p className={kit.note}>
              Fields named <strong>name</strong>, <strong>email</strong>, <strong>phone</strong>, <strong>address</strong> and <strong>message</strong> fill in the client and the request.
              A field named <strong>promo</strong>, <strong>promo_code</strong>, <strong>promocode</strong>, <strong>coupon</strong>, <strong>coupon_code</strong> or <strong>discount_code</strong> (in any case, with spaces or dashes too) is checked as a promo code. A valid one is ready to apply on the quote.
              Anything else your form asks comes along with the message. Moving from Formspree? Change the action to this address: <code className={kit.code}>_gotcha</code>, <code className={kit.code}>_subject</code>, <code className={kit.code}>_next</code> and <code className={kit.code}>_replyto</code> work the same. <code className={kit.code}>_next</code> only goes to your own website: the one in Settings → Company, your thank-you page's, or one you only take messages from.
            </p>
          )}
        </Step>
      </Steps>

      <Fold summary="Need a form? Copy one that's ready to paste">
        <CodeBlock code={example} what="A form to paste" done="Form copied" />
        <p className={kit.note}>Paste it where the form should go, in your site builder's HTML or Code block. It takes your website's own fonts and colors.</p>
      </Fold>

      <form className={kit.form} onSubmit={submit}>
        <Field
          label={careers ? "Email each application to" : "Email each message to"}
          hint={careers
            ? "Up to 5 addresses, separated by commas. Reply to the email to answer the applicant; their résumé stays in Crewtavo. Leave it empty to only see applications in Applicants."
            : "Up to 5 addresses, separated by commas. Reply to the email to answer whoever sent it. Leave it empty to only see messages in Requests."}
        >
          <input className="input" type="text" inputMode="email" autoComplete="off" spellCheck={false} placeholder="office@greenlawn.com" value={emails} onChange={(e) => setEmails(e.target.value)} />
        </Field>

        <div className={styles.folds}>
          <BotCheckSettings form={form} careers={careers} check={check} onCheck={setCheck} siteKey={siteKey} keysUnreadable={keysUnreadable} />

          <Fold summary="More settings">
            <Field label="Form name" hint={careers ? "Shown on each applicant it brings in, for the people who set up apps." : "Each request from it is called this, unless the form sends a _subject."}>
              <input className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="After someone sends it">
              <div className={styles.after}>
                <div className="segmented" role="group" aria-label="After someone sends it">
                  <button type="button" aria-pressed={!ownPage} onClick={() => setOwnPage(false)}>A thank-you page from Crewtavo</button>
                  <button type="button" aria-pressed={ownPage} onClick={() => setOwnPage(true)}>My own page</button>
                </div>
                {ownPage && (
                  <input className="input" type="text" inputMode="url" spellCheck={false} placeholder="https://greenlawn.com/thanks" aria-label="Your thank-you page's address" value={redirect} onChange={(e) => setRedirect(e.target.value)} />
                )}
              </div>
            </Field>
            <Field label="Only take messages from" optional hint="Your website, like greenlawn.com, so a copy of your form somewhere else can't send to Crewtavo. Leave it empty to take messages from any website.">
              <input className="input" type="text" inputMode="url" autoComplete="off" spellCheck={false} placeholder="greenlawn.com" value={sites} onChange={(e) => setSites(e.target.value)} />
            </Field>
          </Fold>
        </div>

        <div className={kit.save}>
          <Button type="submit" loading={save.isPending} done={justSaved} disabled={!dirty && !justSaved}>Save changes</Button>
          {dirty && !save.isPending && <span className={kit.saveNote}>Unsaved changes</span>}
        </div>
      </form>
    </Section>
  );
}

const CHECK_NAMES: Record<BotCheck, string> = { off: "Hidden field only", script: "Crewtavo's check", turnstile: "Cloudflare Turnstile" };

/** What each choice stops and what it needs, said plainly. */
const CHECK_NOTES: Record<BotCheck, string> = {
  off: "Nothing to add to your website. A bot that leaves the hidden field empty and stays under the limits still gets through.",
  script: "One line added to your website, and no account. It stops bots that don't run a real browser, which is most of them. Visitors see nothing. A bot that does run a browser can still get through.",
  turnstile: "Cloudflare's check: a small box above the button that most visitors never have to click. It stops most bots, including many that run a real browser. It needs a free Cloudflare account.",
};

/**
 * Keep bots out: what every form already does, the form's own check, the lines the website needs
 * for it, and what the check has seen: nothing yet, messages with it and without it, or that it's
 * refusing the ones without. The choice is saved with the rest of the card (Save changes); the
 * Turnstile keys, and starting or stopping refusing, save by themselves.
 */
function BotCheckSettings({ form, careers, check, onCheck, siteKey, keysUnreadable }: { form: WebsiteForm; careers: boolean; check: BotCheck; onCheck: (check: BotCheck) => void; siteKey: string | null; keysUnreadable: boolean }) {
  const queryClient = useQueryClient();
  const saved: BotCheck = form.bot_check ?? "off";
  const passedAt = form.bot_check_passed_at ?? null;
  const armedAt = form.bot_check_armed_at ?? null;
  const missed = form.bot_check_missed ?? 0;
  const blocked = form.bots_blocked ?? 0;
  const one = careers ? "application" : "message";
  const many = careers ? "applications" : "messages";
  const count = (n: number) => (n === 1 ? `1 ${one}` : `${n.toLocaleString()} ${many}`);
  const keysReady = Boolean(siteKey) && !keysUnreadable;
  const state = saved === "off" ? CHECK_NAMES.off
    : saved === "turnstile" && keysUnreadable ? `${CHECK_NAMES.turnstile}, not checking`
    : armedAt ? `${CHECK_NAMES[saved]}, refusing ${many} without it`
    : passedAt ? `${CHECK_NAMES[saved]}, watching`
    : `${CHECK_NAMES[saved]}, waiting for a test`;
  const lines = check === "turnstile" && !siteKey ? [] : botCheckLines(form.url, check, siteKey);
  const theLine = lines.length === 1 ? "the line" : "the lines";
  const refuses = useMutation({
    mutationFn: (on: boolean) => api.patch<WebsiteForm>(`/website-forms/${form.id}`, { bot_check_refuses: on }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["website-forms"] }),
    meta: { success: (_: unknown, on: boolean) => (on ? `Refusing ${many} without the check` : `No longer refusing: ${many} without the check come in again`) },
  });
  const startRefusing = async () => {
    const ok = await confirm({
      title: `Start refusing ${many} without the check?`,
      body: `Every page that has this form needs ${theLine} first. Someone who sends from a page without ${lines.length === 1 ? "it" : "them"} will be told their ${one} wasn't sent, and to call you instead.`
        + (missed > 0 ? ` ${count(missed)} came without the check since it was turned on.` : "")
        + " You can stop refusing whenever you like.",
      confirmLabel: "Start refusing",
    });
    if (ok) refuses.mutate(true);
  };

  return (
    <Fold summary="Keep bots out" note={state}>
      <p className={kit.note}>
        Every form already has a hidden field that only bots fill in (the <code className={kit.code}>_gotcha</code> line in the form to paste), and a limit on how many {many} one visitor, or everyone together, can send in an hour.
        {blocked > 0 && <> <strong>{count(blocked)} turned away{form.last_blocked_at ? `, the last one ${timeAgo(form.last_blocked_at)}` : ""}.</strong></>}
      </p>
      <div className={styles.choice}>
        <div className="segmented" role="group" aria-label="What else keeps bots out">
          {(["off", "script", "turnstile"] as const).map((choice) => (
            <button key={choice} type="button" aria-pressed={check === choice} onClick={() => onCheck(choice)}>{CHECK_NAMES[choice]}</button>
          ))}
        </div>
        <p className={kit.note}>{CHECK_NOTES[check]}</p>
      </div>

      {check === "turnstile" && <TurnstileKeys siteKey={siteKey} unreadable={keysUnreadable} formId={form.id} choosing={saved !== "turnstile"} />}

      {lines.length > 0 && (
        <div className={styles.group}>
          <p className={kit.label}>{lines.length === 1 ? "Add this line to your website" : "Add these lines to your website"}</p>
          {lines.map(({ where, line }) => (
            <div key={line} className={styles.line}>
              <span className={kit.hint}>{where === "Inside the form, above its Send button" && careers ? "Inside the form, above its Apply button" : where}:</span>
              <CodeRow value={line} name={where} />
            </div>
          ))}
          <p className={cx(kit.note, kit.small)}>The form to paste, above, has {lines.length === 1 ? "it" : "them"} already.</p>
        </div>
      )}

      {check !== "off" && (check !== "turnstile" || keysReady) && (
        check !== saved ? (
          <p className={kit.note} role="status">Save changes to turn it on. It only watches at first: nothing is refused until a test has come through with it and you say so here.</p>
        ) : armedAt ? (
          <div className={styles.group}>
            <div className="callout callout-good" role="status">
              <Icon name="check" size={16} />
              <div className="grow">
                <div>Refusing {many} without the check since {formatDate(armedAt)}.</div>
                Whoever sends one is told it wasn't sent, how to send it again, and to call you instead.
                {passedAt && <> The last one with the check came through {timeAgo(passedAt)}.</>}
              </div>
            </div>
            <div className={kit.actions}><Button size="sm" loading={refuses.isPending} onClick={() => refuses.mutate(false)}>Stop refusing</Button></div>
          </div>
        ) : passedAt ? (
          <div className={styles.group}>
            <div className="callout callout-info" role="status">
              <Icon name="check" size={16} />
              <div className="grow">
                <div>The check is on your website: {careers ? "an application" : "a message"} last came through with it {timeAgo(passedAt)}. Nothing is refused yet.</div>
                {missed > 0
                  ? <>{count(missed)} came without it since it was turned on{form.bot_check_missed_at ? `, the last one ${timeAgo(form.bot_check_missed_at)}` : ""}. A page that has this form may be missing {theLine}, or {missed === 1 ? "that was a bot" : "those were bots"}: Crewtavo can't tell which.</>
                  : <>None has come without it since it was turned on.</>}
              </div>
            </div>
            <div className={kit.actions}><Button size="sm" loading={refuses.isPending} onClick={startRefusing}>Start refusing {many} without it</Button></div>
          </div>
        ) : (
          <div className="callout" role="status">
            <Icon name="clock" size={16} />
            <div className="grow">
              <div>Waiting for a test.</div>
              Send {careers ? "an application" : "a message"} from your website with {theLine} added. Nothing is refused: {many} come in as before
              {missed > 0 ? `, and ${count(missed)} ${missed === 1 ? "has" : "have"} come without the check so far` : ""}.
            </div>
          </div>
        )
      )}
    </Fold>
  );
}

/**
 * The business's Turnstile keys, for all its forms: saved only once Cloudflare has taken the secret
 * key. With keys saved: which site key, and changing or removing them. `choosing`: this form isn't
 * on Turnstile yet, so saving the keys saves that choice for it too.
 */
function TurnstileKeys({ siteKey, unreadable, formId, choosing }: { siteKey: string | null; unreadable: boolean; formId: string; choosing: boolean }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [site, setSite] = useState("");
  const [secret, setSecret] = useState("");
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["website-forms"] });
  const save = useMutation({
    mutationFn: async () => {
      await api.put<{ turnstile_site_key: string }>("/website-forms/turnstile", { site_key: site.trim(), secret_key: secret.trim() });
      // Turnstile was chosen for this form before there were keys: now it can be saved.
      if (choosing) await api.patch<WebsiteForm>(`/website-forms/${formId}`, { bot_check: "turnstile" });
    },
    onSuccess: () => {
      setEditing(false);
      setSite("");
      setSecret("");
    },
    // The keys may have saved even when the form's choice didn't.
    onSettled: refresh,
    // What Cloudflare said about the keys is shown here, beside them.
    meta: { success: choosing ? "Turnstile keys saved, and this form uses them" : "Turnstile keys saved", inline: true },
  });
  const remove = useMutation({
    mutationFn: () => api.delete("/website-forms/turnstile"),
    onSuccess: refresh,
    meta: { success: "Turnstile keys removed" },
  });
  const ready = Boolean(site.trim() && secret.trim());
  // The card around this is a form of its own: Enter in one of the two boxes saves the keys, not the card.
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (ready && !save.isPending) save.mutate();
  };

  if (siteKey && !unreadable && !editing) {
    return (
      <div className={styles.group}>
        <CodeRow label="Turnstile site key" value={siteKey} />
        <p className={cx(kit.note, kit.small)}>Your Turnstile keys are saved, for all your forms. The secret key is kept encrypted and never shown.</p>
        <div className={kit.actions}>
          <Button size="sm" onClick={() => setEditing(true)}>Change keys</Button>
          <Button
            size="sm"
            variant="ghost"
            loading={remove.isPending}
            onClick={async () => {
              const ok = await confirm({
                title: "Remove your Turnstile keys?",
                body: "Every form that uses Turnstile goes back to the hidden field only, right away. Take the Turnstile lines off your website too, or visitors keep seeing a check that does nothing.",
                confirmLabel: "Remove keys",
                danger: true,
              });
              if (ok) remove.mutate();
            }}
          >
            Remove keys
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className={styles.group}>
      {unreadable && (
        <div className="callout callout-warning" role="status">
          <Icon name="alert" size={16} />
          <div className="grow">
            <div>Nothing is being checked.</div>
            Turnstile keys were saved, but this Crewtavo can't read the secret key any more (its encryption key changed, or it was restored somewhere new). Enter both keys again.
          </div>
        </div>
      )}
      <p className={kit.label}>{siteKey && !unreadable ? "New Turnstile keys" : "Your Turnstile keys"}</p>
      <p className={kit.note}>
        In <a href="https://dash.cloudflare.com/?to=/:account/turnstile" target="_blank" rel="noopener noreferrer">Cloudflare</a>, open Turnstile, add a widget for your website's address, and copy its two keys here. They're used for all your forms.
        The secret key is tested with Cloudflare before anything is saved. The site key can't be tested, so copy it carefully: a wrong one shows an error on your website where the check should be.
        {siteKey && !unreadable && " With new keys, your forms on Turnstile stop refusing and wait for a test again, since your website still has the old site key."}
      </p>
      {choosing && <p className={kit.note} role="status">This form isn't using Turnstile yet. Save your keys and it will.</p>}
      <div className={kit.fields}>
        <Field label="Site key">
          <input className="input" type="text" autoComplete="off" spellCheck={false} placeholder="0x4AAAAAAA..." maxLength={200} value={site} onChange={(e) => { setSite(e.target.value); save.reset(); }} onKeyDown={onEnter} />
        </Field>
        <Field label="Secret key" hint="Kept encrypted, and never shown again.">
          <input className="input" type="password" autoComplete="off" spellCheck={false} maxLength={200} value={secret} onChange={(e) => { setSecret(e.target.value); save.reset(); }} onKeyDown={onEnter} />
        </Field>
      </div>
      {save.error && <span className="field-error" role="alert">{(save.error as Error).message}</span>}
      <div className={kit.actions}>
        <Button variant="primary" loading={save.isPending} disabled={!ready} onClick={() => save.mutate()}>Test and save keys</Button>
        {siteKey && !unreadable && <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>}
      </div>
    </div>
  );
}
