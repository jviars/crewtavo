/** Extra people on a client account: a spouse, property manager or billing contact. */
import { textConsentLine } from "@crewtavo/core/marketing";
import { contactMessages } from "@crewtavo/core/recipients";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { MetaLine, RowPerson } from "@/components/ui/InboxList";
import { Menu } from "@/components/ui/Menu";
import { Section } from "@/components/ui/Section";
import { supabase, unwrap } from "@/lib/api";
import { fieldError } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import { useListAnimation } from "@/lib/motion";
import { useSession } from "@/lib/session";
import { undoable } from "@/lib/undo";
import { formatPhoneTyping } from "@/lib/validate";
import styles from "./clients.module.css";
import { TextsSwitch, useTextStops } from "./TextsSwitch";

interface Contact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string | null;
  is_primary: boolean;
  notify_email: boolean;
  notify_sms: boolean;
  /** When and where their say-so to be texted came from (the database notes it when they're ticked). */
  sms_consent_at: string | null;
  sms_consent_source: string | null;
}

/** Under "Gets text reminders": a contact's number is often one the business was given by someone else. */
export const TEXT_TICK_HINT = "Tick only if they've agreed to get texts.";

const contactsKey = (clientId: string) => ["client", clientId, "contacts"];
/** The order the list loads in: the primary contact first, then by name. */
const byPrimaryThenName = (a: Contact, b: Contact) => Number(b.is_primary) - Number(a.is_primary) || a.name.localeCompare(b.name);

/** The client's other contacts, for ContactsCard and for the client page to know whether there are any. */
export function useClientContacts(clientId: string) {
  return useQuery({
    queryKey: contactsKey(clientId),
    queryFn: async () => unwrap(await supabase().from("client_contacts").select("id, name, email, phone, role, is_primary, notify_email, notify_sms, sms_consent_at, sms_consent_source").eq("client_id", clientId).order("is_primary", { ascending: false }).order("name")),
  });
}

/**
 * The other contacts, as a section of their own once there's one. With none it isn't shown: the
 * client's Details card offers "Add another contact" (AddContact) instead.
 */
export function ContactsCard({ clientId, canEdit, canSetTexts = false }: { clientId: string; canEdit: boolean; canSetTexts?: boolean }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Contact | "new" | null>(null);
  const contacts = useClientContacts(clientId);
  const listRef = useListAnimation<HTMLUListElement>();
  const remove = useMutation({
    // Undo's toast says how it went (removeLater below).
    meta: { inline: true },
    mutationFn: async (id: string) => unwrap(await supabase().from("client_contacts").delete().eq("id", id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contactsKey(clientId) }),
  });

  /** Takes the contact off the list at once; it's deleted when the Undo toast leaves. */
  const removeLater = (contact: Contact) => {
    const key = contactsKey(clientId);
    undoable({
      title: "Contact removed",
      hide: () => {
        void queryClient.cancelQueries({ queryKey: key });
        queryClient.setQueryData<Contact[]>(key, (rows) => rows?.filter((r) => r.id !== contact.id));
      },
      restore: () => queryClient.setQueryData<Contact[]>(key, (rows) => (rows && !rows.some((r) => r.id === contact.id) ? [...rows, contact].sort(byPrimaryThenName) : rows)),
      commit: () => remove.mutateAsync(contact.id),
    });
  };

  const rows = contacts.data ?? [];
  // Which of their numbers are on the stop list, for each contact's Texts switch (the office's).
  const stopFor = useTextStops(rows.map((row) => row.phone), canSetTexts);
  return (
    <>
      {rows.length > 0 && (
        <Section title="Other contacts" count={rows.length} action={canEdit && <button type="button" onClick={() => setEditing("new")}>Add contact</button>}>
          <ul ref={listRef} className="rel" role="list" aria-label="Other contacts">
            {rows.map((c) => (
              <li key={c.id} className="rel-row" style={{ alignItems: "flex-start" }}>
                <span className="rel-lead"><RowPerson name={c.name} /></span>
                <div className="rel-body">
                  <span className="rel-head">
                    <span className="rel-title">{c.name}</span>
                    {(c.role || c.is_primary) && <span className="rel-detail"> · {[c.role, c.is_primary && "Primary"].filter(Boolean).join(" · ")}</span>}
                  </span>
                  <MetaLine className={`rel-sub ${styles.reach}`} parts={[c.email && <a href={`mailto:${c.email}`}>{c.email}</a>, c.phone && <a href={`tel:${c.phone}`}>{c.phone}</a>]} />
                  {c.phone && canSetTexts && <span className="small"><TextsSwitch clientId={clientId} contactId={c.id} name={c.name} phone={c.phone} stop={stopFor(c.phone)} label="Can be texted" /></span>}
                </div>
                {canEdit && (
                  <span className="rel-actions">
                    <Menu
                      triggerClassName="btn btn-sm btn-ghost btn-icon"
                      label={`Actions for ${c.name}`}
                      title={c.name}
                      items={[
                        { label: "Edit contact", icon: "edit", onSelect: () => setEditing(c) },
                        { separator: true },
                        { label: "Remove contact", icon: "trash", danger: true, onSelect: () => removeLater(c) },
                      ]}
                    />
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {editing && <ContactDialog clientId={clientId} contact={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

/** "Add another contact" in the client's Details card, while there are none for ContactsCard to list. */
export function AddContact({ clientId }: { clientId: string }) {
  const [adding, setAdding] = useState(false);
  return (
    <>
      <button type="button" className="link-btn text-sm row" style={{ gap: 6, justifySelf: "start" }} onClick={() => setAdding(true)}>
        <Icon name="plus" size={14} bold />
        Add another contact
      </button>
      {adding && <ContactDialog clientId={clientId} contact={null} onClose={() => setAdding(false)} />}
    </>
  );
}

function ContactDialog({ clientId, contact, onClose }: { clientId: string; contact: Contact | null; onClose: () => void }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  // Whether ticked contacts get the client's messages at all (Settings → Client notifications).
  const contactsOn = contactMessages(company.settings).enabled;
  const [f, setF] = useState({
    name: contact?.name ?? "",
    email: contact?.email ?? "",
    phone: contact?.phone ?? "",
    role: contact?.role ?? "",
    is_primary: contact?.is_primary ?? false,
    notify_email: contact?.notify_email ?? true,
    // A new contact isn't texted until someone says they agreed to it.
    notify_sms: contact?.notify_sms ?? false,
  });
  const save = useMutation({
    meta: { inline: true, success: contact ? "Contact saved" : "Contact added" },
    mutationFn: async () => {
      const row = { name: f.name.trim(), email: f.email.trim() || null, phone: f.phone.trim() || null, role: f.role.trim() || null, is_primary: f.is_primary, notify_email: f.notify_email, notify_sms: f.notify_sms };
      if (f.is_primary) unwrap(await supabase().from("client_contacts").update({ is_primary: false }).eq("client_id", clientId).neq("id", contact?.id ?? "00000000-0000-0000-0000-000000000000"));
      if (contact) unwrap(await supabase().from("client_contacts").update(row).eq("id", contact.id));
      else unwrap(await supabase().from("client_contacts").insert({ company_id: company.id, client_id: clientId, ...row }));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: contactsKey(clientId) });
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={contact ? "Edit contact" : "Add contact"}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <div className="form-grid">
          {/* No leading spaces, so a name of only spaces is caught as missing. */}
          <Field label="Name" requiredMessage="Add a name for this contact."><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value.trimStart() })} required maxLength={120} /></Field>
          <Field label="Role" optional><input className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} placeholder="Spouse, property manager…" maxLength={60} /></Field>
          <Field label="Email" optional error={fieldError(save.error, "email")}><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} maxLength={200} /></Field>
          <Field label="Phone" optional error={fieldError(save.error, "phone")}><input className="input" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: formatPhoneTyping(e.target.value) })} maxLength={40} /></Field>
        </div>
        <label className="checkbox"><input type="checkbox" checked={f.is_primary} onChange={(e) => setF({ ...f, is_primary: e.target.checked })} /> Primary contact</label>
        <label className="checkbox"><input type="checkbox" checked={f.notify_email} onChange={(e) => setF({ ...f, notify_email: e.target.checked })} /> Gets emailed reminders and receipts</label>
        <label className="checkbox"><input type="checkbox" checked={f.notify_sms} onChange={(e) => setF({ ...f, notify_sms: e.target.checked })} /> Gets text reminders</label>
        <span className="muted small">{TEXT_TICK_HINT}{contact?.notify_sms && contact.phone ? ` ${textConsentLine(contact.sms_consent_source, contact.sms_consent_at ? formatDate(contact.sms_consent_at) : null, true)}` : ""}</span>
        <span className="muted small">
          {contactsOn
            ? "Ticked, they get what the client gets about their work: a visit booked, moved or cancelled, visit reminders, on-my-way texts, quotes, invoices and receipts. Marketing emails and review requests only go to the client."
            : <>Contacts don't get these yet. An owner or admin can turn it on in <Link to="/settings?tab=client-notifications">Settings → Client notifications</Link>.</>}
        </span>
        <FormError error={save.error} fields={["email", "phone"]} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>{contact ? "Save contact" : "Add contact"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function ContactLine({ icon, href, children }: { icon: "mail" | "phone"; href: string; children: React.ReactNode }) {
  return (
    <a href={href} className="row" style={{ gap: 8, color: "var(--ink)" }}>
      <Icon name={icon} size={16} />
      <span className="ellipsis">{children}</span>
    </a>
  );
}
