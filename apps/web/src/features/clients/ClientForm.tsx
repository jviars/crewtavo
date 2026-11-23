import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDeferredValue, useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { initials } from "@/components/ui/Avatar";
import { Icon } from "@/components/ui/Icon";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { NumberInput } from "@/components/ui/NumberInput";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { statusText } from "@/components/ui/StatusPill";
import { TagInput } from "@/components/ui/TagInput";
import { supabase, textFilter, unwrap } from "@/lib/api";
import { fieldError } from "@/lib/errors";
import { addressLine } from "@/lib/format";
import { useSession } from "@/lib/session";
import { formatPhoneTyping } from "@/lib/validate";
import { CustomFieldInputs, customFieldsToSave, useCustomFields } from "../customFields/CustomFields";
import styles from "./clients.module.css";

export interface ClientFields {
  display_name: string;
  company_name: string;
  email: string;
  phone: string;
  lead_source: string;
  status: "lead" | "active" | "archived";
  tags: string[];
  notes: string;
  /** The custom fields typed into, by key (CustomFieldInputs). */
  custom: Record<string, string>;
}

const blank: ClientFields = { display_name: "", company_name: "", email: "", phone: "", lead_source: "", status: "lead", tags: [], notes: "", custom: {} };
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

/**
 * The fields both client dialogs share, the business's own last. `error` is the save's, so a clash
 * on email or phone shows under that field. `current` is the client's saved custom field values.
 */
function ClientFieldset({ value, onChange, clientId, current, error }: { value: ClientFields; onChange: (v: ClientFields) => void; clientId?: string; current?: unknown; error?: unknown }) {
  const set = (key: keyof ClientFields) => (e: { target: { value: string } }) => onChange({ ...value, [key]: e.target.value });
  const tags = useClientTags();
  const custom = useCustomFields("client");
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
          <Select className="select" value={value.status} onChange={set("status")}>
            {(["lead", "active", "archived"] as const).map((s) => <option key={s} value={s}>{statusText("client", s)}</option>)}
          </Select>
        </Field>
      </div>
      <Field label="Tags">
        <TagInput value={value.tags} onChange={(t) => onChange({ ...value, tags: t })} suggestions={tags.data} />
      </Field>
      <CustomFieldInputs fields={custom} current={current} draft={value.custom} onChange={(draft) => onChange({ ...value, custom: draft })} />
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
        <Field label="State / Province"><input className="input" value={value.region} onChange={set("region")} maxLength={20} /></Field>
        <Field label="ZIP / Postal code"><input className="input" value={value.postal_code} onChange={set("postal_code")} maxLength={12} /></Field>
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
  const custom = useCustomFields("client");
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
      const client = unwrap(await supabase().from("clients").insert({ company_id: company.id, ...toRow(fields), custom_fields: customFieldsToSave(custom, {}, fields.custom) }).select("id").single());
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

export function EditClientDialog({
  open,
  onClose,
  client,
}: {
  open: boolean;
  onClose: () => void;
  client: { id: string; billing_address?: unknown; custom_fields?: unknown; tax_exempt?: boolean; tax_exempt_note?: string | null; payment_terms_days?: number | null } & Partial<Record<Exclude<keyof ClientFields, "custom">, unknown>>;
}) {
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
    custom: {},
  }));
  const custom = useCustomFields("client");
  const billing = (client.billing_address ?? {}) as Partial<typeof blankAddress>;
  const [address, setAddress] = useState({ ...blankAddress, ...billing });
  // Their own payment terms and tax, for their invoices (20261104000200_client_billing_late_fees.sql).
  const [terms, setTerms] = useState(client.payment_terms_days == null ? "" : String(client.payment_terms_days));
  const [exempt, setExempt] = useState(Boolean(client.tax_exempt));
  const [exemptNote, setExemptNote] = useState(client.tax_exempt_note ?? "");
  const businessTerms = Number((company.settings as { payment_terms_days?: number }).payment_terms_days ?? 30);
  const save = useMutation({
    meta: { inline: true, success: "Client saved" },
    mutationFn: async () =>
      unwrap(
        await supabase()
          .from("clients")
          // Custom fields only when one was typed into, so their saved values (and source_id) are never written over unseen.
          .update({
            ...toRow(fields),
            billing_address: address.line1.trim() ? address : {},
            payment_terms_days: terms.trim() ? Math.min(365, Math.max(0, Math.round(Number(terms)))) : null,
            tax_exempt: exempt,
            tax_exempt_note: exempt ? exemptNote.trim() || null : null,
            ...(Object.keys(fields.custom).length && { custom_fields: customFieldsToSave(custom, client.custom_fields, fields.custom) }),
          })
          .eq("id", client.id),
      ),
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
        <ClientFieldset value={fields} onChange={setFields} clientId={client.id} current={client.custom_fields} error={save.error} />
        <Field label="Internal notes" optional>
          <textarea className="textarea" value={fields.notes} onChange={(e) => setFields({ ...fields, notes: e.target.value })} maxLength={4000} />
        </Field>
        <div className="form-section">
          <h3>Billing address</h3>
          <p className="muted small" style={{ margin: "-8px 0 0" }}>Leave empty if it's the same as the service address.</p>
          <AddressFields value={address} onChange={setAddress} />
        </div>
        <div className="form-section">
          <h3>Invoices</h3>
          <div className="form-grid">
            <Field label="Due after (days)" optional hint={`Empty: your usual ${businessTerms === 0 ? "due on receipt" : `${businessTerms} days`}. 0 means due on receipt.`}>
              <NumberInput className="input" min={0} max={365} value={terms} onChange={(e) => setTerms(e.target.value)} />
            </Field>
            {exempt && <Field label="Exemption number or note" optional><input className="input" value={exemptNote} onChange={(e) => setExemptNote(e.target.value)} maxLength={200} placeholder="Certificate number" /></Field>}
          </div>
          <label className="switch-row" style={{ fontWeight: 400 }}>
            <input type="checkbox" className="switch" checked={exempt} onChange={(e) => setExempt(e.target.checked)} />
            Tax exempt: no tax on their quotes and invoices
          </label>
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

/**
 * Search-as-you-type client chooser, with "create new" when nothing matches. A field that opens a
 * small menu (search on top, 13px rows with a face and the client's address, the picked one ticked);
 * on a phone the menu is a bottom sheet (Menu.tsx). Enter in the search picks the first client.
 */
export function ClientPicker({ value, onChange, allowCreate = true }: { value: PickedClient; onChange: (c: PickedClient) => void; allowCreate?: boolean }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const [term, setTerm] = useState("");
  const query = useDeferredValue(term.trim());
  const results = useQuery({
    queryKey: ["clients", company.id, "picker", query],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      let q = supabase().from("clients").select("id, display_name, company_name, email, properties(line1)").eq("company_id", company.id).neq("status", "archived").order("display_name").limit(8);
      const match = textFilter(query, ["display_name", "company_name", "email", "phone"]);
      if (match) q = q.or(match);
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

  const rows = results.data ?? [];
  const typed = term.trim();
  const canCreate = allowCreate && typed.length >= 2 && !rows.some((r) => r.display_name.toLowerCase() === typed.toLowerCase());
  const pick = (c: { id: string; display_name: string }) => {
    setTerm("");
    if (c.id !== value?.id) onChange({ id: c.id, display_name: c.display_name });
  };
  const add = () => {
    setTerm("");
    create.mutate(typed);
  };
  const items: MenuEntry[] = [
    ...rows.map((c) => ({
      label: c.display_name,
      description: [c.company_name && c.company_name !== c.display_name ? c.company_name : null, c.properties[0]?.line1 ?? c.email ?? "No address yet"].filter(Boolean).join(" · "),
      lead: <span className={styles.pickerFace}>{initials(c.display_name)}</span>,
      checked: value ? c.id === value.id : undefined,
      onSelect: () => pick(c),
    })),
    { separator: true, hidden: !canCreate || !rows.length },
    { label: `Add “${typed}” as a new client`, icon: "plus", hidden: !canCreate, onSelect: add },
  ];
  const foot = results.isPending ? "Loading clients…" : !rows.length && !typed ? (allowCreate ? "No clients yet. Type a name to add one." : "No clients yet.") : null;
  // Enter in the search takes the first client (or adds the new one), as the old list did.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const field = e.target as HTMLElement;
    if (e.key !== "Enter" || !field.classList.contains("menu-search-input")) return;
    e.preventDefault();
    const first = rows[0];
    if (!first && !canCreate) return;
    field.closest<HTMLElement>(".menu")?.hidePopover();
    (e.currentTarget.querySelector(`.${styles.pickerField}`) as HTMLElement | null)?.focus();
    if (first) pick(first);
    else add();
  };
  const shown = create.isPending ? { display_name: `Adding ${create.variables}…` } : value;

  return (
    <div className={styles.picker} onKeyDown={onKeyDown}>
      <Menu
        align="start"
        label={value ? `Client: ${value.display_name}. Choose another` : "Choose a client"}
        title="Choose a client"
        triggerClassName={`select ${styles.pickerField}`}
        trigger={
          shown ? (
            <>
              <span className={styles.pickerFace} aria-hidden="true">{initials(shown.display_name)}</span>
              <span className={styles.pickerName}>{shown.display_name}</span>
            </>
          ) : (
            <>
              <Icon name="search" size={15} />
              <span className={styles.pickerPlaceholder}>Choose a client</span>
            </>
          )
        }
        search={{ value: term, onChange: setTerm, placeholder: "Search by name, email or phone", label: "Search clients" }}
        footer={foot ? { text: foot } : undefined}
        items={items}
      />
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
    <Select className="select" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      {properties.data.map((p) => <option key={p.id} value={p.id}>{p.label ? `${p.label} · ` : ""}{addressLine(p)}</option>)}
      <option value="">No specific property</option>
    </Select>
  );
}
