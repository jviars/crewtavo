/**
 * On a sub's page: their sign-in to the field app, where they see only the visits they're put on and
 * their own paperwork. The office texts or emails them a one-time link (or copies it), sees whether
 * they've used it, and can take it away. There's no password: the link signs them in and they stay
 * signed in on their phone. A link works once, within a day, and making a new one stops the last one
 * working, so the office is told before it makes another. Someone with their own Crewtavo account
 * gets access but no link (`shared`). On a new phone they get a code by text or email to what's on
 * their record, or a new link (newPhone.ts). Two switches set what their sign-in shows: the client's
 * phone and email, and a clock for their hours.
 */
import { isPlaceholderEmail } from "@crewtavo/core/email";
import { subAccessText, subSettings } from "@crewtavo/core/subs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { Skeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { api, supabase, unwrap } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { useSession } from "@/lib/session";
import { newPhoneWay } from "./newPhone";
import { signInPhoneNote } from "./signInCountries";
import { refreshSubs, useSubAccess, type SignInLinkResult, type Sub } from "./subsData";

type Send = "text" | "email" | "none";

export function SubAccessCard({ sub }: { sub: Sub }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const access = useSubAccess(session.company.id, sub.id);
  const [result, setResult] = useState<SignInLinkResult | null>(null);
  const email = sub.email && !isPlaceholderEmail(sub.email) ? sub.email : null;
  const who = sub.contact_name || sub.name;

  const sendLink = useMutation({
    meta: { inline: true },
    mutationFn: (send: Send) => api.post<SignInLinkResult>(`/subs/${sub.id}/sign-in-link`, { send }),
    onSuccess: (r) => {
      setResult(r);
      refreshSubs(queryClient);
    },
  });
  const removeAccess = useMutation({
    meta: { success: "Sign-in removed" },
    mutationFn: () => api.delete(`/subs/${sub.id}/access`),
    onSuccess: () => refreshSubs(queryClient),
  });
  const setOption = useMutation({
    meta: { success: (_: unknown, v: Partial<Pick<Sub, "can_contact_clients" | "uses_clock">>) => ("uses_clock" in v ? (v.uses_clock ? "Clock turned on" : "Clock turned off") : v.can_contact_clients ? "They can contact clients" : "They see client names only") },
    mutationFn: async (patch: Partial<Pick<Sub, "can_contact_clients" | "uses_clock">>) => unwrap(await supabase().from("subcontractors").update(patch).eq("id", sub.id)),
    onSuccess: () => refreshSubs(queryClient),
  });

  const a = access.data;
  const has = Boolean(a && a.state !== "none");
  const sending = (send: Send) => sendLink.isPending && sendLink.variables === send;
  const { sms, email: canEmail } = session.config.features;
  const countries = subSettings(session.company.settings).sign_in_countries;
  // A sign-in made here gets a code on a new phone, by text or email to what's kept above, or a new link.
  const ownSignIn = has && !a?.shared && sub.active;
  const shared = useSharedEmail(session.company.id, sub.id, ownSignIn && canEmail ? email : null);
  const newPhone = ownSignIn ? newPhoneWay({ sms, email: canEmail, phone: sub.phone, emailAddress: email, countries, emailShared: shared.data }) : null;
  // Why the number kept above can't get codes by text, when it can't.
  const phoneNote = ownSignIn ? signInPhoneNote(sub.phone, countries, sms) : null;
  // A new link stops the one already sent working: once they have a sign-in, say so first.
  const newLink = async () => {
    if (has) {
      const ok = await confirm({
        title: "Make a new sign-in link?",
        body: `The link you sent ${who} before stops working. To send the same one again, use Copy in the box that opened when you sent it.`,
        confirmLabel: "Make a new link",
      });
      if (!ok) return;
    }
    sendLink.mutate("none");
  };
  const askRemove = async () => {
    const ok = await confirm({
      title: `Remove ${sub.name}'s sign-in?`,
      body: a?.shared
        ? `They can't see ${session.company.name} anymore. Their visits and paperwork stay, and you can give them access again any time.`
        : "It stops working right away, and their phone is signed out. Their visits and paperwork stay, and you can give them a sign-in again any time.",
      confirmLabel: "Remove sign-in",
      danger: true,
    });
    if (ok) removeAccess.mutate();
  };

  return (
    <div className="card card-pad stack-sm">
      <div className="row-between">
        <strong>Sign-in</strong>
        {a && <StatusPill label={subAccessText(a, session.company.timezone)} tone={a.state === "none" ? "muted" : a.state === "invited" || a.shared ? "info" : "good"} />}
        {access.isPending && <Skeleton width={90} height={20} radius={10} />}
      </div>
      {access.error && !a ? (
        <ErrorState compact title="Couldn't load their sign-in" error={access.error} onRetry={() => access.refetch()} />
      ) : !sub.active ? null : a?.shared ? (
        <span className="muted small">They already have their own Crewtavo sign-in, so there's no link to send. They sign in as they usually do, and {session.company.name} is there.</span>
      ) : (
        <span className="muted small">
          {has
            ? "They see only the visits you put them on and their own paperwork. No password: they stay signed in on their phone."
            : "Text them a link to see the visits you put them on and send their paperwork from their phone. No password: they tap the link once and stay signed in."}
        </span>
      )}

      {!sub.active ? (
        <span className="muted small">Turned off: they can't sign in. Turn them back on to give them a sign-in.</span>
      ) : (
        a && (
          <div className="row wrap" style={{ gap: 8 }}>
            {!a.shared && (
              <Button size="sm" icon="messages" loading={sending("text")} disabled={!sub.phone || sendLink.isPending} title={sub.phone ? undefined : "Add their phone number first"} onClick={() => sendLink.mutate("text")}>
                Text sign-in link
              </Button>
            )}
            {!a.shared && email && (
              <Button size="sm" icon="mail" loading={sending("email")} disabled={sendLink.isPending} onClick={() => sendLink.mutate("email")}>
                Email sign-in link
              </Button>
            )}
            <Menu
              triggerClassName="btn btn-sm btn-ghost btn-icon"
              label="More sign-in actions"
              items={[
                { label: has ? "New sign-in link" : "Copy sign-in link", icon: "copy", hidden: a.shared, disabled: sendLink.isPending, onSelect: () => void newLink() },
                { separator: true, hidden: !has || a.shared },
                { label: "Remove sign-in", icon: "trash", danger: true, hidden: !has, onSelect: askRemove },
              ]}
            />
          </div>
        )
      )}
      {/* With a sign-in, the new-phone line says to add a number to text them a link too: one line, not two. */}
      {!sub.phone && sub.active && a && !a.shared && !newPhone && <span className="muted small">Add their mobile number under Details to text them a link.</span>}
      {newPhone && <span className="muted small">{newPhone.text}</span>}
      {[phoneNote && !phoneNote.ok && phoneNote.text, newPhone?.warning].filter(Boolean).map((text) => (
        <div key={text as string} className="callout callout-warning" style={{ padding: "10px 12px" }}><Icon name="alert" size={16} /><span className="grow small">{text}</span></div>
      ))}
      <FormError error={sendLink.error ?? removeAccess.error} />

      <div className="stack-sm" style={{ borderTop: "1px solid var(--divider)", paddingTop: 10, marginTop: 4 }}>
        <label className="switch-row">
          <input type="checkbox" className="switch" checked={sub.can_contact_clients} disabled={setOption.isPending} onChange={(e) => setOption.mutate({ can_contact_clients: e.target.checked })} />
          Can contact clients
        </label>
        <span className="muted small">{sub.can_contact_clients ? "They see the client's phone and email on their visits, to call or text them." : "They see the client's name but not their phone or email."}</span>
        <label className="switch-row">
          <input type="checkbox" className="switch" checked={sub.uses_clock} disabled={setOption.isPending} onChange={(e) => setOption.mutate({ uses_clock: e.target.checked })} />
          Uses the clock
        </label>
        <span className="muted small">{sub.uses_clock ? "They clock in and out on their visits, like your crew, and their hours show on Timesheets for your records. They're still paid by the job, not with a pay period." : "They're paid by the job. Turn this on if you also want their hours."}</span>
      </div>

      {result && <SignInLinkDialog result={result} who={who} phone={sub.phone} email={email} onClose={() => setResult(null)} />}
    </div>
  );
}

/**
 * Whether another of the company's subs' sign-ins has this email too, by the rule codes by email go
 * by (GET /api/subs/:id/code-email): then a code by email goes to neither. A sub at another business
 * with the same address doesn't matter: each business's sign-in gets its own code.
 */
function useSharedEmail(companyId: string, subId: string, email: string | null) {
  return useQuery({
    queryKey: ["subs", companyId, "code-email", subId, email],
    enabled: Boolean(email),
    meta: { silent: true },
    queryFn: async () => (await api.get<{ shared: boolean }>(`/subs/${subId}/code-email`)).shared,
  });
}

/** What happened to the link, and the link itself to copy, or to send from this phone's Messages. */
function SignInLinkDialog({ result, who, phone, email, onClose }: { result: SignInLinkResult; who: string; phone: string | null; email: string | null; onClose: () => void }) {
  const title = result.texted ? "Sign-in link texted" : result.emailed ? "Sign-in link emailed" : result.sms_link ? "Text them the link" : result.link ? "Sign-in link ready" : "They have access";
  const message = result.texted
    ? `We texted ${who} a link to sign in${phone ? ` at ${phone}` : ""}.`
    : result.emailed
      ? `We emailed ${who} a link to sign in${email ? ` at ${email}` : ""}.`
      : result.sms_link
        ? "Open Messages to send it from this phone. The text is filled in for you."
        : result.link
          ? `Copy the link and send it to ${who}.`
          : null;
  return (
    <Dialog open onClose={onClose} title={title}>
      <div className="dialog-body">
        {(result.texted || result.emailed) && (
          <div className="stack-sm" style={{ justifyItems: "center", textAlign: "center" }}>
            <span className="success-mark"><Icon name="check" size={30} strokeWidth={3} /></span>
          </div>
        )}
        {message && <p style={{ margin: 0 }}>{message}</p>}
        {result.reason && (
          <div className="callout callout-info">
            <Icon name="info" size={20} />
            <div className="grow small">{result.reason}</div>
          </div>
        )}
        {result.sms_link && (
          <>
            <a className="btn btn-primary btn-block" href={result.sms_link}><Icon name="messages" size={16} />Open Messages</a>
            <span className="muted small">On a computer, copy the link and text it from your phone.</span>
          </>
        )}
        {result.link && (
          <div className="stack-sm">
            <span className="muted small">It works once, within a day. Sending a new link stops this one working. Whoever opens it signs in as {who}, so send it only to them.</span>
            <Button icon="copy" onClick={() => copyText(result.link!, "Sign-in link copied")}>Copy sign-in link</Button>
          </div>
        )}
        <div className="form-actions"><Button variant="primary" onClick={onClose}>Done</Button></div>
      </div>
    </Dialog>
  );
}
