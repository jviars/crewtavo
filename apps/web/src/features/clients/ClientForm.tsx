import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDeferredValue, useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { statusText } from "@/components/ui/StatusPill";
import { TagInput } from "@/components/ui/TagInput";
import { searchTerm, supabase, unwrap } from "@/lib/api";
import { fieldError } from "@/lib/errors";
import { addressLine } from "@/lib/format";
import { useSession } from "@/lib/session";
import { formatPhoneTyping } from "@/lib/validate";

export interface ClientFields {
  display_name: string;
  company_name: string;
  email: string;
  phone: string;
  lead_source: string;
  status: "lead" | "active" | "archived";
  tags: string[];
  notes: string;
}

const blank: ClientFields = { display_name: "", company_name: "", email: "", phone: "", lead_source: "", status: "lead", tags: [], notes: "" };
const toRow = (f: ClientFields) => ({
  display_name: f.display_name.trim(),
  company_name: f.company_name.trim() || null,
  email: f.email.trim() || null,
  phone: f.phone.trim() || null,
  lead_source: f.lead_source.trim() || null,
  status: f.status,
  tags: f.tags,
  notes: f.notes.trim() || null,
});

export const LEAD_SOURCES = ["Referral", "Google", "Website", "Facebook", "Yard sign", "Repeat client", "Door hanger", "Nextdoor"];

/** Tags already used in this company, for suggestions. */
export function useClientTags() {
  const { company } = useSession();
  return useQuery({
    queryKey: ["client-tags", company.id],
    staleTime: 5 * 60_000,
    meta: { silent: true },
    queryFn: async () => {
      const rows = unwrap(await supabase().from("clients").select("tags").eq("company_id", company.id).not("tags", "eq", "{}").limit(1000));
      return [...new Set(rows.flatMap((r) => r.tags))].sort((a, b) => a.localeCompare(b));
    },
  });
}

/** Warns when another client already uses this email address. */
function useDuplicateEmail(email: string, exceptId?: string) {
  const { company } = useSession();
  const value = useDeferredValue(email.trim().toLowerCase());
  return useQuery({
    queryKey: ["client-email", company.id, value, exceptId],
    enabled: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value),
    meta: { silent: true },
    queryFn: async () => {
      let q = supabase().from("clients").select("id, display_name").eq("company_id", company.id).ilike("email", value).limit(1);
      if (exceptId) q = q.neq("id", exceptId);
      return unwrap(await q)[0] ?? null;
    },
  });
}

/** The fields both client dialogs share. `error` is the save's, so a clash on email or phone shows under that field. */
function ClientFieldset({ value, onChange, clientId, error }: { value: ClientFields; onChange: (v: ClientFields) => void; clientId?: string; error?: unknown }) {
  const set = (key: keyof ClientFields) => (e: { target: { value: string } }) => onChange({ ...value, [key]: e.target.value });
  const tags = useClientTags();
  const duplicate = useDuplicateEmail(value.email, clientId);
  return (
    <>
      <div className="form-grid">
        {/* No leading spaces, so a name of only spaces is caught as missing. */}
        <Field label="Name" requiredMessage="Add a name so you can find this client later."><input className="input" value={value.display_name} onChange={(e) => onChange({ ...value, display_name: e.target.value.trimStart() })} required maxLength={200} autoComplete="off" placeholder="Jordan Rivera" /></Field>
        <Field label="Company" optional><input className="input" value={value.company_name} onChange={set("company_name")} maxLength={200} autoComplete="off" /></Field>
        <Field
          label="Email"
          optional
          error={fieldError(error, "email")}
          hint={duplicate.data ? <span style={{ color: "var(--warning)", fontWeight: 600 }}>Already used by <Link to={`/clients/${duplicate.data.id}`} target="_blank">{duplicate.data.display_name}</Link></span> : undefined}
        >
          <input className="input" type="email" value={value.email} onChange={set("email")} maxLength={200} autoComplete="off" />
        </Field>
        <Field label="Phone" optional error={fieldError(error, "phone")}><input className="input" type="tel" value={value.phone} onChange={(e) => onChange({ ...value, phone: formatPhoneTyping(e.target.value) })} maxLength={40} autoComplete="off" /></Field>
        <Field label="Lead source" optional>
          <input className="input" value={value.lead_source} onChange={set("lead_source")} list="lead-sources" maxLength={120} placeholder="Referral, Google, yard sign…" />
          <datalist id="lead-sources">{LEAD_SOURCES.map((s) => <option key={s} value={s} />)}</datalist>
        </Field>
        <Field label="Status">
          <select className="select" value={value.status} onChange={set("status")}>
            {(["lead", "active", "archived"] as const).map((s) => <option key={s} value={s}>{statusText("client", s)}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Tags">
        <TagInput value={value.tags} onChange={(t) => onChange({ ...value, tags: t })} suggestions={tags.data} />
      </Field>
    </>
  );
}

const blankAddress = { line1: "", city: "", region: "", postal_code: "" };

function AddressFields({ value, onChange, required }: { value: typeof blankAddress; onChange: (v: typeof blankAddress) => void; required?: boolean }) {
  const set = (key: keyof typeof blankAddress) => (e: { target: { value: string } }) => onChange({ ...value, [key]: e.target.value });
  return (
    <>
      <Field label="Street address" optional={!required}><input className="input" value={value.line1} onChange={set("line1")} placeholder="123 Main St" maxLength={200} required={required} autoComplete="off" /></Field>
      <div className="form-grid-3">
        <Field label="City"><input className="input" value={value.city} onChange={set("city")} maxLength={100} /></Field>
        <Field label="State"><input className="input" value={value.region} onChange={set("region")} maxLength={20} /></Field>
        <Field label="ZIP"><input className="input" value={value.postal_code} onChange={set("postal_code")} maxLength={12} inputMode="numeric" /></Field>
      </div>
    </>
  );
}

/** New client with an optional first property. */
export function NewClientDialog({ open, onClose, onCreated, initialName = "" }: { open: boolean; onClose: () => void; onCreated: (id: string) => void; initialName?: string }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const [fields, setFields] = useState<ClientFields>({ ...blank, display_name: initialName });
  const [address, setAddress] = useState(blankAddress);
  // Opened while searching, the name starts as what was searched for. Set in the render that
  // opens it, so it never shows the old value first.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setFields({ ...blank, display_name: initialName });
  }
  const create = useMutation({
    meta: { inline: true, success: "Client created" },
    mutationFn: async () => {
      const client = unwrap(await supabase().from("clients").insert({ company_id: company.id, ...toRow(fields) }).select("id").single());
      if (address.line1.trim()) {
        unwrap(await supabase().from("properties").insert({ company_id: company.id, client_id: client.id, ...address, line1: address.line1.trim() }));
      }
      return client.id;
    },
    onSuccess: (id) => {
      queryClient.invalidateQueries({ queryKey: ["clients", company.id] });
      queryClient.invalidateQueries({ queryKey: ["client-tags", company.id] });
      onCreated(id);
    },
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      // Cleared once it has animated out, so it closes on what was typed and opens empty next time.
      onExited={() => {
        setFields(blank);
        setAddress(blankAddress);
        create.reset();
      }}
      title="New client"
      size="lg"
    >
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
        <ClientFieldset value={fields} onChange={setFields} error={create.error} />
        <div className="form-section">
          <h3>Service address</h3>
          <AddressFields value={address} onChange={setAddress} />
        </div>
        <FormError error={create.error} fields={["email", "phone"]} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>Create client</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function EditClientDialog({ open, onClose, client }: { open: boolean; onClose: () => void; client: { id: string; billing_address?: unknown } & Partial<Record<keyof ClientFields, unknown>> }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const [fields, setFields] = useState<ClientFields>(() => ({
    display_name: String(client.display_name ?? ""),
    company_name: String(client.company_name ?? ""),
    email: String(client.email ?? ""),
    phone: String(client.phone ?? ""),
    lead_source: String(client.lead_source ?? ""),
    status: (client.status as ClientFields["status"]) ?? "lead",
    tags: Array.isArray(client.tags) ? (client.tags as string[]) : [],
    notes: String(client.notes ?? ""),
  }));
  const billing = (client.billing_address ?? {}) as Partial<typeof blankAddress>;
  const [address, setAddress] = useState({ ...blankAddress, ...billing });
  const save = useMutation({
    meta: { inline: true, success: "Client saved" },
    mutationFn: async () =>
      unwrap(await supabase().from("clients").update({ ...toRow(fields), billing_address: address.line1.trim() ? address : {} }).eq("id", client.id)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["clients", company.id] });
      queryClient.invalidateQueries({ queryKey: ["client", client.id] });
      queryClient.invalidateQueries({ queryKey: ["client-tags", company.id] });
      onClose();
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title="Edit client" size="lg">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <ClientFieldset value={fields} onChange={setFields} clientId={client.id} error={save.error} />
        <Field label="Internal notes" optional>
          <textarea className="textarea" value={fields.notes} onChange={(e) => setFields({ ...fields, notes: e.target.value })} maxLength={4000} />
        </Field>
        <div className="form-section">
          <h3>Billing address</h3>
          <p className="muted small" style={{ margin: "-8px 0 0" }}>Leave empty if it's the same as the service address.</p>
          <AddressFields value={address} onChange={setAddress} />
        </div>
        <FormError error={save.error} fields={["email", "phone"]} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>Save changes</Button>
        </div>
      </form>
    </Dialog>
  );
}

export type PickedClient = { id: string; display_name: string } | null;

/** Search-as-you-type client chooser, with "create new" when nothing matches. */
export function ClientPicker({ value, onChange, allowCreate = true }: { value: PickedClient; onChange: (c: PickedClient) => void; allowCreate?: boolean }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const [term, setTerm] = useState("");
  const [index, setIndex] = useState(0);
  const query = useDeferredValue(searchTerm(term));
  const results = useQuery({
    queryKey: ["clients", company.id, "picker", query],
    enabled: !value,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      let q = supabase().from("clients").select("id, display_name, company_name, email, properties(line1)").eq("company_id", company.id).neq("status", "archived").order("display_name").limit(8);
      if (query) q = q.or(`display_name.ilike.%${query}%,company_name.ilike.%${query}%,email.ilike.%${query}%,phone.ilike.%${query}%`);
      return unwrap(await q);
    },
  });
  const create = useMutation({
    meta: { success: (c: { display_name: string }) => `Added ${c.display_name} as a new lead` },
    mutationFn: async (name: string) => unwrap(await supabase().from("clients").insert({ company_id: company.id, display_name: name, status: "lead" }).select("id, display_name").single()),
    onSuccess: (c) => {
      queryClient.invalidateQueries({ queryKey: ["clients", company.id] });
      onChange(c);
    },
  });
  useEffect(() => setIndex(0), [query]);
  // After a pick, start fresh if the picker is shown again.
  useEffect(() => {
    if (value) setTerm("");
  }, [value]);

  if (value) {
    return (
      <div className="row card" style={{ padding: "8px 8px 8px 12px", boxShadow: "none", background: "var(--fill)" }}>
        <Icon name="clients" size={16} />
        <strong className="grow ellipsis">{value.display_name}</strong>
        <Button size="sm" variant="ghost" onClick={() => onChange(null)}>Change</Button>
      </div>
    );
  }
  const rows = results.data ?? [];
  const canCreate = allowCreate && term.trim().length >= 2 && !rows.some((r) => r.display_name.toLowerCase() === term.trim().toLowerCase());
  const total = rows.length + (canCreate ? 1 : 0);
  const choose = (i: number) => {
    if (i < rows.length) onChange({ id: rows[i].id, display_name: rows[i].display_name });
    else if (canCreate) create.mutate(term.trim());
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(total - 1, i + 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
    if (e.key === "Enter") { e.preventDefault(); if (total) choose(index); }
  };
  return (
    <div className="stack-sm">
      <div className="input-group">
        <span className="addon"><Icon name="search" size={16} /></span>
        <input className="input" placeholder="Search by name, email or phone" value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={onKeyDown} aria-label="Search clients" autoComplete="off" />
      </div>
      <div className="card" style={{ maxHeight: 248, overflowY: "auto", boxShadow: "none" }} role="listbox">
        {results.isPending &&
          [0, 1, 2].map((i) => (
            <div key={i} className="card-row" style={{ padding: "10px 12px" }}><Skeleton width={`${60 - i * 12}%`} height={12} /></div>
          ))}
        {rows.map((c, i) => (
          <button key={c.id} type="button" role="option" aria-selected={i === index} className="card-row" onMouseMove={() => setIndex(i)} onClick={() => choose(i)} style={{ padding: "9px 12px", background: i === index ? "var(--fill-2)" : "var(--surface)" }}>
            <span className="grow">
              <strong>{c.display_name}</strong>
              {c.company_name && c.company_name !== c.display_name && <span className="muted"> · {c.company_name}</span>}
              <span className="muted small ellipsis" style={{ display: "block" }}>{c.properties[0]?.line1 ?? c.email ?? "No address yet"}</span>
            </span>
          </button>
        ))}
        {canCreate && (
          <button type="button" role="option" aria-selected={index === rows.length} className="card-row" onMouseMove={() => setIndex(rows.length)} onClick={() => choose(rows.length)} disabled={create.isPending} style={{ padding: "10px 12px", background: index === rows.length ? "var(--fill-2)" : "var(--surface)", color: "var(--green-dark)", fontWeight: 600 }}>
            <Icon name="plus" size={16} />
            {create.isPending ? "Creating…" : `Create “${term.trim()}” as a new client`}
          </button>
        )}
        {!results.isPending && total === 0 && <div className="empty" style={{ padding: 16 }}>{term ? "No matching clients" : "No clients yet. Type a name to add one."}</div>}
      </div>
    </div>
  );
}

/** Which of the client's properties the work is at. */
export function PropertySelect({ clientId, value, onChange }: { clientId: string; value: string | null; onChange: (id: string | null) => void }) {
  const properties = useQuery({
    queryKey: ["client", clientId, "properties"],
    queryFn: async () => unwrap(await supabase().from("properties").select("id, label, line1, city, region, postal_code").eq("client_id", clientId).order("created_at")),
  });
  useEffect(() => {
    // Default to the first property once loaded.
    if (properties.data?.length && value == null) onChange(properties.data[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [properties.data]);
  if (properties.isPending) return <Skeleton height={38} radius={8} />;
  if (!properties.data?.length) return <p className="muted small" style={{ margin: 0 }}>No service address on file.</p>;
  return (
    <select className="select" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      {properties.data.map((p) => <option key={p.id} value={p.id}>{p.label ? `${p.label} · ` : ""}{addressLine(p)}</option>)}
      <option value="">No specific property</option>
    </select>
  );
}
