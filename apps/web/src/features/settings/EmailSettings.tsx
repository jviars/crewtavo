/**
 * Settings → Email: send quotes, invoices, reminders, invites and team notifications from the
 * company's own mailbox. Pick the provider, paste an app password, and Crewtavo signs in and sends
 * a test before saving. Nothing to install and no DNS changes for Gmail, Zoho and the rest.
 */
import { MAIL_PRESETS, mailPreset, type MailPreset } from "@crewtavo/core/email";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusPill } from "@/components/ui/StatusPill";
import { ErrorState } from "@/components/ui/States";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import styles from "./EmailSettings.module.css";

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
}
interface EmailState { mailbox: Mailbox | null; fallback: "server" | "dev" | null }

const MARKS: Record<string, string> = { gmail: "G", google_workspace: "G", zoho: "Z", microsoft: "M", yahoo: "Y", icloud: "", other: "@", resend: "R" };

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
  const disconnect = useMutation({
    meta: { success: "Email disconnected" },
    mutationFn: () => api.delete("/email"),
    onSuccess: refresh,
  });

  if (state.error) return <div className="card"><ErrorState error={state.error} onRetry={() => state.refetch()} /></div>;
  if (state.isPending) return <div className="card card-pad stack"><Skeleton width="40%" /><Skeleton height={120} radius={10} /></div>;
  const { mailbox, fallback } = state.data;
  const preset = mailPreset(mailbox?.preset);

  return (
    <div className="stack">
      <div className="card card-pad stack-sm">
        <strong style={{ fontSize: 16 }}>Send email from your own address</strong>
        <span className="muted">
          Quotes, invoices, reminders, team invites and notifications go out from your business mailbox, so clients see your name and replies land in your inbox. You use the email account you already have; there's nothing to buy.
        </span>
      </div>

      {mailbox && !editing ? (
        <div className="card card-pad stack">
          <div className={styles.status}>
            <span className={styles.mark} aria-hidden="true">{MARKS[mailbox.preset] || <Icon name="mail" size={15} />}</span>
            <div className="grow">
              <div className={styles.address}>{mailbox.from_email}</div>
              <span className="muted small">{preset?.label ?? "Email"}{mailbox.kind === "smtp" ? ` · ${mailbox.host}` : ""}{mailbox.connected_at ? ` · connected ${timeAgo(mailbox.connected_at)}` : ""}</span>
            </div>
            <StatusPill label={mailbox.status === "connected" ? "Connected" : "Needs attention"} tone={mailbox.status === "connected" ? "good" : "danger"} />
          </div>
          {mailbox.status === "error" && (
            <div className="callout callout-danger">
              <Icon name="alert" size={18} />
              <div className="grow">
                <div>Emails aren't going out</div>
                <div className="small" style={{ fontWeight: 400 }}>{mailbox.last_error ?? "The mail server stopped accepting the sign-in."} If you changed the account's password or deleted the app password, connect it again.</div>
              </div>
            </div>
          )}
          {preset?.dailyLimit && <span className="muted small">{preset.label} lets one mailbox send {preset.dailyLimit}. For big email campaigns, Resend handles more.</span>}
          <FormError error={test.error} />
          <div className="row wrap" style={{ gap: 8 }}>
            <Button icon="send" loading={test.isPending} onClick={() => test.mutate()}>Send me a test</Button>
            <Button icon="edit" onClick={() => setEditing(true)}>{mailbox.status === "error" ? "Connect again" : "Change"}</Button>
            <span style={{ flex: 1 }} />
            <Button
              variant="ghost"
              loading={disconnect.isPending}
              onClick={async () => {
                if (await confirm({ title: "Disconnect email?", body: fallback === "server" ? "Emails will go out from the address whoever installed Crewtavo set up." : "Quotes, invoices and invites won't be emailed until you connect a mailbox again. You can still copy their links.", confirmLabel: "Disconnect", danger: true })) disconnect.mutate();
              }}
            >
              Disconnect
            </Button>
          </div>
        </div>
      ) : (
        <ConnectForm existing={mailbox} onCancel={mailbox ? () => setEditing(false) : undefined} onSaved={() => { setEditing(false); refresh(); }} />
      )}

      {!mailbox && fallback && (
        <div className="callout callout-info">
          <Icon name="info" size={18} />
          <div className="grow small" style={{ fontWeight: 400 }}>
            {fallback === "dev" ? "Test mode: until you connect a mailbox, emails go to the local Mailpit inbox (http://localhost:56324)." : "Until you connect a mailbox, emails go out from the address whoever installed Crewtavo set up."}
          </div>
        </div>
      )}
    </div>
  );
}

function ConnectForm({ existing, onSaved, onCancel }: { existing: Mailbox | null; onSaved: () => void; onCancel?: () => void }) {
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
  const keepsPassword = Boolean(existing && existing.preset === presetId);

  const choose = (p: MailPreset) => {
    setPresetId(p.id);
    setHost(p.host ?? "");
    setPort(p.port ? String(p.port) : "");
    setSecurity(p.security ?? "");
    setAdvanced(p.id === "other");
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
      }),
    onSuccess: (r) => {
      toast.success("Email connected", { description: r.test_sent_to ? `We sent a test email to ${r.test_sent_to}.` : undefined });
      onSaved();
    },
  });

  return (
    <form className="card card-pad stack" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
      <div className="stack-sm">
        <strong id="provider-label">Where is your business email?</strong>
        <div className={styles.providers} role="group" aria-labelledby="provider-label">
          {MAIL_PRESETS.map((p) => (
            <button key={p.id} type="button" className={styles.provider} aria-pressed={presetId === p.id} onClick={() => choose(p)}>
              <span className={styles.mark} aria-hidden="true">{MARKS[p.id] || <Icon name="mail" size={15} />}</span>
              <span>{p.label}{p.id === "resend" && <small>For large campaigns</small>}{p.id === "other" && <small>Any SMTP server</small>}</span>
            </button>
          ))}
        </div>
      </div>

      {preset && (
        <>
          <div className="callout">
            <Icon name="info" size={18} />
            <div className="grow stack-sm" style={{ fontWeight: 400 }}>
              <ol className={styles.steps}>{preset.steps.map((s) => <li key={s}>{s}</li>)}</ol>
              {preset.helpUrl && (
                <a className="btn btn-sm" style={{ justifySelf: "start" }} href={preset.helpUrl} target="_blank" rel="noreferrer">
                  <Icon name="external" size={14} />{preset.helpLabel ?? "Open help"}
                </a>
              )}
              {preset.note && <span className="muted small">{preset.note}</span>}
            </div>
          </div>

          <div className="form-grid">
            <Field label={preset.kind === "resend" ? "Send from" : "Email address"} hint={preset.kind === "resend" ? "An address on the domain you verified in Resend." : "The mailbox you're connecting. Emails come from this address."}>
              <input className="input" type="email" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} required maxLength={200} autoComplete="email" />
            </Field>
            <Field label={preset.passwordLabel} hint={keepsPassword ? "Leave blank to keep the saved one." : preset.kind === "smtp" && preset.id !== "other" && preset.id !== "microsoft" ? "Not your regular password." : undefined}>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required={!keepsPassword} maxLength={500} autoComplete="new-password" spellCheck={false} />
            </Field>
          </div>
          <Field label="Sender name" hint="What clients see as who it's from.">
            <input className="input" value={fromName} onChange={(e) => setFromName(e.target.value)} maxLength={120} />
          </Field>

          {preset.kind === "smtp" && (
            <>
              {preset.id !== "other" && (
                <button type="button" className="link-btn row" style={{ justifySelf: "start", gap: 4 }} onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
                  <Icon name={advanced ? "chevronDown" : "chevronRight"} size={14} />Server settings
                </button>
              )}
              {advanced && (
                <div className="form-grid">
                  <Field label="Outgoing mail (SMTP) server"><input className="input" value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" required maxLength={200} spellCheck={false} /></Field>
                  <Field label="Port"><input className="input" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} placeholder="465" required maxLength={5} /></Field>
                  <Field label="Security">
                    <select className="select" value={security} onChange={(e) => setSecurity(e.target.value as "tls" | "starttls")} required>
                      <option value="tls">SSL/TLS (usually port 465)</option>
                      <option value="starttls">STARTTLS (usually port 587)</option>
                    </select>
                  </Field>
                  <Field label="Sign-in name" optional hint="Usually the email address."><input className="input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder={fromEmail} maxLength={200} spellCheck={false} /></Field>
                </div>
              )}
            </>
          )}

          <FormError error={save.error} />
          <div className="form-actions">
            {onCancel && <Button onClick={onCancel}>Cancel</Button>}
            <Button type="submit" variant="primary" icon="check" loading={save.isPending}>{save.isPending ? "Connecting and sending a test…" : "Connect"}</Button>
          </div>
        </>
      )}
    </form>
  );
}
