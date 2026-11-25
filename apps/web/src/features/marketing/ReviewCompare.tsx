/**
 * How you compare (Marketing → Reviews): the business's Google rating and number of reviews next to
 * up to five competitors'. Its own switch, off until an owner or admin turns it on, with the key
 * checked with Google first.
 *
 * Google's terms let Crewtavo keep a place's ID and nothing else about it
 * (apps/api/src/services/reviewCompare.ts quotes them). So the card opens on the saved places as a
 * list still to be read, and asks Google nothing by itself: Compare now reads each place from
 * Google, from this browser with the Google key the map uses here (reviewPlaces.ts), and the answers
 * are shown and held in this component's memory until the card leaves the screen
 * (reviewCompareState.ts). Nothing Google says is saved or sent to Crewtavo's server, so there's no
 * "since last week": the figures are Google's as of the moment they were read.
 *
 * Wherever Google's content is on the screen, so are its attribution and notices (GoogleBox,
 * GoogleNotice, SearchNotice), as its Places API policies ask.
 */
import {
  GOOGLE_ATTRIBUTION,
  GOOGLE_REVIEW_NOTICE,
  GOOGLE_REVIEW_POLICY_LABEL,
  GOOGLE_REVIEW_POLICY_URL,
  GOOGLE_SEARCH_NOTICE,
  GOOGLE_SEARCH_NOTICE_LABEL,
  GOOGLE_SEARCH_NOTICE_URL,
  standingWords,
} from "@crewtavo/core/reviewCompare";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { InfoTip } from "@/components/ui/InfoTip";
import { Section } from "@/components/ui/Section";
import { SectionSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { formatTime } from "@/lib/format";
import { reportError } from "@/lib/monitoring";
import { useSession } from "@/lib/session";
import {
  canCompare,
  comparableAt,
  compareRows,
  forSaved,
  loadComparison,
  noteCompared,
  notYetAdded,
  providersOn,
  removePlace,
  roomLeft,
  runComparison,
  savePlace,
  searchText,
  showsGoogle,
  standingOf,
  switchComparison,
  tradeSearchText,
  turnOn,
  withFound,
  type CompareRow,
  type CompareState,
  type Readings,
  type SavedPlace,
} from "./reviewCompareState";
import styles from "./Presence.module.css";
import { comparisonKey, PLACE_GONE, PlacesProblem, readPlace, searchPlaces, type FoundPlace, type Provider } from "./reviewPlaces";

const stars = (rating: number | null) => (rating == null ? "—" : `${rating.toFixed(1)} ★`);
const TRY_AGAIN = "Something went wrong. Try again.";

export function ReviewCompare() {
  const session = useSession();
  // Another company's card starts with nothing read.
  return <CompareCard key={session.company.id} />;
}

/** Draws again when the minute after a Compare now is up, so the button comes back by itself. */
function useComparableAt(companyId: string) {
  const [, again] = useState(0);
  const at = comparableAt(companyId);
  useEffect(() => {
    const ms = at - Date.now();
    if (ms <= 0) return;
    const timer = setTimeout(() => again((n) => n + 1), ms + 50);
    return () => clearTimeout(timer);
  }, [at]);
  return at;
}

function CompareCard() {
  const session = useSession();
  const queryClient = useQueryClient();
  const company = session.company;
  // Only the switch and the place IDs: what Google says about them never goes in React Query.
  const queryKey = ["review-compare", company.id];
  const state = useQuery({ queryKey, queryFn: loadComparison });
  const googleKey = comparisonKey(company.settings, session.config.mapsBrowserKey);
  const ownKey = Boolean(comparisonKey(company.settings, null));
  const [readings, setReadings] = useState<Readings>({});
  const [run, setRun] = useState<{ running: boolean; problem: string | null; at: Date | null }>({ running: false, problem: null, at: null });
  const [adding, setAdding] = useState(false);
  const waitUntil = useComparableAt(company.id);
  const onScreen = useRef(true);
  useEffect(() => {
    onScreen.current = true;
    return () => {
      onScreen.current = false;
    };
  }, []);

  const set = (next: Omit<CompareState, "can_switch">) => queryClient.setQueryData(queryKey, (old: CompareState | undefined) => ({ ...next, can_switch: old?.can_switch ?? false }));
  const toggle = useMutation({
    meta: { inline: true, success: (s: CompareState) => (s.enabled ? "Comparing with competitors on Google" : "Comparing is off") },
    mutationFn: (enabled: boolean) => (enabled ? turnOn(googleKey, company.name) : switchComparison(false)),
    onSuccess: (next) => {
      set(next);
      // Turned off: what was read goes with it.
      if (!next.enabled) {
        setReadings({});
        setRun({ running: false, problem: null, at: null });
      }
    },
  });
  const remove = useMutation({
    meta: { inline: true },
    mutationFn: (id: string) => removePlace(id),
    onSuccess: (next) => {
      set(next);
      setReadings((r) => forSaved(r, next.places));
    },
  });

  if (state.isPending) return <SectionSkeleton rows={3} />;
  if (state.error) return <ErrorState compact error={state.error} onRetry={() => state.refetch()} />;
  const s = state.data;
  const rows = compareRows(s.places, readings);
  const where = standingOf(rows);
  const { hasOwn, full } = roomLeft(s.places);
  const waiting = waitUntil > Date.now();

  /** Compare now: each place read from Google, here, and shown. Nothing is kept once the card is gone. */
  async function compare(places: SavedPlace[], key: string) {
    setRun({ running: true, problem: null, at: null });
    try {
      const result = await runComparison(places, (placeId) => readPlace(key, placeId), readings, (r) => onScreen.current && setReadings(r));
      if (result.answered) noteCompared(company.id);
      if (!onScreen.current) return;
      setReadings(result.readings);
      setRun({ running: false, problem: result.problem, at: result.answered ? new Date() : null });
    } catch (error) {
      reportError(error, { feature: "review_compare" });
      if (onScreen.current) setRun({ running: false, problem: TRY_AGAIN, at: null });
    }
  }

  return (
    <Section
      id="review-compare"
      title="How you compare"
      action={s.can_switch && (
        <label className={styles.headSwitch}>
          <span>Compare on Google</span>
          <input type="checkbox" role="switch" className="switch" checked={toggle.isPending ? Boolean(toggle.variables) : s.enabled} disabled={toggle.isPending || (!s.enabled && !googleKey)} onChange={(e) => toggle.mutate(e.target.checked)} />
        </label>
      )}
    >
      <div className={styles.form}>
        {!s.enabled ? (
          <>
            {/* Where the figures come from and what it costs is an (i), so the page says what it does first. */}
            <p className={styles.note}>
              See your Google rating and number of reviews next to up to five nearby competitors'.
              <InfoTip text={`Your browser reads them from Google Places with ${ownKey ? "your Google key from Settings → Maps" : googleKey ? "the Google key this Crewtavo was set up with" : "a Google key"} when you press Compare now: one lookup for each place every time, which Google may bill to the key's account. Crewtavo doesn't keep what Google says.`} />
            </p>
            {!googleKey && <NoKey />}
            {!s.can_switch && <p className={styles.note}>An owner or admin can turn it on here.</p>}
            <FormError error={toggle.error} />
          </>
        ) : (
          <>
            {!googleKey && <NoKey />}
            {run.problem && <div className="callout callout-warning" role="alert"><Icon name="alert" size={16} /><div className="grow">{run.problem}</div></div>}
            {!rows.length ? (
              <EmptyState inline icon="star" title="Pick who to compare with">Add your own business and up to five competitors from Google.</EmptyState>
            ) : (
              <CompareTable rows={rows} running={run.running} removing={remove.isPending || run.running} onRemove={(id) => remove.mutate(id)} />
            )}
            {where && (
              <p className={styles.standing}>
                <strong>{standingWords(where)}</strong>
                {where.ratingVsAverage != null && ` · ${where.ratingVsAverage === 0 ? "the same rating as" : `${Math.abs(where.ratingVsAverage).toFixed(1)} ${where.ratingVsAverage > 0 ? "above" : "below"}`} the others' average`}
                {where.reviewsVsAverage != null && ` · ${Math.abs(where.reviewsVsAverage).toLocaleString("en-US")} ${where.reviewsVsAverage >= 0 ? "more" : "fewer"} reviews than their average`}
              </p>
            )}
            {!hasOwn && rows.length > 0 && <p className={styles.note}>Add your own business too, to see how you stand.</p>}
            <div className={styles.inline}>
              <Button size="sm" icon="plus" disabled={(full && hasOwn) || !googleKey || run.running} onClick={() => setAdding(true)}>Add a business</Button>
              <Button size="sm" icon="refresh" loading={run.running} disabled={!canCompare({ places: s.places.length, running: run.running, waiting, key: googleKey })} onClick={() => googleKey && compare(s.places, googleKey)}>Compare now</Button>
            </div>
            <FormError error={remove.error ?? toggle.error} />
            <p className={styles.fine}>
              {run.at
                ? `Google's figures as of ${formatTime(run.at)}. Crewtavo doesn't keep them, so there's no change over time to show: Compare now reads them from Google again.`
                : "Compare now reads each place's rating and number of reviews from Google: one lookup for each place every time, which Google may bill to the key's account. Crewtavo doesn't keep what Google says, only which places to ask about."}
              {waiting && !run.running ? " You can compare again in a minute." : ""}
            </p>
          </>
        )}
      </div>
      {adding && googleKey && (
        <AddPlaceDialog
          googleKey={googleKey}
          places={s.places}
          onClose={() => setAdding(false)}
          onAdded={(next, found) => {
            set(next);
            if (found) setReadings((r) => withFound(forSaved(r, next.places), found));
            setAdding(false);
          }}
        />
      )}
    </Section>
  );
}

const NoKey = () => (
  <p className={styles.warnLine}>
    Add a Google key in <Link to="/settings?tab=maps" style={{ textDecoration: "underline" }}>Settings → Maps</Link> first, with Places API (New) turned on for it.
  </p>
);

/**
 * The places, in Google's box. Its attribution and its notice about reviews are there whenever
 * anything of Google's is (a name, a rating, a count), and not on a list that's still to be read.
 */
export function CompareTable({ rows, running, removing, onRemove }: { rows: CompareRow[]; running: boolean; removing: boolean; onRemove: (id: string) => void }) {
  return (
    <GoogleBox notice={showsGoogle(rows) ? <GoogleNotice providers={providersOn(rows)} /> : null}>
      <div style={{ overflowX: "auto" }}>
        <table className="table">
          <thead><tr><th>Business</th><th style={{ textAlign: "right" }}>Rating</th><th style={{ textAlign: "right" }}>Reviews</th><th aria-label="Remove" /></tr></thead>
          <tbody>
            {rows.map((row) => <PlaceRow key={row.id} row={row} running={running} removing={removing} onRemove={() => onRemove(row.id)} />)}
          </tbody>
        </table>
      </div>
    </GoogleBox>
  );
}

/** One place: Google's name, rating and count once read; until then which place it is on the card, still to be read. */
function PlaceRow({ row, running, removing, onRemove }: { row: CompareRow; running: boolean; removing: boolean; onRemove: () => void }) {
  const note =
    row.status === "gone" ? PLACE_GONE : row.closed ? "Google says this place is permanently closed." : row.status === "read" ? null : running ? "Reading from Google…" : "Not read yet";
  const warn = row.status === "gone" || row.closed;
  return (
    <tr style={row.is_own ? { fontWeight: 700 } : undefined}>
      <td>
        {row.fromGoogle && row.maps_url ? <a href={row.maps_url} target="_blank" rel="noreferrer">{row.label}</a> : <span className={row.fromGoogle ? undefined : "muted"}>{row.label}</span>}
        {row.is_own && <span className="tag" style={{ marginLeft: 6 }}>You</span>}
        {note && <span className={warn ? styles.warnLine : styles.note} style={{ display: "block", fontWeight: warn ? 600 : 400 }}>{note}</span>}
      </td>
      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{stars(row.rating)}</td>
      <td style={{ textAlign: "right" }}>{row.ratings_total == null ? "—" : row.ratings_total.toLocaleString("en-US")}</td>
      <td style={{ textAlign: "right" }}>
        {row.status === "gone" ? (
          <Button size="sm" disabled={removing} onClick={onRemove}>Remove</Button>
        ) : (
          <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label={`Remove ${row.label}`} disabled={removing} onClick={onRemove}><Icon name="x" size={14} /></button>
        )}
      </td>
    </tr>
  );
}

/**
 * Google's content in a box of its own, which sets it apart from Crewtavo's around it, with what
 * Google asks to be shown with it at the bottom of the same box (its Places API policies, "Visual
 * requirements": attribution "within the same visual container", the content told apart "by using
 * UI cues such as a border"). `notice` is given only while something of Google's is in the box:
 * its name isn't put on a list Crewtavo made.
 */
export function GoogleBox({ notice, children }: { notice: ReactNode; children: ReactNode }) {
  return (
    <div className="google-box">
      {children}
      {notice}
    </div>
  );
}

/**
 * The words "Google Maps", never translated, wrapped onto two lines, restyled or hidden
 * (.google-attribution in features.css). When Google names other data providers for what's shown
 * (a place's `attributions`), they follow it: "Google Maps" alone "is not proper attribution" then.
 */
export function GoogleAttribution({ providers }: { providers: Provider[] }) {
  return (
    <span>
      <span className="google-attribution" translate="no">{GOOGLE_ATTRIBUTION}</span>
      {providers.map((p) => (
        <span key={p.name} className="google-attribution" translate="no">, {p.url ? <a href={p.url} target="_blank" rel="noreferrer">{p.name}</a> : p.name}</span>
      ))}
    </span>
  );
}

/**
 * With ratings and review counts: the attribution, and Google's notice that reviews aren't
 * verified, with the link to its policy on them ("Reviews and average rating").
 */
export function GoogleNotice({ providers }: { providers: Provider[] }) {
  return (
    <div className="google-notice">
      <GoogleAttribution providers={providers} />
      <span className="muted small">
        {GOOGLE_REVIEW_NOTICE} <a href={GOOGLE_REVIEW_POLICY_URL} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>{GOOGLE_REVIEW_POLICY_LABEL}</a>
      </span>
    </div>
  );
}

/** With search results: the attribution, and what decides their order, in Google's words ("Place search results"). */
export function SearchNotice({ providers }: { providers: Provider[] }) {
  return (
    <div className="google-notice">
      <GoogleAttribution providers={providers} />
      <span className="muted small">
        {GOOGLE_SEARCH_NOTICE} <a href={GOOGLE_SEARCH_NOTICE_URL} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>{GOOGLE_SEARCH_NOTICE_LABEL}</a>
      </span>
    </div>
  );
}

/** Search results, each with its name and address as Google gave them just now, and what picking one does. */
export function FoundList({ results, places, busy, onPick }: { results: FoundPlace[]; places: readonly SavedPlace[]; busy: boolean; onPick: (found: FoundPlace, own: boolean) => void }) {
  const { hasOwn, full } = roomLeft(places);
  const have = new Set(places.map((p) => p.place_id));
  return (
    <GoogleBox notice={<SearchNotice providers={providersOn(results)} />}>
      {results.map((p) => (
        <div key={p.place_id} className="card-row">
          <div className="grow" style={{ minWidth: 0 }}>
            <strong className="ellipsis" style={{ display: "block" }}>{p.maps_url ? <a href={p.maps_url} target="_blank" rel="noreferrer">{p.name}</a> : p.name}</strong>
            {p.address && <span className="muted small ellipsis" style={{ display: "block" }}>{p.address}</span>}
          </div>
          {have.has(p.place_id) ? (
            <span className="muted small">On the card</span>
          ) : (
            <>
              {!hasOwn && <Button size="sm" disabled={busy} onClick={() => onPick(p, true)}>This is us</Button>}
              <Button size="sm" variant="primary" disabled={busy || full} onClick={() => onPick(p, false)}>Add</Button>
            </>
          )}
        </div>
      ))}
    </GoogleBox>
  );
}

function AddPlaceDialog({ googleKey, places, onClose, onAdded }: { googleKey: string; places: SavedPlace[]; onClose: () => void; onAdded: (next: Omit<CompareState, "can_switch">, found: FoundPlace | undefined) => void }) {
  const { company } = useSession();
  const [q, setQ] = useState("");
  // Google's answer to the last search: held here while the dialog is open, and nowhere else.
  const [search, setSearch] = useState<{ busy: "name" | "trade" | null; error: string | null; results: FoundPlace[] | null }>({ busy: null, error: null, results: null });
  // Only the place's ID goes to Crewtavo: its name and address stay in this dialog.
  const add = useMutation({
    meta: { inline: true },
    mutationFn: (p: { place_id: string; own: boolean }) => savePlace(p.place_id, p.own),
    onSuccess: (next, p) => onAdded(next, search.results?.find((r) => r.place_id === p.place_id)),
  });
  const { full } = roomLeft(places);

  async function find(kind: "name" | "trade") {
    const text = kind === "name" ? searchText(q, company.address) : tradeSearchText(company.trade_preset, company.address);
    if (!text) return setSearch({ busy: null, error: "Add your company's town in Settings → Company, so Crewtavo knows where to look. You can still search by name.", results: null });
    setSearch({ busy: kind, error: null, results: null });
    try {
      const found = await searchPlaces(googleKey, text);
      // Suggestions leave out the places already on the card, and the business itself by name.
      const us = company.name.trim().toLowerCase();
      setSearch({ busy: null, error: null, results: kind === "trade" ? notYetAdded(found, places).filter((p) => p.name.trim().toLowerCase() !== us) : found });
    } catch (error) {
      if (!(error instanceof PlacesProblem)) reportError(error, { feature: "review_compare" });
      setSearch({ busy: null, error: error instanceof PlacesProblem ? error.message : TRY_AGAIN, results: null });
    }
  }

  return (
    <Dialog open onClose={onClose} title="Add a business" description="Search Google for a competitor near you, or your own business." size="md">
      <div className="stack">
        <form className="row" style={{ gap: 8 }} onSubmit={(e: FormEvent) => { e.preventDefault(); if (q.trim().length >= 2 && !search.busy) void find("name"); }}>
          <input className="input grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Business name" maxLength={120} aria-label="Business name" autoFocus />
          <Button type="submit" icon="search" loading={search.busy === "name"} disabled={q.trim().length < 2 || Boolean(search.busy)}>Search</Button>
        </form>
        <div><Button size="sm" variant="ghost" icon="pin" loading={search.busy === "trade"} disabled={Boolean(search.busy)} onClick={() => void find("trade")}>Suggest businesses in my trade nearby</Button></div>
        {search.error && <div className="form-error" role="alert">{search.error}</div>}
        <FormError error={add.error} />
        {search.busy ? <Skeleton height={120} /> : search.results && (
          !search.results.length ? <span className="muted small">Nothing found. Try another name.</span> : (
            <FoundList results={search.results} places={places} busy={add.isPending} onPick={(found, own) => add.mutate({ place_id: found.place_id, own })} />
          )
        )}
        {full && <span className="muted small">You're comparing with five competitors already. Remove one to add another.</span>}
        <span className="muted small">Each search is one lookup, which Google may bill to the key's account. Only the place you pick is remembered, by Google's ID for it.</span>
      </div>
    </Dialog>
  );
}
