/**
 * The segment a one-off campaign goes to, as email campaigns and postcards both pick it: client
 * status, tags, city, services they've had, recurring work and how long since their last visit.
 * The database reads it the same way for both (public.campaign_audience, public.postcard_audience).
 */
import { RECURRING_CHOICES, recurringChoice, withRecurringChoice, type CampaignAudience } from "@crewtavo/core/campaigns";
import { useQuery } from "@tanstack/react-query";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { TagInput } from "@/components/ui/TagInput";
import { supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useClientTags } from "../clients/ClientForm";
import styles from "./Marketing.module.css";

export const STATUS_OPTIONS = [["active", "Active clients"], ["lead", "Leads"], ["archived", "Archived"]] as const;
export const VISIT_OPTIONS = [["90", "3 months"], ["180", "6 months"], ["365", "12 months"], ["730", "2 years"]] as const;

export interface Choice {
  value: string;
  label: string;
  count: number;
}

/** A city or service as the business writes it: the picker's label for it, or as it was saved. */
export const labelOf = (list: Choice[] | undefined) => (value: string) => list?.find((x) => x.value === value.trim().toLowerCase())?.label ?? value;

/** The cities and services the form offers, the company's own, most used first. */
export function useAudienceChoices(enabled = true) {
  const session = useSession();
  return useQuery({
    queryKey: ["campaign-audience-choices", session.company.id],
    enabled,
    meta: { silent: true },
    staleTime: 60_000,
    queryFn: async () => unwrap(await supabase().rpc("campaign_audience_choices", { p_company: session.company.id })) as unknown as { cities: Choice[]; services: Choice[] },
  });
}

export function AudienceFields({ audience, onChange, choices, statusHint = "None selected means every status." }: { audience: CampaignAudience; onChange: (next: CampaignAudience) => void; choices?: { cities: Choice[]; services: Choice[] }; statusHint?: string }) {
  const tags = useClientTags();
  const set = (patch: Partial<CampaignAudience>) => onChange({ ...audience, ...patch });
  return (
    <>
      <div className="field">
        <span>Client status</span>
        <div className={styles.chips} role="group" aria-label="Client status">
          {STATUS_OPTIONS.map(([value, text]) => {
            const on = audience.statuses?.includes(value) ?? false;
            return <button key={value} type="button" className="tab" aria-pressed={on} onClick={() => set({ statuses: on ? (audience.statuses ?? []).filter((x) => x !== value) : [...(audience.statuses ?? []), value] })}>{text}</button>;
          })}
        </div>
        <span className="hint">{statusHint}</span>
      </div>
      <Field label="Has any of these tags" optional><TagInput value={audience.tags_any ?? []} onChange={(t) => set({ tags_any: t })} suggestions={tags.data} placeholder="Any client" /></Field>
      <Field label="But none of these tags" optional><TagInput value={audience.tags_none ?? []} onChange={(t) => set({ tags_none: t })} suggestions={tags.data} placeholder="No exclusions" /></Field>
      <Field label="City" optional hint="From their properties or billing address.">
        <TagInput value={(audience.cities ?? []).map(labelOf(choices?.cities))} onChange={(t) => set({ cities: t })} options={choices?.cities} placeholder="Any city" />
      </Field>
      <Field label="Had any of these services" optional hint="On jobs that are done, or have had a visit.">
        <TagInput value={(audience.services ?? []).map(labelOf(choices?.services))} onChange={(t) => set({ services: t })} options={choices?.services} placeholder="Any service" />
      </Field>
      <Field label="Recurring work" optional>
        <Select className="select" value={recurringChoice(audience)} onChange={(e) => onChange(withRecurringChoice(audience, e.target.value as ReturnType<typeof recurringChoice>))}>
          {RECURRING_CHOICES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
        </Select>
      </Field>
      <Field label="No completed visit in the last" optional>
        <Select className="select" value={audience.no_visit_days ?? ""} onChange={(e) => set({ no_visit_days: e.target.value ? Number(e.target.value) : null })}>
          <option value="">Don't filter by visits</option>
          {VISIT_OPTIONS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
        </Select>
      </Field>
    </>
  );
}
