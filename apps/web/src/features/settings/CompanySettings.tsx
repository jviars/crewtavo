import { TIPS_LAW_NOTE } from "@crewtavo/core/autopay";
import { LATE_FEE_LAW_NOTE, lateFeeSettings, minimumCharge, type LateFee } from "@crewtavo/core/billing";
import { BREAK_PAY_HINTS, BREAK_PAY_LABELS, breakPay, type BreakPay } from "@crewtavo/core/breaks";
import { CLOCK_MODE_HINTS, CLOCK_MODE_LABELS, clockMode, type ClockMode } from "@crewtavo/core/clock";
import { FT_PER_M } from "@crewtavo/core/geo";
import { GEOFENCE_MODE_HINTS, GEOFENCE_MODE_LABELS, GEOFENCE_NOTE, GEOFENCE_RADIUS, geofence, geofenceRadius, type GeofenceMode } from "@crewtavo/core/geofence";
import { completesWhenVisitsDone } from "@crewtavo/core/jobBilling";
import { taxPercent, taxRateFromPercent } from "@crewtavo/core/money";
import { PRESETS } from "@crewtavo/core/presets";
import { PRIVACY_URL_MAX, privacyUrlTyped } from "@crewtavo/core/privacyPolicy";
import { workdays } from "@crewtavo/core/slots";
import { arrivalWindowMin } from "@crewtavo/core/time";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Button, useJustDone } from "@/components/ui/Button";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Section } from "@/components/ui/Section";
import { SectionSkeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { api, supabase, unwrap } from "@/lib/api";
import { CURRENCIES, timeZoneChoices } from "@/lib/format";
import { useSession } from "@/lib/session";
import { formatPhoneTyping } from "@/lib/validate";
import { CompanyLogo } from "./CompanyLogo";
import { JobCostSettings } from "./JobCostSettings";
import { NextNumbers } from "./NextNumberSettings";
import { QuoteSettings } from "./QuoteSettings";
import { SaveBar, Suffix, SwitchRow, unsavedCount } from "./SettingsKit";
import { loadSettings } from "@/lib/companySettings";
import { Select } from "@/components/ui/Select";
import { NumberInput } from "@/components/ui/NumberInput";

// The clock at the property's choices of how close counts as there, in meters, said in feet too.
const RADII = [100, 150, 200, 300, 400, 500];
const radiusLabel = (m: number) => `${m} m (${(Math.round((m * FT_PER_M) / 10) * 10).toLocaleString("en-US")} ft)`;
// Monday first, as the week reads; settings.working_hours.days keeps them as 0 (Sunday) to 6.
const WEEK = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"]] as const;
const BRAND_COLORS = [
  { value: "#0f2a35", name: "Ink" }, { value: "#3b7d23", name: "Green" }, { value: "#1d4ed8", name: "Blue" }, { value: "#b45309", name: "Rust" },
  { value: "#be123c", name: "Red" }, { value: "#6d28d9", name: "Purple" }, { value: "#0f766e", name: "Teal" }, { value: "#1f2937", name: "Charcoal" },
];

export function CompanySettings() {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const details = useQuery({
    queryKey: ["company", company.id],
    queryFn: async () => {
      const [row, settings] = await Promise.all([supabase().from("companies").select("name, slug, phone, email, website, address, timezone, currency, trade_preset").eq("id", company.id).single(), loadSettings(company.id)]);
      return { ...unwrap(row), settings };
    },
  });
  const [f, setF] = useState<Record<string, string> | null>(null);
  // What was loaded (or last saved), to say how many changes are waiting.
  const [loaded, setLoaded] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    if (!details.data || f) return;
    const d = details.data;
    const a = (d.address ?? {}) as Record<string, string>;
    const s = (d.settings ?? {}) as Record<string, any>;
    const fee = lateFeeSettings(s);
    const start: Record<string, string> = {
      name: d.name, phone: d.phone ?? "", email: d.email ?? "", website: d.website ?? "", trade: d.trade_preset,
      privacy_url: typeof s.privacy_url === "string" ? s.privacy_url : "",
      line1: a.line1 ?? "", city: a.city ?? "", region: a.region ?? "", postal_code: a.postal_code ?? "",
      timezone: d.timezone, currency: d.currency, payment_terms_days: String(s.payment_terms_days ?? 30), default_tax_rate: String(taxPercent(s.default_tax_rate ?? 0)),
      quote_valid_days: String(s.quote_valid_days ?? 30), hours_start: s.working_hours?.start ?? "07:00", hours_end: s.working_hours?.end ?? "18:00",
      workdays: workdays(s).join(","),
      arrival_window_min: String(arrivalWindowMin(s)),
      color: s.branding?.color ?? "#0f2a35",
      hub_tips: s.hub_tips ? "1" : "",
      hub_crew_photos: s.hub_crew_photos === true ? "1" : "",
      record_location: s.clock?.record_location === false ? "" : "1",
      breaks: breakPay(s),
      clock_mode: clockMode(s),
      geofence_mode: geofence(s).mode,
      geofence_radius: String(geofence(s).radius),
      complete_jobs: completesWhenVisitsDone(s) ? "1" : "",
      minimum_charge: String(minimumCharge(s) ?? ""),
      late_fee: fee?.type ?? "off", late_fee_amount: fee ? String(fee.amount) : "", late_fee_days: String(fee?.grace_days ?? 7),
    };
    setF(start);
    setLoaded(start);
  }, [details.data, f]);

  const save = useMutation({
    // The button says it saved. Only an address the map couldn't find is worth a toast, since it changes how routes start.
    meta: { inline: true, success: (r: { located: boolean | null }) => (r.located === false ? "Shop address not found on the map. Routes start from the first stop." : null) },
    mutationFn: async () => {
      const v = f!;
      // Kept to 0.0001%, as quotes and invoices keep it (8.875% stays 8.875%).
      const tax = taxRateFromPercent(v.default_tax_rate);
      if (!(Number(v.default_tax_rate) >= 0 && tax < 1)) throw new Error("Sales tax must be between 0 and 100%.");
      if (v.hours_end <= v.hours_start) throw new Error("The workday has to end after it starts.");
      if (!v.workdays) throw new Error("Pick at least one workday.");
      if (v.website && !/^https?:\/\//.test(v.website)) v.website = `https://${v.website}`;
      const privacy = privacyUrlTyped(v.privacy_url ?? "");
      if (privacy === "invalid") throw new Error("Enter the link to your privacy policy as a web address, like https://example.com/privacy.");
      const minimum = Number(v.minimum_charge || 0);
      if (!(minimum >= 0 && minimum <= 1_000_000)) throw new Error("Enter a minimum charge of 0 or more, or leave it empty.");
      let lateFee: LateFee | null = null;
      if (v.late_fee === "flat" || v.late_fee === "percent") {
        const amount = Number(v.late_fee_amount);
        const days = Number(v.late_fee_days || 0);
        if (!(amount > 0) || (v.late_fee === "percent" && amount > 100)) throw new Error(v.late_fee === "percent" ? "Enter a late fee between 0 and 100%." : "Enter the late fee amount.");
        if (!(Number.isInteger(days) && days >= 0 && days <= 365)) throw new Error("Enter the days after the due date, 0 to 365.");
        lateFee = { type: v.late_fee, amount: Math.round(amount * 100) / 100, grace_days: days };
      }
      const previous = (details.data?.settings ?? {}) as Record<string, any>;
      const address = { line1: v.line1.trim(), city: v.city.trim(), region: v.region.trim(), postal_code: v.postal_code.trim() };
      const oldAddress = (details.data?.address ?? {}) as Record<string, string>;
      let depot = previous.depot ?? null;
      let located: boolean | null = null;
      if (address.line1 && (address.line1 !== oldAddress.line1 || address.city !== oldAddress.city || !depot)) {
        const hit = await api.post<{ found: boolean; lat?: number; lng?: number; source?: string }>("/geocode", { address: [address.line1, address.city, address.region, address.postal_code].filter(Boolean).join(", ") }).catch(() => ({ found: false }) as { found: boolean; lat?: number; lng?: number; source?: string });
        located = hit.found;
        // With the geocoder that found it, as the server keeps for every spot on the map.
        depot = hit.found ? { lat: hit.lat, lng: hit.lng, source: hit.source } : null;
      }
      // Only the settings on this screen, merged into the ones saved when it saves (merge_company_settings),
      // so a change made since it opened (a weather rule, an app turned on) isn't undone.
      const settings = {
        payment_terms_days: Math.max(0, Math.round(Number(v.payment_terms_days) || 0)),
        default_tax_rate: tax,
        quote_valid_days: Math.max(1, Math.round(Number(v.quote_valid_days) || 30)),
        working_hours: { start: v.hours_start, end: v.hours_end, days: v.workdays.split(",").map(Number) },
        arrival_window_min: Number(v.arrival_window_min),
        branding: { color: v.color },
        hub_tips: v.hub_tips === "1",
        // Read by the server when it shows a client their visits (routes/public.ts): off unless chosen.
        hub_crew_photos: v.hub_crew_photos === "1",
        // mode: read by the database too, when a visit is finished (private.clock_mode).
        // geofence: the clock at the property, off unless chosen here (core/geofence.ts).
        clock: { record_location: v.record_location === "1", breaks: v.breaks, mode: v.clock_mode, geofence: { mode: v.geofence_mode, radius: geofenceRadius(v.geofence_radius) } },
        // Read by the database when a job's last visit is finished (private.completes_finished_jobs).
        jobs: { complete_when_visits_done: v.complete_jobs === "1" },
        // Both off unless set (the database adds the lines: 20261104000100 and 000200).
        minimum_charge: minimum > 0 ? Math.round(minimum * 100) / 100 : null,
        late_fee: lateFee,
        // Shown in the footer of the pages clients and the public use (core privacyPolicy.ts).
        privacy_url: privacy,
        // Only when the shop was looked up again: routes start there.
        ...(located !== null && { depot }),
      };
      unwrap(
        await supabase()
          .from("companies")
          .update({ name: v.name.trim(), phone: v.phone.trim() || null, email: v.email.trim() || null, website: v.website.trim() || null, timezone: v.timezone, currency: v.currency, address, ...(v.trade in PRESETS ? { trade_preset: v.trade } : {}) })
          .eq("id", company.id),
      );
      unwrap(await supabase().rpc("merge_company_settings", { p_company: company.id, p_settings: settings as never }));
      return { located };
    },
    onSuccess: () => {
      // What's on screen is what's saved now.
      setLoaded(f);
      queryClient.invalidateQueries({ queryKey: ["company", company.id] });
      session.refresh();
    },
  });

  const saved = useJustDone(save);
  if (details.isPending || !f) return details.error ? <ErrorState error={details.error} onRetry={() => details.refetch()} /> : <SectionSkeleton rows={8} />;
  const set = (key: string) => (e: { target: { value: string } }) => setF({ ...f, [key]: e.target.value });
  const unsaved = unsavedCount(f, loaded);
  const logo = ((details.data?.settings ?? {}) as Record<string, any>).branding?.logo ?? null;
  const days = f.workdays ? f.workdays.split(",").map(Number) : [];
  const ownColor = !BRAND_COLORS.some((c) => c.value === f.color);

  return (
    <>
    <form className="settings-body" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
      <Section level={3} title="Business">
        <div className="set-grid">
          <Field label="Business name"><input className="input" value={f.name} onChange={set("name")} required maxLength={200} /></Field>
          <Field label="Trade" hint="Picks your starter prices and terms. Paving and Roofing are apps: turn on either or both in Apps.">
            <Select className="select" value={f.trade} onChange={set("trade")}>
              {Object.values(PRESETS).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label="Phone"><input className="input" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: formatPhoneTyping(e.target.value) })} maxLength={40} /></Field>
          <Field label="Email"><input className="input" type="email" value={f.email} onChange={set("email")} maxLength={200} /></Field>
          <Field label="Website" optional><input className="input" value={f.website} onChange={set("website")} maxLength={200} placeholder="https://" /></Field>
          <Field label="Privacy policy link" optional hint="Shown at the bottom of your booking forms, Client Hub, referral, showcase and unsubscribe pages. Pages that collect personal details should link one.">
            <input className="input" value={f.privacy_url} onChange={set("privacy_url")} maxLength={PRIVACY_URL_MAX} placeholder="https://" />
          </Field>
          <div className="field set-full">
            <span>Logo <span className="optional">(quotes, invoices, Client Hub and emails)</span></span>
            <CompanyLogo path={logo} />
          </div>
          <div className="field set-full">
            <span id="brand-color-label">Brand color <span className="optional">(Client Hub and emails)</span></span>
            <div className="set-swatches" role="group" aria-labelledby="brand-color-label">
              {BRAND_COLORS.map((c) => <button key={c.value} type="button" className="set-swatch" aria-label={`Brand color: ${c.name}`} aria-pressed={f.color === c.value} title={c.name} onClick={() => setF({ ...f, color: c.value })} style={{ background: c.value }} />)}
              {/* A color box can't be pressed (aria-pressed): its ring is data-on, and its name says it's the one in use. */}
              <input type="color" className="set-swatch" value={f.color} onChange={set("color")} aria-label={ownColor ? "Custom brand color, in use" : "Custom brand color"} title="Your own color" data-on={ownColor || undefined} />
            </div>
          </div>
        </div>
        <div className="set-rows">
          <SwitchRow
            label="Show the crew's photos in the Client Hub"
            hint="On a client's visit, each person's profile photo in place of their initial, so they know who's coming. Never a subcontractor's. Off: initials only."
            checked={f.hub_crew_photos === "1"}
            onChange={(on) => setF({ ...f, hub_crew_photos: on ? "1" : "" })}
          />
        </div>
      </Section>
      <Section level={3} title="Shop address">
        <p className="set-note">Your postal address. It's shown at the bottom of marketing emails, which can't go out without a street or PO box, city, state and ZIP.</p>
        <div className="set-grid">
          <Field label="Street" className="set-full"><input className="input" value={f.line1} onChange={set("line1")} maxLength={200} /></Field>
          <div className="set-grid set-grid-3 set-full">
            <Field label="City"><input className="input" value={f.city} onChange={set("city")} maxLength={100} /></Field>
            <Field label="State / Province"><input className="input" value={f.region} onChange={set("region")} maxLength={20} /></Field>
            <Field label="ZIP / Postal code"><input className="input" value={f.postal_code} onChange={set("postal_code")} maxLength={12} /></Field>
          </div>
        </div>
      </Section>
      <Section level={3} title="Defaults">
        <div className="set-grid">
          <Field label="Time zone">
            <Select className="select" value={f.timezone} onChange={set("timezone")}>
              {timeZoneChoices(f.timezone).map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
            </Select>
          </Field>
          <Field label="Currency" hint="Changing it doesn't convert amounts already saved.">
            <Select className="select" value={f.currency} onChange={set("currency")}>
              {!CURRENCIES.some((c) => c.code === f.currency) && <option value={f.currency}>{f.currency}</option>}
              {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}
            </Select>
          </Field>
          <Field label={<>Sales tax<span className="sr-only"> (%)</span></>}>
            <Suffix unit="%"><input className="input" inputMode="decimal" value={f.default_tax_rate} onChange={(e) => setF({ ...f, default_tax_rate: e.target.value.replace(/[^0-9.]/g, "") })} /></Suffix>
          </Field>
          <Field label={<>Invoice due after<span className="sr-only"> (days)</span></>} hint="0 means due on receipt. A client can have their own, on their page.">
            <Suffix unit="days"><NumberInput className="input" min={0} max={365} value={f.payment_terms_days} onChange={set("payment_terms_days")} /></Suffix>
          </Field>
          <Field label={<>Quotes valid for<span className="sr-only"> (days)</span></>}>
            <Suffix unit="days"><NumberInput className="input" min={1} max={365} value={f.quote_valid_days} onChange={set("quote_valid_days")} /></Suffix>
          </Field>
          <Field label="Minimum charge" optional hint="An invoice under it gets a Minimum charge line that makes up the difference.">
            <input className="input" inputMode="decimal" value={f.minimum_charge} placeholder="Off" onChange={(e) => setF({ ...f, minimum_charge: e.target.value.replace(/[^0-9.]/g, "") })} />
          </Field>
          <Field label="Late fee" className="set-full" hint={f.late_fee === "off" ? "Added once to an invoice still unpaid after its due date." : `Added once, if it's still unpaid that many days after it's due. Late fees aren't taxed. You can take one off an invoice, or turn them off for it, on the invoice. ${LATE_FEE_LAW_NOTE}`}>
            <Select className="select set-narrow" value={f.late_fee} onChange={set("late_fee")}>
              <option value="off">Off</option>
              <option value="flat">A flat amount</option>
              <option value="percent">A percent of what's owed</option>
            </Select>
          </Field>
          {f.late_fee !== "off" && (
            <>
              <Field label={f.late_fee === "percent" ? "Late fee (%)" : "Late fee amount"}>
                <input className="input" inputMode="decimal" value={f.late_fee_amount} onChange={(e) => setF({ ...f, late_fee_amount: e.target.value.replace(/[^0-9.]/g, "") })} required />
              </Field>
              <Field label={<>Days after the due date<span className="sr-only"> (days)</span></>}>
                <Suffix unit="days"><NumberInput className="input" min={0} max={365} value={f.late_fee_days} onChange={set("late_fee_days")} /></Suffix>
              </Field>
            </>
          )}
        </div>
        <div className="set-rows">
          {/* The one switch for tips (settings.hub_tips): the Client Hub, the receipt and the server all follow it. */}
          <SwitchRow
            label="Let clients add a tip when they pay online"
            hint={<>Also offered on the receipt after an automatic charge. Off: no tip choice anywhere, and no tip is charged. {TIPS_LAW_NOTE}</>}
            checked={f.hub_tips === "1"}
            onChange={(on) => setF({ ...f, hub_tips: on ? "1" : "" })}
          />
        </div>
      </Section>
      <Section level={3} title="Workday">
        <div className="set-grid">
          <Field label="Workday starts"><input className="input" type="time" value={f.hours_start} onChange={set("hours_start")} /></Field>
          <Field label="Workday ends"><input className="input" type="time" value={f.hours_end} onChange={set("hours_end")} /></Field>
          <div className="field set-full">
            <span id="workdays-label">Workdays</span>
            <div className="segmented set-days" role="group" aria-labelledby="workdays-label">
              {WEEK.map(([d, label]) => {
                const on = days.includes(d);
                return (
                  <button key={d} type="button" aria-pressed={on} onClick={() => setF({ ...f, workdays: (on ? days.filter((x) => x !== d) : [...days, d]).sort().join(",") })}>
                    {label}
                  </button>
                );
              })}
            </div>
            <span className="hint">Find a time and clients moving a visit online only get these days.</span>
          </div>
          <Field label="Arrival window" className="set-full" hint="What clients are told in their portal and reminders, like “between 9:00 AM and 11:00 AM”.">
            <Select className="select set-narrow" value={f.arrival_window_min} onChange={set("arrival_window_min")}>
              <option value="0">None: the start time</option>
              {[30, 60, 120, 180, 240].map((m) => <option key={m} value={m}>{m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? "s" : ""}`}</option>)}
            </Select>
          </Field>
        </div>
      </Section>
      <Section level={3} title="Jobs">
        <div className="set-rows">
          <SwitchRow
            label="When the last visit of a one-off job is finished, mark the work complete"
            hint="The job moves to Requires invoicing and the people who handle invoices are told. A job on autopay isn't marked, since that charges the card: they're told to mark it themselves. Off: jobs wait for Mark work complete, and they're still told."
            checked={f.complete_jobs === "1"}
            onChange={(on) => setF({ ...f, complete_jobs: on ? "1" : "" })}
          />
        </div>
      </Section>
      <Section level={3} title="Time clock">
        <div className="set-grid">
          <Field label="How the clock works" hint={CLOCK_MODE_HINTS[f.clock_mode as ClockMode]}>
            <Select className="select" value={f.clock_mode} onChange={set("clock_mode")}>
              {(Object.keys(CLOCK_MODE_LABELS) as ClockMode[]).map((m) => <option key={m} value={m}>{CLOCK_MODE_LABELS[m]}</option>)}
            </Select>
          </Field>
          <Field label="Breaks" hint={BREAK_PAY_HINTS[f.breaks as BreakPay]}>
            <Select className="select" value={f.breaks} onChange={set("breaks")}>
              {(Object.keys(BREAK_PAY_LABELS) as BreakPay[]).map((b) => <option key={b} value={b}>{BREAK_PAY_LABELS[b]}</option>)}
            </Select>
          </Field>
          <Field label="At the property" hint={f.geofence_mode === "off" ? GEOFENCE_MODE_HINTS.off : `${GEOFENCE_MODE_HINTS[f.geofence_mode as GeofenceMode]} ${GEOFENCE_NOTE}`}>
            <Select className="select" value={f.geofence_mode} onChange={set("geofence_mode")}>
              {(Object.keys(GEOFENCE_MODE_LABELS) as GeofenceMode[]).map((m) => <option key={m} value={m}>{GEOFENCE_MODE_LABELS[m]}</option>)}
            </Select>
          </Field>
          {f.geofence_mode !== "off" && (
            <Field label="How close counts as there" hint="The phone compares where it is with the property's spot on the map itself. Where it was is saved only if the switch below is on.">
              <Select className="select" value={f.geofence_radius} onChange={set("geofence_radius")}>
                {!RADII.includes(Number(f.geofence_radius)) && <option value={f.geofence_radius}>{radiusLabel(Number(f.geofence_radius))}</option>}
                {RADII.map((m) => <option key={m} value={m}>{radiusLabel(m)}{m === GEOFENCE_RADIUS.default ? " (usual)" : ""}</option>)}
              </Select>
            </Field>
          )}
        </div>
        <div className="set-rows">
          <SwitchRow
            label="Save where people are when they clock in and out"
            hint="The office and crew leads see it on Timesheets."
            checked={f.record_location === "1"}
            onChange={(on) => setF({ ...f, record_location: on ? "1" : "" })}
          />
        </div>
      </Section>
      <FormError error={save.error} />
      <SaveBar note={unsaved ? (unsaved === 1 ? "1 unsaved change" : `${unsaved} unsaved changes`) : null}>
        <Button type="submit" variant="primary" loading={save.isPending} done={saved}>Save company settings</Button>
        <FormChecks />
      </SaveBar>
    </form>
    {/* Saved by itself: the hourly profit check goes by when its line changes. */}
    <JobCostSettings settings={(details.data?.settings ?? {}) as Record<string, unknown>} />
    {/* Saved by itself, through the database's own function: not one of the settings above. */}
    <NextNumbers />
    <QuoteSettings />
    </>
  );
}
