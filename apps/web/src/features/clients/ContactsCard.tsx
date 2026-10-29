/** Extra people on a client account: a spouse, property manager or billing contact. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { supabase, unwrap } from "@/lib/api";
import { fieldError } from "@/lib/errors";
import { useListAnimation } from "@/lib/motion";
import { useSession } from "@/lib/session";
import { undoable } from "@/lib/undo";
import { formatPhoneTyping } from "@/lib/validate";

interface Contact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string | null;
  is_primary: boolean;
  notify_email: boolean;
  notify_sms: boolean;
}

const contactsKey = (clientId: string) => ["client", clientId, "contacts"];
/** The order the list loads in: the primary contact first, then by name. */
const byPrimaryThenName = (a: Contact, b: Contact) => Number(b.is_primary) - Number(a.is_primary) || a.name.localeCompare(b.name);

/** The client's other contacts, for ContactsCard and for the client page to know whether there are any. */
export function useClientContacts(clientId: string) {
  return useQuery({
    queryKey: contactsKey(clientId),
    queryFn: async () => unwrap(await supabase().from("client_contacts").select("id, name, email, phone, role, is_primary, notify_email, notify_sms").eq("client_id", clientId).order("is_primary", { ascending: false }).order("name")),
  });
}

/**
 * The other contacts, as a section of their own once there's one. With none it isn't shown: the
 * client's Details card offers "Add another contact" (AddContact) instead.
 */
export function ContactsCard({ clientId, canEdit }: { clientId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Contact | "new" | null>(null);
  const contacts = useClientContacts(clientId);
  const listRef = useListAnimation<HTMLDivElement>();
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
  return (
    <>
      {rows.length > 0 && (
        <div className="card">
          <div className="card-head">
            <strong>Other contacts</strong>
            {canEdit && <Button size="sm" variant="ghost" icon="plus" onClick={() => setEditing("new")}>Add contact</Button>}
          </div>
          <div ref={listRef}>
            {rows.map((c) => (
              <div key={c.id} className="card-row" style={{ alignItems: "flex-start" }}>
                <span className="grow" style={{ display: "grid", gap: 2 }}>
                  <span className="row" style={{ gap: 6 }}>
                    <strong>{c.name}</strong>
                    {c.role && <span className="chip">{c.role}</span>}
                    {c.is_primary && <span className="chip chip-green">Primary</span>}
                  </span>
                  {c.email && <a href={`mailto:${c.email}`} className="small">{c.email}</a>}
                  {c.phone && <a href={`tel:${c.phone}`} className="small">{c.phone}</a>}
                </span>
                {canEdit && (
                  <Menu
                    triggerClassName="btn btn-sm btn-ghost btn-icon"
                    label={`Actions for ${c.name}`}
                    items={[
                      { label: "Edit contact", icon: "edit", onSelect: () => setEditing(c) },
                      { label: "Remove contact", icon: "trash", danger: true, onSelect: () => removeLater(c) },
                    ]}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
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
        <Icon name="plus" size={14} strokeWidth={2} />
        Add another contact
      </button>
      {adding && <ContactDialog clientId={clientId} contact={null} onClose={() => setAdding(false)} />}
    </>
  );
}

function ContactDialog({ clientId, contact, onClose }: { clientId: string; contact: Contact | null; onClose: () => void }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const [f, setF] = useState({
    name: contact?.name ?? "",
    email: contact?.email ?? "",
    phone: contact?.phone ?? "",
    role: contact?.role ?? "",
    is_primary: contact?.is_primary ?? false,
    notify_email: contact?.notify_email ?? true,
    notify_sms: contact?.notify_sms ?? true,
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
