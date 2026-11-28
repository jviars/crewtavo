/**
 * Settings → Email: send quotes, invoices, reminders, invites and team notifications from the
 * company's own address. Resend comes first (it works on every Railway plan) with a step-by-step
 * guide; Gmail, Zoho and the other mailboxes take an app password and need no DNS changes. Crewtavo
 * signs in and sends a test before saving. Connecting, changing or disconnecting it asks for the
 * person's own password, since the owners hear about Stripe changes by this email, and only an owner
 * does it: whoever connects a mailbox can read what goes out through it, sign-in links included.
 * Admins see how it stands and send a test.
 */
import { emailDomain, isPersonalMailDomain, MAIL_PRESETS, mailPreset, type MailPreset, type MailStep } from "@crewtavo/core/email";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import gmailLogo from "@/assets/apps/gmail.svg";
import googleLogo from "@/assets/apps/google.svg";
import icloudLogo from "@/assets/apps/icloud.svg";
import outlookLogo from "@/assets/apps/outlook.svg";
import resendLogo from "@/assets/apps/resend.svg";
import yahooLogo from "@/assets/apps/yahoo.svg";
import zohoLogo from "@/assets/apps/zoho.svg";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Section } from "@/components/ui/Section";
import { Loading, SectionSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { StatusPill } from "@/components/ui/StatusPill";
import { ErrorState } from "@/components/ui/States";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { PASSWORD_HINT } from "../apps/catalog";
import styles from "./EmailSettings.module.css";
import { SaveBar } from "./SettingsKit";
import { Select } from "@/components/ui/Select";

interface Mailbox {
  preset: MailPreset["id"];
  kind: "smtp" | "resend";
  host?: string;
  port?: number;
  security?: "tls" | "starttls";
  username?: string;
  from_email: string;
  from_name?: string | null;
  status: "connected" | "error";
  last_error: string | null;
  connected_at: string | null;
  /** False when someone who isn't an owner connected it: owners' and admins' sign-in links don't go through it. */
  owner_connected?: boolean;
}
/** `can_change`: whether this person may connect, change or disconnect it (owners only). */
interface EmailState { mailbox: Mailbox | null; fallback: "server" | "dev" | null; on_railway?: boolean; can_change?: boolean }

/** Each provider's own logo on a white tile, like the Apps page (see assets/apps/README.md). */
const LOGOS: Partial<Record<MailPreset["id"], string>> = {
  gmail: gmailLogo,
  google_workspace: googleLogo,
  zoho: zohoLogo,
  microsoft: outlookLogo,
  yahoo: yahooLogo,
  icloud: icloudLogo,
  resend: resendLogo,
};
/** Wordmark-shaped logos get more width. */
const WIDE = new Set<MailPreset["id"]>(["zoho"]);

/** The provider's logo, or the mail icon for any other server. Decorative: its name is right beside it. */
export function ProviderMark({ preset }: { preset: MailPreset["id"] }) {
  const logo = LOGOS[preset];
  if (!logo) return <span className={styles.mark} aria-hidden="true"><Icon name="mail" size={16} /></span>;
  return (
    <span className={`${styles.mark} ${styles.logo}`} data-wide={WIDE.has(preset) || undefined} aria-hidden="true">
      <img src={logo} alt="" />
    </span>
  );
}

export function EmailSettings() {
  const session = useSession();
  const queryClient = useQueryClient();
  const key = ["email-settings", session.company.id];
  const state = useQuery({ queryKey: key, queryFn: () => api.get<EmailState>("/email") });
  const [editing, setEditing] = useState(false);
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: key });
    session.refresh();
  };
  const test = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<{ to: string }>("/email/test", {}),
    onSuccess: (r) => {
      toast.success(`Test email sent to ${r.to}`);
      queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const [askDisconnect, setAskDisconnect] = useState(false);
  const disconnect = useMutation({
    meta: { success: "Email disconnected", inline: true },
    mutationFn: (password: string) => api.delete("/email", undefined, { current_password: password }),
    onSuccess: () => {
      setAskDisconnect(false);
      refresh();
    },
  });

  if (state.error) return <ErrorState error={state.error} onRetry={() => state.refetch()} />;
  if (state.isPending) return <Loading label="Loading email settings"><div className="settings-body"><Skeleton width="70%" height={12} /><SectionSkeleton rows={2} /></div></Loading>;
  const { mailbox, fallback, on_railway: onRailway = false } = state.data;
  const preset = mailPreset(mailbox?.preset);
  // Only an owner connects, changes or disconnects it (routes/email.ts says so for each person).
  const canChange = state.data.can_change ?? session.role === "owner";

  return (
    <>
      <p className="set-note">
        Resend is free for up to 100 emails a day, or you can use the email account you already have; there's nothing to buy.
      </p>

      {mailbox && !editing ? (
        <Section level={3} title="Sending from">
          <div className={styles.status}>
            <ProviderMark preset={mailbox.preset} />
            <div className={styles.statusText}>
              <div className={styles.address}>{mailbox.from_email}</div>
              <span className={styles.statusMeta}>{preset?.label ?? "Email"}{mailbox.kind === "smtp" ? ` · ${mailbox.host}` : ""}{mailbox.connected_at ? ` · connected ${timeAgo(mailbox.connected_at)}` : ""}</span>
            </div>
            <StatusPill label={mailbox.status === "connected" ? "Connected" : "Needs attention"} tone={mailbox.status === "connected" ? "good" : "danger"} />
          </div>
          {mailbox.status === "error" && (
            <div className={`callout callout-danger ${styles.gap}`}>
              <Icon name="alert" size={16} />
              <div className="grow">
                <div>Emails aren't going out</div>
                {mailbox.kind === "resend"
                  ? `${mailbox.last_error ?? "Resend stopped accepting the API key."} Once it's fixed in Resend, connect again with the new key.`
                  : `${mailbox.last_error ?? "The mail server stopped accepting the sign-in."} If you changed the account's password or deleted the app password, connect it again.`}
              </div>
            </div>
          )}
          {preset?.dailyLimit && (
            <p className={`set-note ${styles.gap}`}>
              {preset.kind === "resend" ? `Resend sends ${preset.dailyLimit}.` : `${preset.label} lets one mailbox send ${preset.dailyLimit}. For big email campaigns, Resend handles more.`}
            </p>
          )}
          {canChange && mailbox.owner_connected === false && (
            <div className={`callout callout-info ${styles.gap}`}>
              <Icon name="info" size={16} />
              <div className="grow">
                Someone who isn't an owner connected this email, so sign-in and password reset links for owners and admins don't go out through it. Connect it again yourself to use it for those too.
              </div>
            </div>
          )}
          <FormError error={test.error} />
          <div className={styles.actions}>
            <Button icon="send" loading={test.isPending} onClick={() => test.mutate()}>Send me a test</Button>
            {canChange && (
              <>
                <Button variant="ghost" icon="edit" onClick={() => setEditing(true)}>{mailbox.status === "error" || mailbox.owner_connected === false ? "Connect again" : "Change"}</Button>
                <span className="grow" />
                <Button variant="ghost" className={styles.disconnect} loading={disconnect.isPending} onClick={() => setAskDisconnect(true)}>Disconnect</Button>
              </>
            )}
          </div>
          {!canChange && <p className={`set-note ${styles.gap}`}>{OWNERS_ONLY}</p>}
          {askDisconnect && (
            <DisconnectWithPassword
              body={fallback === "server" ? "Emails will go out from the address whoever installed Crewtavo set up." : "Quotes, invoices and invites won't be emailed until you connect a mailbox again. You can still copy their links."}
              busy={disconnect.isPending}
              error={disconnect.error}
              onDisconnect={(password) => disconnect.mutate(password)}
              onClose={() => {
                setAskDisconnect(false);
                disconnect.reset();
              }}
            />
          )}
        </Section>
      ) : canChange ? (
        <ConnectForm existing={mailbox} onRailway={onRailway} onCancel={mailbox ? () => setEditing(false) : undefined} onSaved={() => { setEditing(false); refresh(); }} />
      ) : (
        <Section level={3} title="Your business's own email isn't connected yet">
          <p className="set-note">{OWNERS_ONLY}</p>
        </Section>
      )}

      {!mailbox && fallback && (
        <div className="callout callout-info">
          <Icon name="info" size={16} />
          <div className="grow">
            {fallback === "dev"
              ? `Test mode: until ${canChange ? "you connect" : "an owner connects"} a mailbox, emails go to the local Mailpit inbox.`
              : `Until ${canChange ? "you connect" : "an owner connects"} a mailbox, emails go out from the address whoever installed Crewtavo set up.`}
          </div>
        </div>
      )}
    </>
  );
}

/** What an admin sees in place of the buttons: the API says the same if asked (routes/email.ts). */
const OWNERS_ONLY = "Only an owner can connect, change or disconnect the company's email, since whoever connects it can read the sign-in links it sends. Ask an owner to do it.";

/** Disconnect's question, with the person's password; it's cleared once sent, and a wrong one says so here. */
function DisconnectWithPassword({ body, busy, error, onDisconnect, onClose }: { body: string; busy: boolean; error: unknown; onDisconnect: (password: string) => void; onClose: () => void }) {
  const [password, setPassword] = useState("");
  return (
    <Dialog open onClose={onClose} title="Disconnect email?" size="sm">
      <form
        className="stack-sm"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          onDisconnect(password);
          setPassword("");
        }}
      >
        <p className="set-note">{body}</p>
        <Field label="Your Crewtavo password" hint={PASSWORD_HINT}>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" maxLength={200} required autoFocus />
        </Field>
        <FormError error={error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger-solid" loading={busy}>Disconnect</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** One choice in "How do you want to send email?". The recommended one is wider, with its reason. */
function ProviderButton({ preset: p, pressed, onChoose }: { preset: MailPreset; pressed: boolean; onChoose: (p: MailPreset) => void }) {
  return (
    <button type="button" className={styles.provider} data-featured={p.recommended || undefined} aria-pressed={pressed} onClick={() => onChoose(p)}>
      <ProviderMark preset={p.id} />
      <span className="grow">
        <span className={styles.providerName}>
          {p.label}
          {p.recommended && <span className="chip chip-green">Recommended</span>}
        </span>
        {p.summary && <small>{p.summary}</small>}
        {p.id === "other" && <small>Any SMTP server</small>}
      </span>
    </button>
  );
}

function ConnectForm({ existing, onRailway, onSaved, onCancel }: { existing: Mailbox | null; onRailway: boolean; onSaved: () => void; onCancel?: () => void }) {
  const session = useSession();
  const [presetId, setPresetId] = useState<MailPreset["id"] | null>(existing?.preset ?? null);
  const preset = mailPreset(presetId);
  const [fromEmail, setFromEmail] = useState(existing?.from_email ?? session.profile.email ?? "");
  const [fromName, setFromName] = useState(existing?.from_name ?? session.company.name);
  const [password, setPassword] = useState("");
  const [host, setHost] = useState(existing?.host ?? "");
  const [port, setPort] = useState(existing?.port ? String(existing.port) : "");
  const [security, setSecurity] = useState<"tls" | "starttls" | "">(existing?.security ?? "");
  const [username, setUsername] = useState(existing?.username ?? "");
  const [advanced, setAdvanced] = useState(false);
  // The person's own Crewtavo password, which saving asks for; cleared once sent.
  const [currentPassword, setCurrentPassword] = useState("");
  const keepsPassword = Boolean(existing && existing.preset === presetId);
  const resend = preset?.kind === "resend";

  const choose = (p: MailPreset) => {
    setPresetId(p.id);
    setHost(p.host ?? "");
    setPort(p.port ? String(p.port) : "");
    setSecurity(p.security ?? "");
    setAdvanced(p.id === "other");
    // Resend sends from your own domain, never Gmail or Yahoo; a mailbox starts from your sign-in address.
    if (p.kind === "resend" && isPersonalMailDomain(emailDomain(fromEmail))) setFromEmail("");
    if (p.kind === "smtp" && !fromEmail) setFromEmail(session.profile.email ?? "");
    save.reset();
  };

  const save = useMutation({
    meta: { inline: true },
    mutationFn: () =>
      api.put<{ connected: boolean; test_sent_to: string | null }>("/email", {
        preset: presetId,
        from_email: fromEmail.trim(),
        from_name: fromName.trim() || null,
        ...(preset?.kind === "resend"
          ? { api_key: password.trim() || undefined }
          : { password: password || undefined, host: host.trim() || undefined, port: port ? Number(port) : undefined, security: security || undefined, username: username.trim() || undefined }),
        current_password: currentPassword,
      }),
    onSuccess: (r) => {
      toast.success("Email connected", { description: r.test_sent_to ? `We sent a test email to ${r.test_sent_to}.` : undefined });
      onSaved();
    },
    onSettled: () => setCurrentPassword(""),
  });

  // Catch the two usual Resend slips before sending: a key copied only partly, and a Gmail-style address.
  const fromDomain = emailDomain(fromEmail);
  const keyProblem = resend && password.trim() && !password.trim().startsWith("re_") ? "Resend API keys start with re_. Copy the key itself (shown once, right after you create it), not its name or ID." : null;
  const fromProblem = resend && isPersonalMailDomain(fromDomain) ? `Resend can't send from a ${fromDomain} address. Use one on the domain you added in Resend, like office@yourcompany.com.` : null;

  return (
    <form className="settings-body" onSubmit={(e: FormEvent) => { e.preventDefault(); if (!keyProblem && !fromProblem) save.mutate(); }}>
      <Section level={3} title="How do you want to send email?">
        <div className={styles.choose} role="group" aria-label="How do you want to send email?">
          {MAIL_PRESETS.filter((p) => p.recommended).map((p) => <ProviderButton key={p.id} preset={p} pressed={presetId === p.id} onChoose={choose} />)}
          <span className={styles.or}>Or send from a mailbox you already have</span>
          <div className={styles.providers}>
            {MAIL_PRESETS.filter((p) => !p.recommended).map((p) => <ProviderButton key={p.id} preset={p} pressed={presetId === p.id} onChoose={choose} />)}
          </div>
          {onRailway && <p className="set-note">Crewtavo is running on Railway. Railway's trial and Hobby plans block sending from a mailbox, so choose Resend unless you're on Railway Pro.</p>}
        </div>
      </Section>

      {preset && (
        <Section level={3} title={`Connect ${preset.label}`}>
          <div className={styles.form}>
          {preset.steps.some((s) => typeof s !== "string") ? (
            <ol className={styles.guide} aria-label={`Set up ${preset.label}`}>
              {(preset.steps as MailStep[]).map((s, i) => (
                <li key={s.title}>
                  <span className={styles.stepNumber} aria-hidden="true">{i + 1}</span>
                  <div className={styles.stepText}>
                    <strong>{s.title}</strong>
                    <span>{s.text}</span>
                    {s.url && (
                      <a className="btn btn-sm" href={s.url} target="_blank" rel="noreferrer">
                        <Icon name="external" size={14} />{s.urlLabel ?? "Open"}
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <div className={styles.simple}>
              <ol className={styles.steps}>{preset.steps.map((s) => <li key={String(s)}>{String(s)}</li>)}</ol>
              {preset.helpUrl && (
                <a className="btn btn-sm" style={{ justifySelf: "start" }} href={preset.helpUrl} target="_blank" rel="noreferrer">
                  <Icon name="external" size={14} />{preset.helpLabel ?? "Open help"}
                </a>
              )}
              {preset.note && <p className="set-note">{preset.note}</p>}
            </div>
          )}

          {resend ? (
            <div className="set-grid">
              <Field label="API key" error={keyProblem} hint={keepsPassword ? "Leave blank to keep the saved one." : "From step 3. It starts with re_."}>
                <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required={!keepsPassword} maxLength={500} autoComplete="off" spellCheck={false} placeholder="re_…" />
              </Field>
              <Field label="Send from" error={fromProblem} hint="Any address on the domain you added in Resend.">
                <input className="input" type="email" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} required maxLength={200} autoComplete="email" placeholder="office@yourcompany.com" />
              </Field>
            </div>
          ) : (
            <div className="set-grid">
              <Field label="Email address" hint="The mailbox you're connecting. Emails come from this address.">
                <input className="input" type="email" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} required maxLength={200} autoComplete="email" />
              </Field>
              <Field label={preset.passwordLabel} hint={keepsPassword ? "Leave blank to keep the saved one." : preset.id !== "other" && preset.id !== "microsoft" ? "Not your regular password." : undefined}>
                <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required={!keepsPassword} maxLength={500} autoComplete="new-password" spellCheck={false} />
              </Field>
            </div>
          )}
          <Field label="Sender name" hint="What clients see as who it's from.">
            <input className="input" value={fromName} onChange={(e) => setFromName(e.target.value)} maxLength={120} />
          </Field>

          {preset.kind === "smtp" && (
            <>
              {preset.id !== "other" && (
                <button type="button" className={styles.more} onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
                  <Icon name={advanced ? "chevronDown" : "chevronRight"} size={14} />Server settings
                </button>
              )}
              {advanced && (
                <div className="set-grid">
                  <Field label="Outgoing mail (SMTP) server"><input className="input" value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" required maxLength={200} spellCheck={false} /></Field>
                  <Field label="Port"><input className="input" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} placeholder="465" required maxLength={5} /></Field>
                  <Field label="Security">
                    <Select className="select" value={security} onChange={(e) => setSecurity(e.target.value as "tls" | "starttls")} required>
                      <option value="tls">SSL/TLS (usually port 465)</option>
                      <option value="starttls">STARTTLS (usually port 587)</option>
                    </Select>
                  </Field>
                  <Field label="Sign-in name" optional hint="Usually the email address."><input className="input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder={fromEmail} maxLength={200} spellCheck={false} /></Field>
                </div>
              )}
            </>
          )}

          <Field label="Your Crewtavo password" hint={PASSWORD_HINT}>
            <input className="input" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required maxLength={200} autoComplete="current-password" />
          </Field>

          </div>
        </Section>
      )}
      {preset && (
        <>
          <FormError error={save.error} />
          <SaveBar>
            <Button type="submit" variant="primary" icon="check" loading={save.isPending}>{save.isPending ? "Connecting and sending a test…" : "Connect"}</Button>
            {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
            <FormChecks />
          </SaveBar>
        </>
      )}
      {!preset && onCancel && (
        <div><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
      )}
    </form>
  );
}
