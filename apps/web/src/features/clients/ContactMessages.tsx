/**
 * Whether a client's other contacts get the client's reminders, quotes, invoices and receipts
 * (companies.settings.contact_messages, core contactMessages). A company that had contacts before
 * the ticks did anything starts with it off and undecided: the Clients page asks its owners and
 * admins once (ContactMessagesNotice), and Settings → Client notifications keeps the switch
 * (ContactMessagesSwitch). Either answer is saved by set_contact_messages, which settles it.
 */
import { contactMessages } from "@crewtavo/core/recipients";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { RowPerson } from "@/components/ui/InboxList";
import { RelatedList, RelatedRow } from "@/components/ui/Section";
import { Loading, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { everyRow } from "@/lib/paging";
import { hasRole, useSession } from "@/lib/session";
import { SwitchRow } from "../settings/SettingsKit";

/** A contact ticked for emails with an address, or for texts with a number: someone who'd get messages. */
const TICKED = "and(notify_email.eq.true,email.not.is.null),and(notify_sms.eq.true,phone.not.is.null)";

const plural = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "contact is" : "contacts are"}`;

/** The setting, how many contacts are ticked (when `count`), and saving the switch. Owners and admins save. */
export function useContactMessages(options: { count?: boolean } = {}) {
  const session = useSession();
  const queryClient = useQueryClient();
  const setting = contactMessages(session.company.settings);
  const canChange = hasRole(session, "admin");
  const ticked = useQuery({
    queryKey: ["contact-messages", session.company.id, "ticked"],
    enabled: Boolean(options.count),
    meta: { silent: true },
    queryFn: async () => (await supabase().from("client_contacts").select("id", { count: "exact", head: true }).eq("company_id", session.company.id).or(TICKED)).count ?? 0,
  });
  const save = useMutation({
    meta: { inline: true, success: (_: unknown, enabled: boolean) => (enabled ? "Contacts will get their client's messages" : "Contacts won't get messages") },
    mutationFn: async (enabled: boolean) => unwrap(await supabase().rpc("set_contact_messages", { p_company: session.company.id, p_enabled: enabled })),
    onSuccess: async () => {
      await session.refresh();
      await queryClient.invalidateQueries({ queryKey: ["contact-messages", session.company.id] });
    },
  });
  return { setting, canChange, ticked: ticked.data ?? null, save };
}

/**
 * The Clients page's one-time note for a company whose contacts were ticked while the ticks did
 * nothing: say so, show who, and let an owner or admin turn it on or leave it off. Gone once answered.
 */
export function ContactMessagesNotice() {
  const { setting, canChange, ticked, save } = useContactMessages({ count: true });
  const [reviewing, setReviewing] = useState(false);
  if (!setting.pending || !canChange || !ticked) return null;
  return (
    <>
      <div className="callout callout-info" role="note">
        <Icon name="info" size={16} />
        <div className="grow stack-sm" style={{ gap: 8 }}>
          <div>
            <div style={{ fontWeight: 600 }}>Contacts ticked to get reminders will start receiving them</div>
            <div>
              {plural(ticked)} ticked. Until now only the client got reminders, quotes, invoices and receipts. Turn this on and their ticked contacts get them too.
            </div>
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <Button size="sm" onClick={() => setReviewing(true)}>Review</Button>
            {/* New client in the page header stays the page's one green button. */}
            <Button size="sm" loading={save.isPending && save.variables === true} disabled={save.isPending} onClick={() => save.mutate(true)}>Turn on</Button>
            <Button size="sm" variant="ghost" loading={save.isPending && save.variables === false} disabled={save.isPending} onClick={() => save.mutate(false)}>Keep it off</Button>
          </div>
          <FormError error={save.error} />
        </div>
      </div>
      {reviewing && <TickedContactsDialog onClose={() => setReviewing(false)} />}
    </>
  );
}

/** Settings → Client notifications: the switch, for owners and admins; everyone else sees how it's set. */
export function ContactMessagesSwitch() {
  const { setting, canChange, ticked, save } = useContactMessages({ count: true });
  const [reviewing, setReviewing] = useState(false);
  const on = save.isPending ? save.variables : setting.enabled;
  return (
    <>
      {/* A plain switch row on the section's hairlines, as the other client messages are. */}
      <div className="set-rows">
        <SwitchRow
          label="Send to a client's other contacts too"
          hint={<>
            A contact ticked for emails or texts on the client's page gets what the client gets about their visits (booked, moved, cancelled, reminders, on-my-way texts), and their quotes, invoices,
            follow-ups and receipts. Marketing emails, review requests and referral asks only ever go to the client.
            {!canChange && <span className="set-row-more">An owner or admin can change this.</span>}
          </>}
          checked={on}
          disabled={!canChange || save.isPending}
          onChange={(next) => save.mutate(next)}
        >
          {/* Outside the hint, so on a phone (where the whole row turns the switch) it's still its own tap. */}
          {ticked !== null && ticked > 0 && <span className="muted small">{plural(ticked)} ticked now. <button type="button" className="link-btn" onClick={() => setReviewing(true)}>See who</button></span>}
        </SwitchRow>
      </div>
      <FormError error={save.error} />
      {reviewing && <TickedContactsDialog onClose={() => setReviewing(false)} />}
    </>
  );
}

interface TickedContact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  notify_email: boolean;
  notify_sms: boolean;
  client: { id: string; display_name: string } | null;
}

/** Review: every contact who'd get messages, with their client, to untick anyone on the client's page first. */
function TickedContactsDialog({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const contacts = useQuery({
    queryKey: ["contact-messages", session.company.id, "list"],
    queryFn: async () =>
      (await everyRow(
        () => supabase().from("client_contacts").select("id, name, email, phone, notify_email, notify_sms, client:clients(id, display_name)").eq("company_id", session.company.id).or(TICKED),
        { order: "name" },
      )) as unknown as TickedContact[],
  });
  return (
    <Dialog open onClose={onClose} title="Contacts ticked to get messages" description="Open a client to untick anyone who shouldn't get their reminders, quotes, invoices and receipts.">
      <div className="dialog-body">
        {contacts.isPending && <Loading label="Loading contacts"><div className="rel">{[0, 1, 2].map((i) => <div key={i} className="rel-row"><span className="grow stack-sm"><Skeleton width="40%" /><Skeleton width="70%" height={10} /></span></div>)}</div></Loading>}
        {contacts.error && <ErrorState compact error={contacts.error} onRetry={() => contacts.refetch()} />}
        {contacts.data?.length === 0 && <EmptyState compact icon="users" title="No contacts are ticked" />}
        {contacts.data && contacts.data.length > 0 && (
          <div style={{ maxHeight: "50vh", overflowY: "auto" }}>
            <RelatedList label="Contacts ticked to get messages">
              {contacts.data.map((c) => {
                const gets = [c.notify_email && c.email ? `emails to ${c.email}` : null, c.notify_sms && c.phone ? `texts to ${c.phone}` : null].filter(Boolean).join(" and ");
                return (
                  <RelatedRow
                    key={c.id}
                    lead={<RowPerson name={c.name} />}
                    title={c.name}
                    sub={`Would get ${gets}`}
                    actions={c.client && <Link className="btn btn-sm" to={`/clients/${c.client.id}`} onClick={onClose}>{c.client.display_name}</Link>}
                  />
                );
              })}
            </RelatedList>
          </div>
        )}
        <div className="form-actions">
          <Button variant="primary" onClick={onClose}>Done</Button>
        </div>
      </div>
    </Dialog>
  );
}
