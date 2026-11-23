/**
 * Settings → Maps: the imagery the measuring map draws on. Free US imagery needs nothing. A key
 * from Esri (free account) or Google adds sharp imagery worldwide; it's checked before it's saved,
 * and kept in the company's settings (settings.maps), since it's a browser key the whole team's map
 * uses anyway. With the company's own Google key, Auto starts on Google satellite, and address boxes
 * can suggest places from Google instead of OpenStreetMap (settings.maps.google_places, checked with
 * Google before it's turned on). What Measure opens on for the team is kept there too (each person
 * can pick their own in Settings → Profile).
 */
import { STATE_IMAGERY, type MapKeys, type MapSettings } from "@crewtavo/core/imagery";
import { GOOGLE_MAPS_TERMS_URL, GOOGLE_PRIVACY_URL } from "@crewtavo/core/terms";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { SaveStatus, useSaveStatus } from "@/components/ui/SaveStatus";
import { Section } from "@/components/ui/Section";
import { SectionSkeleton } from "@/components/ui/Skeleton";
import { StatusPill } from "@/components/ui/StatusPill";
import { ErrorState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useSession } from "@/lib/session";
import { checkGooglePlaces } from "../measure/googlePlaces";
import { SwitchRow } from "./SettingsKit";
import { AUTO_NAME, checkEsriKey, checkGoogleKey, choiceName, DEFAULT_CHOICES, googleFirst, imageryUsable, mapKeys, teamDefault, type ImageryChoice } from "../measure/imagery";
import { loadSettings } from "@/lib/companySettings";
import { Select } from "@/components/ui/Select";

type Provider = "esri" | "google";
const FIELD: Record<Provider, keyof MapKeys> = { esri: "esri_key", google: "google_key" };

export function MapsSettings() {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ["company", company.id, "settings"],
    queryFn: async (): Promise<Record<string, unknown> | null> => loadSettings(company.id),
  });
  const maps = ((settings.data ?? {}).maps ?? {}) as MapSettings;

  const writeMaps = async (patch: MapSettings) => {
    // Read the settings fresh, so a change someone made meanwhile isn't undone.
    const current = await loadSettings(company.id);
    const maps = { ...((current.maps ?? {}) as MapSettings), ...patch };
    unwrap(await supabase().from("companies").update({ settings: { ...current, maps } as never }).eq("id", company.id));
  };
  const saved = () => {
    queryClient.invalidateQueries({ queryKey: ["company", company.id] });
    session.refresh();
  };
  const save = useMutation({
    meta: { inline: true },
    mutationFn: async ({ provider, key }: { provider: Provider; key: string | null }) => {
      if (key) {
        const problem = provider === "esri" ? await checkEsriKey(key) : await checkGoogleKey(key);
        if (problem) throw new Error(problem);
      }
      // A new Google key keeps Google's address suggestions only if it can give them.
      const placesProblem = provider === "google" && key && maps.google_places ? await checkGooglePlaces(key) : null;
      await writeMaps({ [FIELD[provider]]: key, ...(placesProblem ? { google_places: false } : {}) });
      return { provider, key, placesProblem };
    },
    onSuccess: ({ provider, key, placesProblem }) => {
      saved();
      if (placesProblem) toast.error("Google imagery is ready, but address suggestions are back on OpenStreetMap", { description: placesProblem });
      else if (key) toast.success(`${provider === "esri" ? "Esri" : "Google"} imagery is ready`, { description: provider === "google" ? "Auto on Measure starts with it now. You can also have address boxes suggest places from Google, below." : "Pick it from the Imagery button on Measure, or make it the team's default above." });
      else toast.success("Key removed");
    },
  });
  // Address suggestions from Google, once the key is shown to give them.
  const places = useMutation({
    meta: { inline: true },
    mutationFn: async (on: boolean) => {
      const key = maps.google_key;
      if (on) {
        if (!key) throw new Error("Add a Google key first.");
        const problem = await checkGooglePlaces(key);
        if (problem) throw new Error(problem);
      }
      await writeMaps({ google_places: on });
      return on;
    },
    onSuccess: (on) => {
      saved();
      toast.success(on ? "Addresses are suggested from Google now" : "Addresses are suggested from OpenStreetMap again");
    },
  });
  // The team's map saves as it's picked, and says so beside the menu.
  const choosing = useSaveStatus();
  const saveDefault = useMutation({
    meta: { inline: true },
    mutationFn: (choice: ImageryChoice) => writeMaps({ default_imagery: choice }),
    onSuccess: saved,
  });

  if (settings.isPending) return <SectionSkeleton rows={6} />;
  if (settings.error) return <ErrorState error={settings.error} onRetry={() => settings.refetch()} />;
  const deploymentGoogle = Boolean(session.config.mapsBrowserKey);
  const usableKeys = mapKeys(settings.data ?? {}, session.config.mapsBrowserKey);
  const opening = saveDefault.isPending ? saveDefault.variables : teamDefault(settings.data ?? {}, usableKeys) ?? "auto";

  return (
    <>
      <Section level={3} title="Free imagery, nothing to set up">
        <div className="set-stack">
        <p className="set-note">
          <strong>{AUTO_NAME}</strong> picks the sharpest free imagery for wherever the map is: the state's own imagery where it publishes some
          ({STATE_IMAGERY.filter((s) => s.state !== "DC").length} states and Washington, DC today, 3 in to 1 ft per pixel: {STATE_IMAGERY.map((s) => s.name).join(", ")}),
          else US aerial imagery (NAIP, every lower-48 state, about 2 ft), else USGS. None of it needs an account.
        </p>
        <p className="set-note">
          Terrain, slope and 2 ft contour lines come free from USGS lidar across most of the US. Anywhere in the world you can also draw on the street map, which
          shows streets and building outlines.
        </p>
        </div>
      </Section>

      <Section level={3} title={<span id="team-map-title">What Measure opens on</span>} action={<SaveStatus status={choosing.status} />}>
        <div className="set-stack">
          <Select
            className="select set-narrow"
            aria-labelledby="team-map-title"
            aria-describedby="team-map-help"
            value={opening}
            disabled={saveDefault.isPending}
            onChange={(e) => void choosing.track(saveDefault.mutateAsync(e.target.value as ImageryChoice))}
          >
            {DEFAULT_CHOICES.map((c) => {
              const ready = c === "auto" || imageryUsable(c, usableKeys);
              return <option key={c} value={c} disabled={!ready}>{choiceName(c)}{c === "auto" ? " (recommended)" : ready ? "" : " (add a key below)"}</option>;
            })}
          </Select>
        <p id="team-map-help" className="set-note">
          For everyone on the team. Anyone can still switch from the Imagery button on Measure, and each person can pick their own in Settings › Profile.
          {googleFirst(usableKeys)
            ? ` With your Google key below, ${AUTO_NAME} starts on Google satellite (the picture saved with a drawing still uses free imagery, as Google's terms ask).`
            : ` Add your own Google key below and ${AUTO_NAME} starts on Google satellite.`}
        </p>
        <FormError error={saveDefault.error} />
        </div>
      </Section>

      <KeyCard
        provider="esri"
        title="Esri World Imagery"
        badge="Recommended for work outside the US"
        current={maps.esri_key ?? null}
        saving={save.isPending && save.variables?.provider === "esri"}
        error={save.variables?.provider === "esri" ? save.error : null}
        onSave={(key) => save.mutate({ provider: "esri", key })}
        intro="Sharp aerial imagery almost everywhere on Earth. Esri's free plan includes 2 million map tiles a month, enough for thousands of measurements. If a month ever runs past that, Esri pauses the imagery until the next month unless you turn on pay-as-you-go, so there are no surprise bills."
        steps={[
          <>Make a free account at <a href="https://location.arcgis.com/sign-up/" target="_blank" rel="noreferrer">ArcGIS Location Platform</a>.</>,
          <>In the dashboard, open <strong>Developer credentials</strong>, then <strong>New developer credential</strong> and choose <strong>API key credentials</strong>.</>,
          <>Under privileges, open <strong>Location services</strong> and tick <strong>Basemaps</strong>.</>,
          <>Under referrers, add <code>{location.origin}</code> so the key only works on your Crewtavo.</>,
          <>Copy the API key (it starts with <code>AAPT</code> or <code>AAPK</code>) and paste it below.</>,
        ]}
      />

      <KeyCard
        provider="google"
        title="Google satellite"
        badge="Needs Google Cloud"
        current={maps.google_key ?? null}
        inherited={!maps.google_key && deploymentGoogle}
        saving={save.isPending && save.variables?.provider === "google"}
        error={save.variables?.provider === "google" ? save.error : null}
        onSave={(key) => save.mutate({ provider: "google", key })}
        intro="Google's satellite imagery, worldwide, and Auto on Measure starts with it. Google needs a billing account on the project; its Map Tiles API includes 100,000 tiles a month at no charge."
        steps={[
          <>In the <a href="https://console.cloud.google.com/" target="_blank" rel="noreferrer">Google Cloud console</a>, pick or create a project with billing turned on.</>,
          <>Under <strong>APIs &amp; Services</strong>, enable the <strong>Map Tiles API</strong>. For address suggestions from Google too, also enable <strong>Places API (New)</strong>.</>,
          <>Create an API key. Restrict it to those APIs and to the website <code>{location.origin}/*</code>.</>,
          <>Paste the key below.</>,
        ]}
        footnote={
          <>
            Google Maps features and content in Crewtavo are subject to the{" "}
            <a href={GOOGLE_MAPS_TERMS_URL} target="_blank" rel="noreferrer">Google Maps/Google Earth Additional Terms of Service</a> and the{" "}
            <a href={GOOGLE_PRIVACY_URL} target="_blank" rel="noreferrer">Google Privacy Policy</a>.
          </>
        }
      >
        {maps.google_key && (
          <div className="set-rows">
            <SwitchRow
              label="Suggest addresses from Google"
              hint={places.isPending && places.variables
                ? "Checking the key with Google…"
                : "As anyone types an address, in calendar entries and on Measure while it shows Google satellite, the places suggested come from Google Maps instead of OpenStreetMap. Your clients' own addresses still come first. Needs Places API (New) on this key; Google includes 10,000 lookups a month at no charge."}
              checked={places.isPending ? Boolean(places.variables) : Boolean(maps.google_places)}
              disabled={places.isPending}
              onChange={(on) => places.mutate(on)}
            >
              <FormError error={places.error} />
            </SwitchRow>
          </div>
        )}
      </KeyCard>

      <p className="set-note">
        These keys are used in your team's browsers when they measure, the same way any website shows a map. That's why each one should be limited to your web
        address in Esri or Google.
      </p>
    </>
  );
}

function KeyCard({
  provider, title, badge, current, inherited, intro, steps, saving, error, onSave, children, footnote,
}: {
  provider: Provider;
  title: string;
  badge: string;
  current: string | null;
  /** The deployment set a Google key for everyone; a company key replaces it. */
  inherited?: boolean;
  intro: string;
  steps: ReactNode[];
  saving: boolean;
  error: unknown;
  onSave: (key: string | null) => void;
  /** More settings for this key, shown once it's saved. */
  children?: ReactNode;
  /** A line under the card, key or no key: whose terms using this provider's maps comes under. */
  footnote?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const key = value.trim();
    if (key.length < 20) return;
    onSave(key);
  };
  const set = Boolean(current);
  const open = editing || !set;
  // Saved or removed: close the form.
  useEffect(() => {
    setEditing(false);
    setValue("");
    setShown(false);
  }, [current]);

  return (
    <Section
      level={3}
      title={<>{title} <span className="set-tag">{badge}</span></>}
      action={set ? <StatusPill tone="good" label={`Working · key ending ${current!.slice(-4)}`} /> : inherited ? <StatusPill tone="good" label="Set up by whoever installed Crewtavo" /> : <StatusPill tone="muted" label="Not set up" />}
    >
      <div className="set-stack">
      <p className="set-note">{intro}</p>
      {open ? (
        <>
          <ol className="maps-steps">{steps.map((step, i) => <li key={i}>{step}</li>)}</ol>
          <form className="set-stack" onSubmit={submit}>
            <Field label={`${title} key`}>
              <div className="row" style={{ gap: 6 }}>
                <input
                  className="input grow"
                  type={shown ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={provider === "esri" ? "AAPT…" : "AIza…"}
                  required
                  minLength={20}
                  aria-describedby={`${provider}-key-help`}
                />
                <button type="button" className="btn btn-icon" onClick={() => setShown(!shown)} aria-label={shown ? "Hide key" : "Show key"} aria-pressed={shown}><Icon name="eye" size={16} /></button>
              </div>
            </Field>
            <span id={`${provider}-key-help`} className="set-note">We try the key with {provider === "esri" ? "Esri" : "Google"} before saving it, and tell you what to fix if it doesn't work.</span>
            <FormError error={error} />
            <div className="row" style={{ gap: 8 }}>
              <Button type="submit" loading={saving}>{saving ? "Checking the key…" : "Check and save"}</Button>
              {set && <Button variant="ghost" onClick={() => { setEditing(false); setValue(""); }}>Cancel</Button>}
            </div>
          </form>
        </>
      ) : (
        <div className="row" style={{ gap: 8 }}>
          <Button size="sm" onClick={() => setEditing(true)}>Replace key</Button>
          <Button
            size="sm"
            variant="ghost"
            icon="trash"
            onClick={async () => {
              if (await confirm({ title: `Remove the ${title} key?`, body: provider === "google" ? "Measure goes back to the free imagery, and address boxes to OpenStreetMap's suggestions. Drawings already saved keep their pictures." : "Measure goes back to the free imagery. Drawings already saved keep their pictures.", confirmLabel: "Remove", danger: true })) onSave(null);
            }}
          >
            Remove
          </Button>
        </div>
      )}
      {set && children}
      {footnote && <p className="set-note">{footnote}</p>}
      </div>
    </Section>
  );
}
