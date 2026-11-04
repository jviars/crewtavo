/**
 * First run: name the business, pick the trade preset that sets up services, forms and SOP categories,
 * and agree to the Crewtavo Terms (features/legal/License.tsx).
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { TERMS_REQUIRED, TERMS_VERSION, TermsAgreement } from "@/features/legal/License";
import { api } from "@/lib/api";
import { CURRENCIES, timeZoneChoices } from "@/lib/format";
import { AuthLayout } from "./LoginPage";
import styles from "./auth.module.css";

interface PresetSummary { id: string; name: string; description: string }

/**
 * The trades that match what was typed. A typed word matches a word of the trade's name or
 * description that starts like it (all but its last three letters, and at least four), so "plumber"
 * finds Plumbing and "electrician" Electrical. Only the trades matching the most words stay, so
 * "pool cleaning" is Pool, not Cleaning. Nothing typed keeps them all.
 */
export function searchTrades<T extends { name: string; description: string }>(trades: readonly T[], query: string): T[] {
  const words = (text: string) => text.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const typed = words(query).map((w) => w.slice(0, Math.max(4, w.length - 3)));
  if (!typed.length) return [...trades];
  const scores = trades.map((t) => {
    const own = words(`${t.name} ${t.description}`);
    return typed.filter((w) => own.some((o) => o.startsWith(w))).length;
  });
  const best = Math.max(...scores);
  return best ? trades.filter((_, i) => scores[i] === best) : [];
}

/** `onSignOut` is the session's, which leaves nothing of theirs on the phone. */
export function OnboardingPage({ onCreated, onSignOut }: { onCreated: () => void; onSignOut: () => void }) {
  const presets = useQuery({ queryKey: ["presets"], queryFn: () => api.get<PresetSummary[]>("/presets") });
  const [name, setName] = useState("");
  const [preset, setPreset] = useState("general");
  const [search, setSearch] = useState("");
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York");
  const [agreed, setAgreed] = useState(false);
  const [touched, setTouched] = useState(false);
  const [currency, setCurrency] = useState("USD");
  const zones = useMemo(() => timeZoneChoices(timezone), [timezone]);
  const create = useMutation({
    meta: { inline: true, success: "Your business is ready" },
    mutationFn: () => {
      if (name.trim().length < 2) throw new Error("Enter your business name.");
      return api.post<{ id: string }>("/companies", { name: name.trim(), trade_preset: preset, timezone, currency, terms_version: TERMS_VERSION });
    },
    onSuccess: onCreated,
  });

  const found = searchTrades(presets.data ?? [], search);
  // General / Other and the trade picked stay in the list whatever's typed.
  const shown = presets.data?.filter((p) => p.id === "general" || p.id === preset || found.includes(p));
  const status = !search.trim() || !presets.data ? ""
    : found.length ? `${found.length} ${found.length === 1 ? "trade matches" : "trades match"}`
    : "No trade matches. General / Other works for any business.";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    // The box shows what's missing.
    if (agreed) create.mutate();
  };

  return (
    <AuthLayout>
      <form className={`card card-pad ${styles.card} ${styles.wide}`} style={{ padding: 28, gap: 20 }} onSubmit={submit}>
        <h1 className={styles.title}>Set up your business</h1>

        <div className="form-grid">
          <Field label="Business name" requiredMessage="Enter your business name. It goes on your quotes and invoices." error={touched && name.trim().length < 2 ? "Enter your business name. It goes on your quotes and invoices." : null}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme Roofing" required maxLength={200} autoFocus autoComplete="organization" />
          </Field>
          <Field label="Time zone">
            <select className="select" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
            </select>
          </Field>
          <Field label="Currency" hint="What your quotes, invoices and payments are in.">
            <select className="select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}
            </select>
          </Field>
        </div>

        <fieldset className={styles.presets}>
          <legend>Trade</legend>
          <div className={styles.presetSearch}>
            <div className="input-group">
              <span className="addon"><Icon name="search" size={16} /></span>
              {/* Enter only searches; it doesn't create the business. */}
              <input className="input" type="search" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === "Enter" && e.preventDefault()} placeholder="Search trades, like plumbing or pool" aria-label="Search trades" maxLength={80} />
            </div>
            <span className={`muted small ${styles.presetStatus}`} role="status">{status}</span>
          </div>
          {presets.isPending && [0, 1, 2, 3].map((i) => <div key={i} className={styles.preset}><Skeleton width="60%" height={14} /><Skeleton width="90%" height={10} /><Skeleton width="70%" height={10} /></div>)}
          {presets.error && <div style={{ gridColumn: "1 / -1" }}><ErrorState compact error={presets.error} onRetry={() => presets.refetch()} /></div>}
          {shown?.map((p) => (
            <label key={p.id} className={styles.preset} data-selected={p.id === preset || undefined}>
              <input type="radio" name="preset" value={p.id} checked={p.id === preset} onChange={() => setPreset(p.id)} />
              {p.id === preset && <span className={styles.check}><Icon name="check" size={12} strokeWidth={2} /></span>}
              <strong>{p.name}</strong>
              <span className={styles.presetText}>{p.description}</span>
            </label>
          ))}
        </fieldset>

        <TermsAgreement agreed={agreed} onChange={setAgreed} error={touched && !agreed ? TERMS_REQUIRED : null} />

        <FormError error={create.error} />
        <div className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <Button variant="ghost" icon="logout" onClick={() => onSignOut()}>Sign out</Button>
          <Button type="submit" variant="primary" size="lg" loading={create.isPending} disabled={!presets.data}>Create business</Button>
        </div>
      </form>
    </AuthLayout>
  );
}
