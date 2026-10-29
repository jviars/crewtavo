/**
 * Settings → Maps: the imagery the measuring map draws on. Free US imagery needs nothing. A key
 * from Esri (free account) or Google adds sharp imagery worldwide; it's checked before it's saved,
 * and kept in the company's settings (settings.maps), since it's a browser key the whole team's map
 * uses anyway. What Measure opens on for the team is kept there too (each person can pick their
 * own in Settings → Profile).
 */
import { STATE_IMAGERY, type MapKeys, type MapSettings } from "@crewtavo/core/imagery";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { SaveStatus, useSaveStatus } from "@/components/ui/SaveStatus";
import { CardSkeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useSession } from "@/lib/session";
import { AUTO_NAME, checkEsriKey, checkGoogleKey, choiceName, DEFAULT_CHOICES, imageryUsable, mapKeys, teamDefault, type ImageryChoice } from "../measure/imagery";

type Provider = "esri" | "google";
const FIELD: Record<Provider, keyof MapKeys> = { esri: "esri_key", google: "google_key" };

export function MapsSettings() {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ["company", company.id, "settings"],
    queryFn: async () => unwrap(await supabase().from("companies").select("settings").eq("id", company.id).single()).settings as Record<string, unknown> | null,
  });

  const writeMaps = async (patch: MapSettings) => {
    // Read the settings fresh, so a change someone made meanwhile isn't undone.
    const current = (unwrap(await supabase().from("companies").select("settings").eq("id", company.id).single()).settings ?? {}) as Record<string, unknown>;
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
      await writeMaps({ [FIELD[provider]]: key });
      return { provider, key };
    },
    onSuccess: ({ provider, key }) => {
      saved();
      if (key) toast.success(`${provider === "esri" ? "Esri" : "Google"} imagery is ready`, { description: "Pick it from the Imagery button on Measure, or make it the team's default above." });
      else toast.success("Key removed");
    },
  });
  // The team's map saves as it's picked, and says so beside the menu.
  const choosing = useSaveStatus();
  const saveDefault = useMutation({
    meta: { inline: true },
    mutationFn: (choice: ImageryChoice) => writeMaps({ default_imagery: choice }),
    onSuccess: saved,
  });

  if (settings.isPending) return <CardSkeleton lines={6} />;
  if (settings.error) return <div className="card"><ErrorState error={settings.error} onRetry={() => settings.refetch()} /></div>;
  const keys = ((settings.data ?? {}).maps ?? {}) as MapKeys;
  const deploymentGoogle = Boolean(session.config.mapsBrowserKey);
  const usableKeys = mapKeys(settings.data ?? {}, session.config.mapsBrowserKey);
  const opening = saveDefault.isPending ? saveDefault.variables : teamDefault(settings.data ?? {}, usableKeys) ?? "auto";

  return (
    <div className="stack" style={{ maxWidth: 860 }}>
      <div className="card card-pad stack-sm">
        <div className="row" style={{ gap: 10 }}>
          <span className="maps-settings-icon" aria-hidden="true"><Icon name="map" size={20} /></span>
          <strong>Free imagery, nothing to set up</strong>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          <strong>{AUTO_NAME}</strong> picks the sharpest free imagery for wherever the map is: the state's own imagery where it publishes some
          ({STATE_IMAGERY.filter((s) => s.state !== "DC").length} states and Washington, DC today, 3 in to 1 ft per pixel: {STATE_IMAGERY.map((s) => s.name).join(", ")}),
          else US aerial imagery (NAIP, every lower-48 state, about 2 ft), else USGS. None of it needs an account.
        </p>
        <p className="muted" style={{ margin: 0 }}>
          Terrain, slope and 2 ft contour lines come free from USGS lidar across most of the US. Anywhere in the world you can also draw on the street map, which
          shows streets and building outlines.
        </p>
      </div>

      <div className="card card-pad stack-sm">
        <div className="row" style={{ gap: 10 }}>
          <span className="maps-settings-icon" aria-hidden="true"><Icon name="layers" size={20} /></span>
          <strong id="team-map-title">What Measure opens on</strong>
        </div>
        <div className="row wrap" style={{ gap: 12 }}>
          <select
            className="select"
            aria-labelledby="team-map-title"
            aria-describedby="team-map-help"
            style={{ maxWidth: 320 }}
            value={opening}
            disabled={saveDefault.isPending}
            onChange={(e) => void choosing.track(saveDefault.mutateAsync(e.target.value as ImageryChoice))}
          >
            {DEFAULT_CHOICES.map((c) => {
              const ready = c === "auto" || imageryUsable(c, usableKeys);
              return <option key={c} value={c} disabled={!ready}>{choiceName(c)}{c === "auto" ? " (recommended)" : ready ? "" : " (add a key below)"}</option>;
            })}
          </select>
          <SaveStatus status={choosing.status} />
        </div>
        <span id="team-map-help" className="muted small">
          For everyone on the team. Anyone can still switch from the Imagery button on Measure, and each person can pick their own in Settings › Profile.
        </span>
        <FormError error={saveDefault.error} />
      </div>

      <KeyCard
        provider="esri"
        title="Esri World Imagery"
        badge="Recommended for work outside the US"
        current={keys.esri_key ?? null}
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
        current={keys.google_key ?? null}
        inherited={!keys.google_key && deploymentGoogle}
        saving={save.isPending && save.variables?.provider === "google"}
        error={save.variables?.provider === "google" ? save.error : null}
        onSave={(key) => save.mutate({ provider: "google", key })}
        intro="Google's satellite imagery, worldwide. Google needs a billing account on the project; its Map Tiles API includes 100,000 tiles a month at no charge."
        steps={[
          <>In the <a href="https://console.cloud.google.com/" target="_blank" rel="noreferrer">Google Cloud console</a>, pick or create a project with billing turned on.</>,
          <>Under <strong>APIs &amp; Services</strong>, enable the <strong>Map Tiles API</strong>.</>,
          <>Create an API key. Restrict it to the Map Tiles API and to the website <code>{location.origin}/*</code>.</>,
          <>Paste the key below.</>,
        ]}
      />

      <p className="muted small" style={{ margin: 0 }}>
        These keys are used in your team's browsers when they measure, the same way any website shows a map. That's why each one should be limited to your web
        address in Esri or Google.
      </p>
    </div>
  );
}

function KeyCard({
  provider, title, badge, current, inherited, intro, steps, saving, error, onSave,
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
    <div className="card card-pad stack">
      <div className="row-between wrap" style={{ gap: 8 }}>
        <div className="row" style={{ gap: 10 }}>
          <span className="maps-settings-icon" aria-hidden="true"><Icon name="globe" size={20} /></span>
          <strong>{title}</strong>
          <span className="chip">{badge}</span>
        </div>
        {set ? (
          <span className="chip chip-green"><Icon name="check" size={14} /> Working · key ending {current!.slice(-4)}</span>
        ) : inherited ? (
          <span className="chip chip-green"><Icon name="check" size={14} /> Set up by whoever installed Crewtavo</span>
        ) : (
          <span className="chip">Not set up</span>
        )}
      </div>
      <p className="muted" style={{ margin: 0 }}>{intro}</p>
      {open ? (
        <>
          <ol className="maps-steps">{steps.map((step, i) => <li key={i}>{step}</li>)}</ol>
          <form className="stack-sm" onSubmit={submit}>
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
            <span id={`${provider}-key-help`} className="muted small">We try the key with {provider === "esri" ? "Esri" : "Google"} before saving it, and tell you what to fix if it doesn't work.</span>
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
              if (await confirm({ title: `Remove the ${title} key?`, body: "Measure goes back to the free imagery. Drawings already saved keep their pictures.", confirmLabel: "Remove", danger: true })) onSave(null);
            }}
          >
            Remove
          </Button>
        </div>
      )}
    </div>
  );
}
