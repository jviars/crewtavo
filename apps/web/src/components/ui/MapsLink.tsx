/**
 * An address or a Directions button that opens the person's maps app: the one they chose to always
 * use on this device, or else a sheet to pick one (Apple Maps, Google Maps, Waze, and on Android any
 * installed app). A route button does the same for a whole day's stops. See lib/maps.ts.
 * Without a className it's an address in the app's link style (.address-link).
 */
import { Fragment, useState, type ReactNode } from "react";
import { copyText } from "@/lib/clipboard";
import { MAPS_LABELS, mapsApps, mapsUrl, placeText, rememberApp, rememberedApp, routeApp, routeApps, routeLegs, type MapsApp, type Place, type Route, type RouteApp } from "@/lib/maps";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";

export function MapsLink({ place, className = "address-link", title, children }: { place: Place; className?: string; title?: string; children: ReactNode }) {
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
              <Icon name={app === "other" ? "apps" : "navigation"} size={20} />
              {MAPS_LABELS[app]}
            </a>
          ))}
          {text && (
            <button type="button" className="btn big-action" onClick={() => { void copyText(text, "Address copied"); onClose(); }}>
              <Icon name="copy" size={20} />
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

/**
 * Opens a whole route in Apple Maps or Google Maps: straight away when this device remembers the app
 * and the route fits one link, or else a sheet to pick the app and, for a long day, the part.
 */
export function RouteMapsLink({ route, className, title, children }: { route: Route; className?: string; title?: string; children: ReactNode }) {
  const [choosing, setChoosing] = useState(false);
  const app = routeApp();
  const legs = app ? routeLegs(app, route) : [];
  if (app && legs.length === 1) {
    return (
      <a className={className} href={legs[0]!.url} target="_blank" rel="noreferrer" title={title ?? `Open the route in ${MAPS_LABELS[app]}`}>
        {children}
      </a>
    );
  }
  return (
    <>
      <button type="button" className={className} title={title ?? "Open the route in a maps app"} onClick={() => setChoosing(true)}>
        {children}
      </button>
      {choosing && <RouteChooser route={route} apps={app ? [app] : routeApps()} onClose={() => setChoosing(false)} />}
    </>
  );
}

function RouteChooser({ route, apps, onClose }: { route: Route; apps: RouteApp[]; onClose: () => void }) {
  const [always, setAlways] = useState(false);
  const pick = (app: RouteApp) => {
    if (always) rememberApp(app);
    onClose();
  };
  const choices = apps.map((app) => ({ app, legs: routeLegs(app, route) }));
  const count = route.stops.length;
  const stops = `${count} ${count === 1 ? "stop" : "stops"}`;
  const description = route.start ? `${stops}, from the shop${route.end ? " and back" : ""}` : `${stops} from where you are${route.end ? ", then back to the shop" : ""}`;
  const link = (app: RouteApp, url: string, label: string) => (
    <a key={url} className="btn big-action" href={url} target="_blank" rel="noreferrer" onClick={() => pick(app)}>
      <Icon name="navigation" size={20} />
      {label}
    </a>
  );
  return (
    <Dialog open onClose={onClose} title="Open route in" description={description} size="sm">
      <div className="dialog-body">
        <div className="maps-choices">
          {choices.map(({ app, legs }) =>
            legs.length === 1 ? (
              link(app, legs[0]!.url, MAPS_LABELS[app])
            ) : (
              <Fragment key={app}>
                <strong className="small">{MAPS_LABELS[app]}</strong>
                {legs.map((leg, i) => link(app, leg.url, `Part ${i + 1} · ${leg.last - leg.first + 1} ${leg.last === leg.first ? "stop" : "stops"}${leg.back ? ", then the shop" : ""}`))}
              </Fragment>
            ),
          )}
        </div>
        {apps.length > 1 && (
          <label className="checkbox">
            <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
            <span>Always use this app on this device</span>
          </label>
        )}
        <span className="muted small">
          {choices.some((c) => c.legs.length > 1) && "Maps apps take only so many stops at once, so a long day opens in parts. Open the next part when you finish one. "}
          An app that isn't installed opens its website instead.
        </span>
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
