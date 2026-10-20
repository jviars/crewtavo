/**
 * An address or a Directions button that opens the person's maps app: the one they chose to always
 * use on this device, or else a sheet to pick one (Apple Maps, Google Maps, Waze, and on Android any
 * installed app). See lib/maps.ts.
 */
import { useState, type ReactNode } from "react";
import { copyText } from "@/lib/clipboard";
import { MAPS_LABELS, mapsApps, mapsUrl, placeText, rememberApp, rememberedApp, type MapsApp, type Place } from "@/lib/maps";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";

export function MapsLink({ place, className, title, children }: { place: Place; className?: string; title?: string; children: ReactNode }) {
  const [choosing, setChoosing] = useState(false);
  const app = rememberedApp();
  if (app) {
    return (
      <a className={className} href={mapsUrl(app, place)} target={app === "other" ? undefined : "_blank"} rel="noreferrer" title={title ?? `Open in ${MAPS_LABELS[app]}`}>
        {children}
      </a>
    );
  }
  return (
    <>
      <button type="button" className={className} title={title ?? "Open in a maps app"} onClick={() => setChoosing(true)}>
        {children}
      </button>
      {choosing && <MapsChooser place={place} onClose={() => setChoosing(false)} />}
    </>
  );
}

export function MapsChooser({ place, onClose }: { place: Place; onClose: () => void }) {
  const [always, setAlways] = useState(false);
  const text = placeText(place);
  const pick = (app: MapsApp) => {
    if (always) rememberApp(app);
    onClose();
  };
  return (
    <Dialog open onClose={onClose} title="Open in" description={text || undefined} size="sm">
      <div className="dialog-body">
        <div className="maps-choices">
          {mapsApps().map((app) => (
            <a key={app} className="btn big-action" href={mapsUrl(app, place)} target={app === "other" ? undefined : "_blank"} rel="noreferrer" onClick={() => pick(app)}>
              <Icon name={app === "other" ? "apps" : "navigation"} size={18} />
              {MAPS_LABELS[app]}
            </a>
          ))}
          {text && (
            <button type="button" className="btn big-action" onClick={() => { void copyText(text, "Address copied"); onClose(); }}>
              <Icon name="copy" size={18} />
              Copy address
            </button>
          )}
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
          <span>Always use this app on this device</span>
        </label>
        <span className="muted small">An app that isn't installed opens its website instead. Change this in Settings → Profile.</span>
      </div>
    </Dialog>
  );
}

/** Settings → Profile: which app directions open in on this device. */
export function MapsAppSetting() {
  const [app, setApp] = useState<MapsApp | "">(() => rememberedApp() ?? "");
  return (
    <div className="card card-pad stack-sm">
      <strong id="maps-app-title">Directions</strong>
      <select
        className="select"
        aria-labelledby="maps-app-title"
        style={{ maxWidth: 280 }}
        value={app}
        onChange={(e) => {
          const next = e.target.value as MapsApp | "";
          setApp(next);
          rememberApp(next || null);
        }}
      >
        <option value="">Ask which app each time</option>
        {mapsApps().map((a) => <option key={a} value={a}>{MAPS_LABELS[a]}</option>)}
      </select>
      <span className="muted small">Tapping an address or Directions opens this app. Saved on this device.</span>
    </div>
  );
}
