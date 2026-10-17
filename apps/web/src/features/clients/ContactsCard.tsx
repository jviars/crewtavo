/** Extra people on a client account: a spouse, property manager or billing contact. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { CardSkeleton } from "@/components/ui/Skeleton";
import { supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";

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

export function ContactsCard({ clientId, canEdit }: { clientId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Contact | "new" | null>(null);
  const contacts = useQuery({
    queryKey: ["client", clientId, "contacts"],
    queryFn: async () => unwrap(await supabase().from("client_contacts").select("id, name, email, phone, role, is_primary, notify_email, notify_sms").eq("client_id", clientId).order("is_primary", { ascending: false }).order("name")),
  });
  const remove = useMutation({
    meta: { success: "Contact removed" },
    mutationFn: async (id: string) => unwrap(await supabase().from("client_contacts").delete().eq("id", id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["client", clientId, "contacts"] }),
  });

  if (contacts.isPending) return <CardSkeleton lines={2} />;
  return (
    <div className="card">
      <div className="card-head">
        <strong>Other contacts</strong>
        {canEdit && <Button size="sm" variant="ghost" icon="plus" onClick={() => setEditing("new")}>Add</Button>}
      </div>
      {!contacts.data?.length && <p className="muted small" style={{ margin: 0, padding: "14px 20px" }}>No other contacts.</p>}
      {contacts.data?.map((c) => (
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
                { label: "Edit", icon: "edit", onSelect: () => setEditing(c) },
                {
                  label: "Remove",
                  icon: "trash",
                  danger: true,
                  onSelect: async () => {
                    if (await confirm({ title: `Remove ${c.name}?`, body: "They'll no longer be listed on this client.", confirmLabel: "Remove", danger: true })) remove.mutate(c.id);
                  },
                },
              ]}
            />
          )}
        </div>
      ))}
      {editing && <ContactDialog clientId={clientId} contact={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
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
      queryClient.invalidateQueries({ queryKey: ["client", clientId, "contacts"] });
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={contact ? "Edit contact" : "Add contact"}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <div className="form-grid">
          <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={120} /></Field>
          <Field label="Role" optional><input className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} placeholder="Spouse, property manager…" maxLength={60} /></Field>
          <Field label="Email" optional><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} maxLength={200} /></Field>
          <Field label="Phone" optional><input className="input" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} maxLength={40} /></Field>
        </div>
        <label className="checkbox"><input type="checkbox" checked={f.is_primary} onChange={(e) => setF({ ...f, is_primary: e.target.checked })} /> Primary contact</label>
        <label className="checkbox"><input type="checkbox" checked={f.notify_email} onChange={(e) => setF({ ...f, notify_email: e.target.checked })} /> Gets emailed reminders and receipts</label>
        <label className="checkbox"><input type="checkbox" checked={f.notify_sms} onChange={(e) => setF({ ...f, notify_sms: e.target.checked })} /> Gets text reminders</label>
        <FormError error={save.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!f.name.trim()}>{contact ? "Save" : "Add contact"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function ContactLine({ icon, href, children }: { icon: "mail" | "phone"; href: string; children: React.ReactNode }) {
  return (
    <a href={href} className="row" style={{ gap: 8, color: "var(--ink)" }}>
      <Icon name={icon} size={15} />
      <span className="ellipsis">{children}</span>
    </a>
  );
}
