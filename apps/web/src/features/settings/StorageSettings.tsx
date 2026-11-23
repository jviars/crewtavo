/**
 * Settings → Storage: how much room this Crewtavo's photos and files take (the Trash included, until
 * it's emptied) against the company's limit, and what that costs on Railway; the limit itself
 * (Railway's default, none, or a size); who's using it, person by person, with a limit of their own
 * set by owners; limits for everyone with a role; and what each area of Crewtavo holds. From GET
 * /api/storage (storage_overview plus Railway's side); limits are saved with storage_set_limit and
 * storage_set_allowance (features/settings/storage.ts).
 *
 * On Railway the company's limit is what files may cost a month, shown with the size it means where
 * files are now: owners think in dollars, and the dollars stay put when files move between the
 * volume and a bucket. Everywhere else it's a size, as before. Photos and videos sets how camera
 * photos and videos added to Drive and plan files are kept (companies.settings.files), and on
 * Railway, a volume half full on a plan with buckets points to Files storage in Settings → Hosting.
 *
 * For owners and admins with Settings. Crews always finish a job: visit photos, quote photos,
 * receipts and sub paperwork are never refused, whatever the limits say.
 */
import { STORAGE_PRICES } from "@crewtavo/core/hosting";
import { formatBytes, storageLimitFromDollars, VIDEO_SIZE_CHOICES, type FileSettings, type StorageLimitMode, type VideoUploaders } from "@crewtavo/core/storage";
import { ROLE_LABELS, STAFF } from "@crewtavo/core/roles";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Section } from "@/components/ui/Section";
import { Loading, SectionSkeleton, SkeletonText } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { useSession } from "@/lib/session";
import { useCompanyRoles } from "./roles";
import {
  areaLabel, bucketTipDismissed, companyLine, dismissBucketTip, dollarsField, fullness, gbField, limitable, limitText, monthly, parseDollars, parseGb, pricePerGb, refreshFileSettings, refreshStorage, saveFileSettings, setAllowance,
  setsAllowances, setStorageLimit, shareOf, usd, useFileSettings, useStorageReport,
  type AllowanceTarget, type StoragePerson, type StorageReport,
} from "./storage";
import p from "./Prefs.module.css";
import { SaveBar, SwitchRow } from "./SettingsKit";
import styles from "./StorageSettings.module.css";
import { Select } from "@/components/ui/Select";

const count = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
/** What the company's limit turns away once storage is full (STORAGE_FIELD_FOLDERS never are). */
const REFUSED = "new files in Drive and on plans, guide covers, résumés, chat pictures and equipment photos";
const percent = (share: number) => `${Math.floor(share * 100)}%`;

export function StorageSettings() {
  const session = useSession();
  const report = useStorageReport();
  if (report.isPending) return <Loading label="Loading storage"><div className="settings-body"><SectionSkeleton rows={2} /><SectionSkeleton rows={4} /></div></Loading>;
  if (!report.data) return <ErrorState error={report.error} onRetry={() => report.refetch()} />;
  const o = report.data;
  const owner = setsAllowances(session);
  return (
    <>
      <Usage o={o} />
      {session.config.platform === "railway" && <BucketNote o={o} />}
      <LimitCard key={`${o.limit_mode}:${o.limit_bytes ?? ""}:${o.limit_dollars ?? ""}`} o={o} />
      <FilesCard />
      {o.by_person && <People people={o.by_person} owner={owner} />}
      {owner && <Roles o={o} />}
      {o.by_area && o.by_area.length > 0 && <Areas areas={o.by_area} />}
      <HowItWorks />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// How full it is
// ---------------------------------------------------------------------------------------------

function Usage({ o }: { o: StorageReport }) {
  const trash = Math.min(o.trash_bytes, o.used_bytes);
  const live = Math.max(0, o.used_bytes - trash);
  const share = shareOf(o.used_bytes, o.limit_bytes);
  const level = fullness(share);
  // The bar is the limit (or, with none, what's stored), and stretches past a limit that's been passed.
  const top = Math.max(o.limit_bytes ?? 0, o.used_bytes) || 1;
  const at = (n: number) => `${Math.min(100, (n / top) * 100)}%`;
  const over = o.limit_bytes !== null && o.used_bytes > o.limit_bytes;
  const described = `${companyLine(o)}${trash ? `, ${formatBytes(trash)} of it in the Trash` : ""}`;
  return (
    <Section level={3} title="Space used" action={o.railway?.backend ? <span className={styles.where}>{o.railway.backend === "bucket" ? "In a Railway bucket" : "On a Railway volume"}</span> : undefined}>
      <p className="set-note">Every photo and file in Crewtavo, the Trash included.</p>
      <div className={styles.figure}>
        <span className={styles.big}>{formatBytes(o.used_bytes)}</span>
        <span className={styles.of}>
          {o.limit_bytes ? `of the ${formatBytes(o.limit_bytes)} limit` : "No limit"}
          {share !== null ? ` (${percent(share)})` : ""} · {count(o.files, "file")}
        </span>
      </div>
      <div className={styles.meter} role="img" aria-label={described}>
        <span className={styles.live} data-level={level} style={{ width: at(live) }} />
        <span className={styles.trash} style={{ width: at(trash) }} />
        {over && <i className={styles.mark} style={{ left: at(o.limit_bytes!) }} />}
      </div>
      <div className={`row wrap small ${styles.legend}`}>
        <span><i className={styles.keyLive} />In use {formatBytes(live)}</span>
        <span><i className={styles.keyTrash} />In the Trash {formatBytes(trash)}</span>
      </div>
      {level !== "ok" && share !== null && <FullNote level={level} share={share} trash={trash} />}
      {o.railway?.pricePerGbMonth != null && <p className={`set-note ${styles.gap}`}>{costLine(o, o.railway.pricePerGbMonth)}</p>}
    </Section>
  );
}

function FullNote({ level, share, trash }: { level: "warning" | "danger" | "full"; share: number; trash: number }) {
  const title = level === "full" ? "Storage is full" : `Storage is ${percent(share)} full`;
  return (
    <div className={`callout ${level === "warning" ? "callout-warning" : "callout-danger"} ${styles.gap}`} role={level === "full" ? "alert" : undefined}>
      <Icon name="alert" size={16} />
      <div className="grow">
        <div>{title}</div>
        <div>
          {level === "full" ? `${REFUSED[0].toUpperCase()}${REFUSED.slice(1)} are turned away until there's room. ` : `Once it's full, ${REFUSED} are turned away. `}
          Visit photos, quote photos, receipts and sub paperwork still go through, so crews can finish their jobs. Raise the limit below
          {trash > 0 ? <>, or <Link to="/drive/trash">empty the Trash</Link> to free {formatBytes(trash)}</> : null}.
        </div>
      </div>
    </div>
  );
}

/** What Railway charges for what's stored, and for the limit if files reached it. */
function costLine(o: StorageReport, price: number): string {
  const railway = o.railway!;
  const where = railway.backend === "bucket" ? "a bucket" : railway.backend === "volume" ? "what the volume stores" : "storage";
  const atLimit = o.limit_bytes ? `, and ${monthly(o.limit_bytes, price)} if files reached the limit` : "";
  return `Railway charges ${pricePerGb(price)} per GB a month for ${where}: ${monthly(o.used_bytes, price)} for what's stored now${atLimit}.`;
}

// ---------------------------------------------------------------------------------------------
// The limit
// ---------------------------------------------------------------------------------------------

/** A size in GB, typed. */
export function GbInput({ value, onChange, onFocus, label, disabled, invalid, placeholder = "0" }: { value: string; onChange: (value: string) => void; onFocus?: () => void; label?: string; disabled?: boolean; invalid?: boolean; placeholder?: string }) {
  return (
    <div className={`input-group ${styles.size}`}>
      <input
        className="input"
        inputMode="decimal"
        autoComplete="off"
        value={value}
        disabled={disabled}
        aria-label={label}
        aria-invalid={invalid || undefined}
        placeholder={placeholder}
        onFocus={onFocus}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.,]/g, ""))}
      />
      <span className="addon addon-right addon-unit">GB</span>
    </div>
  );
}

/** Why the default is what it is, for where files are kept and Railway's plan. */
function defaultNote(o: StorageReport): string {
  if (!o.default_bytes) {
    return o.railway
      ? "No limit for now. Crewtavo sets one once it can read where Railway keeps your files."
      : "Crewtavo doesn't know how much room this server has, so there's no default limit. Choose a size to set one.";
  }
  const basis = o.default_basis ? `${formatBytes(o.default_bytes)}: ${o.default_basis}.` : `${formatBytes(o.default_bytes)}.`;
  if (o.railway?.backend === "volume") return `${basis} A volume holds only its size, so this stops a little short of it and leaves time to grow the volume in Railway.`;
  if (o.railway?.backend === "bucket" && o.railway.plan === "hobby") return `${basis} Railway's Hobby plan holds up to 1 TB in buckets for your whole Railway workspace, so this leaves room for the rest of it.`;
  if (o.railway?.backend === "bucket" && o.railway.plan === "pro") return `${basis} Railway doesn't cap buckets on Pro, so this is a safety net: 1 TB costs about $15 a month.`;
  return `${basis} It follows where Railway keeps your files and your plan.`;
}

/** What a monthly amount means where files are now, for the page: the size, and whether the volume holds it all. */
function dollarSize(o: StorageReport, dollars: number | null): { bytes: number; capped: boolean } | null {
  const price = o.railway?.pricePerGbMonth ?? null;
  if (!price || !dollars) return null;
  const cap = o.cap_bytes ?? null;
  const bytes = storageLimitFromDollars(dollars, price, cap);
  return { bytes, capped: cap !== null && storageLimitFromDollars(dollars, price) > cap };
}

/** "on the volume", "in a bucket". */
const whereNow = (o: StorageReport) => (o.railway?.backend === "bucket" ? "in a Railway bucket" : o.railway?.backend === "volume" ? "on the storage volume" : "where files are now");

/** A monthly amount in dollars, typed. */
function DollarInput({ value, onChange, onFocus, invalid }: { value: string; onChange: (value: string) => void; onFocus?: () => void; invalid?: boolean }) {
  return (
    <div className={`input-group ${styles.size}`}>
      <span className="addon">$</span>
      <input
        className="input"
        inputMode="decimal"
        autoComplete="off"
        value={value}
        aria-label="What files can cost a month, in dollars"
        aria-invalid={invalid || undefined}
        placeholder="10"
        onFocus={onFocus}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.,]/g, ""))}
      />
      <span className="addon addon-right addon-unit">a month</span>
    </div>
  );
}

function LimitCard({ o }: { o: StorageReport }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const price = o.railway?.pricePerGbMonth ?? null;
  // On Railway, once it's known what a GB costs where files are, a limit of your own is a monthly amount.
  const inDollars = session.config.platform === "railway" && price !== null;
  const [mode, setMode] = useState<StorageLimitMode>(o.limit_mode);
  const [size, setSize] = useState(gbField(o.limit_mode === "custom" ? o.limit_bytes : (o.default_bytes ?? o.limit_bytes)));
  // A monthly amount starts at what the limit costs now, or $10 (Railway's lowest spending limit) with none.
  const startingAmount = o.limit_dollars ?? (price && o.limit_bytes ? Math.max(0.01, Math.round((o.limit_bytes / 1e9) * price * 100) / 100) : 10);
  const [amount, setAmount] = useState(dollarsField(startingAmount));
  const parsed = mode === "custom" ? parseGb(size) : null;
  const bytes = parsed && "bytes" in parsed ? parsed.bytes : null;
  const typed = mode === "dollars" ? parseDollars(amount) : null;
  const dollars = typed && "dollars" in typed ? typed.dollars : null;
  // Sizes compared as shown (to the hundredth of a GB), so one saved as typed isn't "changed".
  const changed =
    mode !== o.limit_mode ||
    (mode === "custom" && (bytes === null || gbField(bytes) !== gbField(o.limit_bytes))) ||
    (mode === "dollars" && (dollars === null || dollars !== o.limit_dollars));
  const save = useMutation({
    meta: { inline: true, success: (_: unknown, m: StorageLimitMode) => (m === "none" ? "Storage has no limit now" : "Storage limit saved") },
    mutationFn: async (m: StorageLimitMode) => {
      if (m === "custom" && parsed && "problem" in parsed) throw new Error(parsed.problem);
      if (m === "dollars" && typed && "problem" in typed) throw new Error(typed.problem);
      await setStorageLimit(session.company.id, m, m === "custom" ? bytes : null, m === "dollars" ? dollars : null);
    },
    onSuccess: () => refreshStorage(queryClient),
  });
  const volume = o.railway?.backend === "volume" ? o.railway.volumeBytes : null;
  const chosen = mode === "custom" ? bytes : mode === "default" ? o.default_bytes : null;
  const fromDollars = mode === "dollars" ? dollarSize(o, dollars) : null;
  const pick = (next: StorageLimitMode) => {
    setMode(next);
    save.reset();
  };
  // A size of its own stays offered on Railway only while it's the limit (set before limits were in
  // dollars), and a monthly amount off Railway only while it's the limit (set while on Railway).
  const offerSize = !inDollars || o.limit_mode === "custom";
  const offerDollars = inDollars || o.limit_mode === "dollars";

  return (
    <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (changed) save.mutate(mode); }}>
      <Section level={3} title="Limit">
        <p className="set-note">Owners and admins get a bell and an email when files reach 80% and 95% of it.</p>
        <fieldset className={`${p.choices} ${styles.gap}`}>
          <legend className="sr-only">Storage limit</legend>
          <label className={p.choice}>
            <input type="radio" name="storage-limit" checked={mode === "default"} onChange={() => pick("default")} />
            <span className={p.rowText}>
              Default{o.default_bytes ? ` (${formatBytes(o.default_bytes)}${inDollars && price ? `, ${monthly(o.default_bytes, price)}` : ""})` : ""}
              <span className={p.hint}>{defaultNote(o)}</span>
            </span>
          </label>
          {offerDollars && (
            <label className={p.choice}>
              <input type="radio" name="storage-limit" checked={mode === "dollars"} onChange={() => pick("dollars")} />
              <span className={p.rowText}>
                A monthly amount
                {inDollars ? (
                  <>
                    <span className={p.hint}>Files can cost up to this much a month on Railway.</span>
                    <DollarInput value={amount} invalid={mode === "dollars" && Boolean(typed && "problem" in typed)} onFocus={() => mode !== "dollars" && pick("dollars")} onChange={(v) => { setAmount(v); save.reset(); }} />
                  </>
                ) : (
                  // Set while this Crewtavo ran on Railway: it holds at the size it came to there.
                  <span className={p.hint}>
                    Set as {usd(o.limit_dollars ?? 0)} a month while Crewtavo ran on Railway{o.limit_bytes ? `, which holds files to ${formatBytes(o.limit_bytes)} here` : ""}. Choose Custom to set a size instead.
                  </span>
                )}
              </span>
            </label>
          )}
          {offerSize && (
            <label className={p.choice}>
              <input type="radio" name="storage-limit" checked={mode === "custom"} onChange={() => pick("custom")} />
              <span className={p.rowText}>
                {inDollars ? "A size" : "Custom"}
                <span className={p.hint}>
                  {inDollars ? `Set before limits were in dollars${price && o.limit_bytes ? `: ${monthly(o.limit_bytes, price)} ${whereNow(o)}` : ""}. A monthly amount stays the same if files move between the volume and a bucket.` : "A size of your own."}
                </span>
                <GbInput value={size} label="Custom storage limit in GB" invalid={mode === "custom" && Boolean(parsed && "problem" in parsed)} onFocus={() => mode !== "custom" && pick("custom")} onChange={(v) => { setSize(v); save.reset(); }} />
              </span>
            </label>
          )}
          <label className={p.choice}>
            <input type="radio" name="storage-limit" checked={mode === "none"} onChange={() => pick("none")} />
            <span className={p.rowText}>
              No limit
              <span className={p.hint}>
                {/* Self-hosters see nothing about Railway. */}
                Uploads are never turned away for space. {session.config.platform === "railway" ? `Keep an eye on Railway's bill${volume ? " and how full the volume is" : ""}.` : "Keep an eye on how much room your server has."}
              </span>
            </span>
          </label>
        </fieldset>
        {mode === "custom" && volume && bytes && bytes > volume ? (
          <div className={`callout callout-warning ${styles.gap}`}>
            <Icon name="alert" size={16} />
            <div className="grow">
              <div>That's more than the volume holds</div>
              <div>Your volume is {formatBytes(volume)}, and files stop when it's full whatever the limit. Grow the volume in Railway first.</div>
            </div>
          </div>
        ) : null}
        {fromDollars && price ? (
          fromDollars.capped ? (
            <div className={`callout callout-warning ${styles.gap}`}>
              <Icon name="alert" size={16} />
              <div className="grow">
                <div>That's more than the volume holds</div>
                <div>
                  Uploads stop at {formatBytes(fromDollars.bytes)}, {monthly(fromDollars.bytes, price)}, so the volume never fills. Make the volume bigger in Railway, or{" "}
                  <Link to="/settings?tab=hosting">move files to a bucket</Link>, where {usd(dollars!)} a month holds {formatBytes(storageLimitFromDollars(dollars!, STORAGE_PRICES.bucket))}.
                </div>
              </div>
            </div>
          ) : (
            <span className={`set-note ${styles.line}`}>
              That's {formatBytes(fromDollars.bytes)} {whereNow(o)}, at {pricePerGb(price)} per GB a month. If files move between the volume and a bucket, it stays {usd(dollars!)} and the size
              follows.
            </span>
          )
        ) : null}
        {price !== null && chosen && mode !== "dollars" ? <span className={`set-note ${styles.line}`}>At {formatBytes(chosen)}, storage would cost {monthly(chosen, price)} on Railway once files filled it.</span> : null}
        <FormError error={save.error} />
        <div className={styles.gap}>
          <SaveBar note={changed && !save.isPending ? "Not saved yet" : null}>
            <Button type="submit" variant="primary" disabled={!changed} loading={save.isPending}>Save limit</Button>
          </SaveBar>
        </div>
      </Section>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Moving files to a bucket (Railway)
// ---------------------------------------------------------------------------------------------

/** Files on a volume half full or more, on a plan with buckets: what a bucket would save, and what it gives up. */
function BucketNote({ o }: { o: StorageReport }) {
  const session = useSession();
  const aside = useMutation({ meta: { inline: true }, mutationFn: () => dismissBucketTip(session), onSuccess: () => session.refresh() });
  const r = o.railway;
  if (r?.backend !== "volume" || (r.plan !== "hobby" && r.plan !== "pro") || !r.volumeBytes || o.used_bytes / r.volumeBytes < 0.5) return null;
  if (bucketTipDismissed(session.company.settings)) return null;
  return (
    <div className="callout callout-info">
      <Icon name="info" size={16} />
      <div className="grow">
        <div>Photos and files would cost a tenth as much in a Railway bucket</div>
        <div>
          {pricePerGb(STORAGE_PRICES.bucket)} per GB a month instead of {pricePerGb(STORAGE_PRICES.volume)} on the volume, and a bucket has no size to outgrow. But Railway backs up volumes on its Pro plan, and
          never buckets. <Link to="/settings?tab=hosting">Files storage in Settings → Hosting</Link> moves them with one press, and can move them back.
        </div>
        <div style={{ marginTop: 10 }}><Button size="sm" variant="ghost" loading={aside.isPending} onClick={() => aside.mutate()}>Not now</Button></div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Photos and videos added to Drive and plan files
// ---------------------------------------------------------------------------------------------

function FilesCard() {
  const session = useSession();
  const queryClient = useQueryClient();
  const settings = useFileSettings();
  const save = useMutation({
    meta: {
      inline: true,
      success: (_: unknown, change: Partial<FileSettings>) =>
        change.shrinkPhotos === true ? "Photos are made smaller as they're added" : change.shrinkPhotos === false ? "Photos are kept as they are" : "Video settings saved",
    },
    mutationFn: (change: Partial<FileSettings>) => saveFileSettings(session.company.id, change),
    onSuccess: () => refreshFileSettings(queryClient, session.company.id, session.refresh),
  });
  if (settings.isPending) return <SectionSkeleton rows={3} />;
  if (!settings.data) return <ErrorState error={settings.error} onRetry={() => settings.refetch()} />;
  const f = settings.data;
  const busy = save.isPending;
  return (
    <Section level={3} title="Photos and videos">
      <p className="set-note">For what's added to Drive and to Plans and files on clients' work.</p>
      <div className={`set-rows ${styles.gap}`}>
        <SwitchRow
          label="Make photos smaller as they're added"
          hint="Photos from a phone or camera are saved at 2560 pixels on their longest side: still sharp when you zoom in, and usually a fraction of the room. Plan sheets, PDFs and screenshots are never changed. Turn it off to keep every photo exactly as it was taken."
          checked={f.shrinkPhotos}
          disabled={busy}
          onChange={(on) => save.mutate({ shrinkPhotos: on })}
        />
      </div>
      <h4 className={styles.subhead}>Videos</h4>
      <fieldset className={p.choices}>
        <legend className="sr-only">Who can add videos</legend>
        {(
          [
            ["everyone", "Everyone on the team", "Crews can add a video of a job to its Plans and files."],
            ["office", "Only the office", "Owners, admins, office staff and estimators. Crew leads and field crew add photos instead."],
          ] as Array<[VideoUploaders, string, string]>
        ).map(([value, label, hint]) => (
          <label key={value} className={p.choice}>
            <input type="radio" name="video-uploaders" checked={f.videos === value} disabled={busy} onChange={() => save.mutate({ videos: value })} />
            <span className={p.rowText}>
              {label}
              <span className={p.hint}>{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className={`set-grid ${styles.gap}`}>
        <Field label="Each video can be up to" className="set-full" hint="A minute of phone video is often 100 MB or more, and each one is downloaded in full every time someone plays it. Other files can be up to 200 MB. Visit and quote photos are never turned away, so crews can always finish a job.">
          <Select className="select set-narrow" value={f.videoMaxBytes} disabled={busy} onChange={(e) => save.mutate({ videoMaxBytes: Number(e.target.value) })}>
            {[...new Set([...VIDEO_SIZE_CHOICES, f.videoMaxBytes])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{formatBytes(n)}</option>)}
          </Select>
        </Field>
      </div>
      <FormError error={save.error} />
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Who's using it
// ---------------------------------------------------------------------------------------------

/** Most first; files no one in particular added at the end. */
const byUse = (a: StoragePerson, b: StoragePerson) => Number(!a.user_id) - Number(!b.user_id) || b.used_bytes - a.used_bytes || a.name.localeCompare(b.name);

function People({ people, owner }: { people: StoragePerson[]; owner: boolean }) {
  const [setting, setSetting] = useState<StoragePerson | null>(null);
  const rows = [...people].sort(byUse);
  return (
    <Section level={3} title="Who's using it" count={rows.length}>
      <p className="set-note">
        What each person added that's still in use. The Trash doesn't count toward anyone's own limit, so moving old files there frees their room.
        {owner ? " Owners are never limited." : " Owners set each person's limit."}
      </p>
      <ul className={styles.people} role="list" aria-label="Storage by person">
        {rows.map((p) => {
          const limit = limitText(p);
          const share = shareOf(p.used_bytes, p.limit_bytes);
          const canSet = owner && limitable(p);
          return (
            <li key={p.user_id ?? "crewtavo"} className={styles.person}>
              <span className={styles.who}>
                <strong>{p.name}</strong>
                {p.role_name && <span>{p.role_name}</span>}
              </span>
              <span className={styles.used}>
                <span className="tabular">{formatBytes(p.used_bytes)} in use</span>
                {share !== null && (
                  <span className="progress" data-level={fullness(share)} role="img" aria-label={`${percent(share)} of ${p.name}'s limit`}>
                    <span style={{ width: `${Math.min(100, share * 100)}%` }} />
                  </span>
                )}
              </span>
              <span className={styles.limit}>
                {limit.size !== "—" && (
                  <span>
                    {p.limit_bytes && p.role !== "owner" ? "Limit: " : null}
                    {limit.size}
                  </span>
                )}
                {limit.source && <span className={styles.source}>{limit.source}</span>}
              </span>
              <span className={styles.set}>
                {canSet && (
                  <button type="button" className="link-btn small" onClick={() => setSetting(p)} aria-label={`Set a storage limit for ${p.name}`}>
                    {p.limit_source === "person" ? "Change…" : "Set limit…"}
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {setting && setting.user_id && (
        <AllowanceDialog
          target={{ user: setting.user_id }}
          name={setting.name}
          current={setting.limit_source === "person" ? setting.limit_bytes : null}
          roleLimit={setting.limit_source === "role" ? setting.limit_bytes : null}
          onClose={() => setSetting(null)}
        />
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// By role (owners)
// ---------------------------------------------------------------------------------------------

/** Every role a limit can be set for: the company's own, then the built-in levels (never the owner's). */
function useRoleChoices(o: StorageReport) {
  const roles = useCompanyRoles();
  const limits = new Map((o.roles ?? []).map((r) => [r.role_key, r.limit_bytes]));
  const custom = (roles.data ?? []).map((r) => ({ key: r.id, name: r.name, detail: `${ROLE_LABELS[r.base_role]} access`, limit: limits.get(r.id) ?? null }));
  const levels = STAFF.filter((r) => r !== "owner").map((r) => ({ key: r as string, name: ROLE_LABELS[r], detail: "Built-in", limit: limits.get(r) ?? null }));
  return { rows: [...custom, ...levels], loading: roles.isPending };
}

function Roles({ o }: { o: StorageReport }) {
  const { rows, loading } = useRoleChoices(o);
  const [setting, setSetting] = useState<{ key: string; name: string; limit: number | null } | null>(null);
  return (
    <Section level={3} title="By role">
      <p className="set-note">A limit for everyone with a role who has no limit of their own. A custom role's limit comes before its access level's.</p>
      {loading ? (
        <div className={styles.gap}><SkeletonText lines={3} /></div>
      ) : (
        <ul className={styles.people} role="list" aria-label="Storage limits by role">
          {rows.map((r) => (
            <li key={r.key} className={`${styles.person} ${styles.role}`}>
              <span className={styles.who}>
                <strong>{r.name}</strong>
                <span>{r.detail}</span>
              </span>
              <span className={styles.limit}>{r.limit ? `${formatBytes(r.limit)} each` : "No limit"}</span>
              <span className={styles.set}>
                <button type="button" className="link-btn small" onClick={() => setSetting(r)} aria-label={`Set a storage limit for ${r.name}`}>{r.limit ? "Change…" : "Set limit…"}</button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {setting && <AllowanceDialog target={{ role: setting.key }} name={setting.name} current={setting.limit} onClose={() => setSetting(null)} />}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// A person's or a role's own limit
// ---------------------------------------------------------------------------------------------

/**
 * A limit of their own for one person, or for everyone with a role (owners only). For a person, the
 * role's limit (when there is one) applies without one.
 */
export function AllowanceDialog({ target, name, current, roleLimit = null, onClose }: { target: AllowanceTarget; name: string; current: number | null; roleLimit?: number | null; onClose: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const person = "user" in target;
  const [limited, setLimited] = useState(current !== null);
  const [size, setSize] = useState(gbField(current ?? roleLimit) || "10");
  const parsed = parseGb(size);
  const save = useMutation({
    meta: { inline: true, success: () => (limited ? "Storage limit saved" : "Storage limit taken off") },
    mutationFn: async () => {
      if (limited && "problem" in parsed) throw new Error(parsed.problem);
      await setAllowance(session.company.id, target, limited && "bytes" in parsed ? parsed.bytes : null);
    },
    onSuccess: () => {
      refreshStorage(queryClient);
      onClose();
    },
  });
  const choose = (next: boolean) => {
    setLimited(next);
    save.reset();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={`Storage limit for ${name}`}
      description={person ? "It counts the files they add that aren't in the Trash." : "For everyone with this role who has no limit of their own."}
    >
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <fieldset className={p.choices}>
          <legend className="sr-only">Storage limit</legend>
          <label className={p.choice}>
            <input type="radio" name="allowance" checked={!limited} onChange={() => choose(false)} />
            <span className={p.rowText}>
              {person ? "No limit for this person" : "No limit for this role"}
              <span className={p.hint}>
                {person
                  ? roleLimit ? `Their role's limit, ${formatBytes(roleLimit)}, applies.` : "Only the company's limit applies."
                  : "Each person's own limit, or the company's, applies."}
              </span>
            </span>
          </label>
          <label className={p.choice}>
            <input type="radio" name="allowance" checked={limited} onChange={() => choose(true)} />
            <span className={p.rowText}>
              {person ? "Limit" : "Limit for each person"}
              <GbInput value={size} label={`Storage limit for ${name} in GB`} invalid={limited && "problem" in parsed} onFocus={() => !limited && choose(true)} onChange={(v) => { setSize(v); save.reset(); }} />
            </span>
          </label>
        </fieldset>
        <p className="set-note">
          Once {person ? "they reach it, files they add" : "someone reaches it, files they add"} to Drive, plans and guides are turned away. Visit photos, quote photos, receipts and sub paperwork always go through.
        </p>
        <FormError error={save.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>Save</Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// By area
// ---------------------------------------------------------------------------------------------

function Areas({ areas }: { areas: NonNullable<StorageReport["by_area"]> }) {
  const rows = [...areas].filter((a) => a.bytes > 0).sort((a, b) => b.bytes - a.bytes);
  const most = Math.max(...rows.map((a) => a.bytes), 1);
  if (!rows.length) return null;
  return (
    <Section level={3} title="By area">
      <p className="set-note">What each part of Crewtavo holds.</p>
      <ul className={styles.areas}>
        {rows.map((a) => (
          <li key={a.area}>
            <span>{areaLabel(a.area)}</span>
            <span className={styles.bar} data-area={a.area} aria-hidden="true"><span style={{ width: `${(a.bytes / most) * 100}%` }} /></span>
            <span className={styles.amount}>{formatBytes(a.bytes)}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// What counts, and what's never refused
// ---------------------------------------------------------------------------------------------

function HowItWorks() {
  const railway = useSession().config.platform === "railway";
  return (
    <Section level={3} title="How limits work">
      <ul className={styles.notes}>
        <li>Every photo and file counts toward the company's limit, including what's in the Trash, until it's deleted for good 30 days after it went there.</li>
        <li>Visit photos, quote photos, receipts and sub paperwork are never refused, so crews can always finish a job. They still count.</li>
        <li>When storage is full, {REFUSED} are turned away until there's room.</li>
        <li>A person's own limit (or their role's) counts the files they added that aren't in the Trash, and stops only what they add to Drive, plans and guides. Owners are never limited.</li>
        <li>Public forms and one-time upload links (booking requests, a sub's paperwork) always go through.</li>
        <li>Videos added to Drive and plan files are held to the rules under Photos and videos, whatever the limit.</li>
      </ul>
      <p className={`set-note ${styles.gap}`}>A GB here is a billion bytes{railway ? ", as Railway counts it" : ""}.</p>
    </Section>
  );
}
