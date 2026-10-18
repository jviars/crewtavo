/**
 * First run: name the business, pick the trade preset that sets up services, forms and SOP categories,
 * and agree to the Crewtavo License (features/legal/License.tsx).
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
import { AuthLayout } from "./LoginPage";
import styles from "./auth.module.css";

interface PresetSummary { id: string; name: string; description: string }

const zones = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
})();

/** `onSignOut` is the session's, which leaves nothing of theirs on the phone. */
export function OnboardingPage({ onCreated, onSignOut }: { onCreated: () => void; onSignOut: () => void }) {
  const presets = useQuery({ queryKey: ["presets"], queryFn: () => api.get<PresetSummary[]>("/presets") });
  const [name, setName] = useState("");
  const [preset, setPreset] = useState("general");
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York");
  const [agreed, setAgreed] = useState(false);
  const [touched, setTouched] = useState(false);
  const usZones = useMemo(() => {
    const preferred = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"];
    return [...new Set([timezone, ...preferred, ...zones])];
  }, [timezone]);
  const create = useMutation({
    meta: { inline: true, success: "Your business is ready" },
    mutationFn: () => {
      if (name.trim().length < 2) throw new Error("Enter your business name.");
      return api.post<{ id: string }>("/companies", { name: name.trim(), trade_preset: preset, timezone, terms_version: TERMS_VERSION });
    },
    onSuccess: onCreated,
  });

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
          <Field label="Business name" error={touched && name.trim().length < 2 ? "Enter your business name" : null}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme Roofing" required maxLength={200} autoFocus autoComplete="organization" />
          </Field>
          <Field label="Time zone">
            <select className="select" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {usZones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
            </select>
          </Field>
        </div>

        <fieldset className={styles.presets}>
          <legend>Trade</legend>
          {presets.isPending && [0, 1, 2, 3].map((i) => <div key={i} className={styles.preset}><Skeleton width="60%" height={14} /><Skeleton width="90%" height={10} /><Skeleton width="70%" height={10} /></div>)}
          {presets.error && <div style={{ gridColumn: "1 / -1" }}><ErrorState compact error={presets.error} onRetry={() => presets.refetch()} /></div>}
          {presets.data?.map((p) => (
            <label key={p.id} className={styles.preset} data-selected={p.id === preset || undefined}>
              <input type="radio" name="preset" value={p.id} checked={p.id === preset} onChange={() => setPreset(p.id)} />
              {p.id === preset && <span className={styles.check}><Icon name="check" size={12} strokeWidth={3} /></span>}
              <strong>{p.name}</strong>
              <span>{p.description}</span>
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
