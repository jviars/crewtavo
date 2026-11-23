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
import { t } from "@/lib/i18n";
import { Select } from "./Select";

export function MapsLink({ place, className = "address-link", title, children }: { place: Place; className?: string; title?: string; children: ReactNode }) {
  const [choosing, setChoosing] = useState(false);
  const app = rememberedApp();
  if (app) {
    return (
      <a className={className} href={mapsUrl(app, place)} target={app === "other" ? undefined : "_blank"} rel="noreferrer" title={title ?? t("Open in {app}", { app: t(MAPS_LABELS[app]) })}>
        {children}
      </a>
    );
  }
  return (
    <>
      <button type="button" className={className} title={title ?? t("Open in a maps app")} onClick={() => setChoosing(true)}>
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
    <Dialog open onClose={onClose} title={t("Open in")} description={text || undefined} size="sm">
      <div className="dialog-body">
        <div className="maps-choices">
          {mapsApps().map((app) => (
            <a key={app} className="btn big-action" href={mapsUrl(app, place)} target={app === "other" ? undefined : "_blank"} rel="noreferrer" onClick={() => pick(app)}>
              <Icon name={app === "other" ? "apps" : "navigation"} size={20} />
              {t(MAPS_LABELS[app])}
            </a>
          ))}
          {text && (
            <button type="button" className="btn big-action" onClick={() => { void copyText(text, t("Address copied")); onClose(); }}>
              <Icon name="copy" size={20} />
              {t("Copy address")}
            </button>
          )}
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
          <span>{t("Always use this app on this device")}</span>
        </label>
        <span className="muted small">{t("An app that isn't installed opens its website instead. Change this in Settings → Profile.")}</span>
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
      <a className={className} href={legs[0]!.url} target="_blank" rel="noreferrer" title={title ?? t("Open the route in {app}", { app: t(MAPS_LABELS[app]) })}>
        {children}
      </a>
    );
  }
  return (
    <>
      <button type="button" className={className} title={title ?? t("Open the route in a maps app")} onClick={() => setChoosing(true)}>
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
  const description = route.start
    ? route.end
      ? t.plural(count, { one: "{count} stop, from the shop and back", other: "{count} stops, from the shop and back" })
      : t.plural(count, { one: "{count} stop, from the shop", other: "{count} stops, from the shop" })
    : route.end
      ? t.plural(count, { one: "{count} stop from where you are, then back to the shop", other: "{count} stops from where you are, then back to the shop" })
      : t.plural(count, { one: "{count} stop from where you are", other: "{count} stops from where you are" });
  const link = (app: RouteApp, url: string, label: string) => (
    <a key={url} className="btn big-action" href={url} target="_blank" rel="noreferrer" onClick={() => pick(app)}>
      <Icon name="navigation" size={20} />
      {label}
    </a>
  );
  return (
    <Dialog open onClose={onClose} title={t("Open route in")} description={description} size="sm">
      <div className="dialog-body">
        <div className="maps-choices">
          {choices.map(({ app, legs }) =>
            legs.length === 1 ? (
              link(app, legs[0]!.url, t(MAPS_LABELS[app]))
            ) : (
              <Fragment key={app}>
                <strong className="small">{t(MAPS_LABELS[app])}</strong>
                {legs.map((leg, i) => {
                  const stops = leg.last - leg.first + 1;
                  const part = t("Part {part}", { part: i + 1 });
                  const which = leg.back ? t.plural(stops, { one: "{count} stop, then the shop", other: "{count} stops, then the shop" }) : t.plural(stops, { one: "{count} stop", other: "{count} stops" });
                  return link(app, leg.url, `${part} · ${which}`);
                })}
              </Fragment>
            ),
          )}
        </div>
        {apps.length > 1 && (
          <label className="checkbox">
            <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
            <span>{t("Always use this app on this device")}</span>
          </label>
        )}
        <span className="muted small">
          {choices.some((c) => c.legs.length > 1) && t("Maps apps take only so many stops at once, so a long day opens in parts. Open the next part when you finish one. ")}
          {t("An app that isn't installed opens its website instead.")}
        </span>
      </div>
    </Dialog>
  );
}

/** Settings → Profile: which app directions open in on this device. */
export function MapsAppSetting() {
  const [app, setApp] = useState<MapsApp | "">(() => rememberedApp() ?? "");
  return (
    <div className="set-item">
      <span className="set-item-label" id="maps-app-title">{t("Directions")}</span>
      <Select
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
        <option value="">{t("Ask which app each time")}</option>
        {mapsApps().map((a) => <option key={a} value={a}>{t(MAPS_LABELS[a])}</option>)}
      </Select>
      <span className="muted small">{t("Tapping an address or Directions opens this app. Saved on this device.")}</span>
    </div>
  );
}
