/**
 * Settings → Storage: how much room this Crewtavo's photos and files take (the Trash included, until
 * it's emptied) against the company's limit, and what that costs on Railway; the limit itself
 * (Railway's default, none, or a size); who's using it, person by person, with a limit of their own
 * set by owners; limits for everyone with a role; and what each area of Crewtavo holds. From GET
 * /api/storage (storage_overview plus Railway's side); limits are saved with storage_set_limit and
 * storage_set_allowance (features/settings/storage.ts).
 *
 * For owners and admins with Settings. Crews always finish a job: visit photos, quote photos,
 * receipts and sub paperwork are never refused, whatever the limits say.
 */
import { formatBytes, type StorageLimitMode } from "@crewtavo/core/storage";
import { ROLE_LABELS, STAFF } from "@crewtavo/core/roles";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { CardSkeleton, SkeletonText } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { useSession } from "@/lib/session";
import { useCompanyRoles } from "./roles";
import {
  areaLabel, companyLine, fullness, gbField, limitable, limitText, monthly, parseGb, pricePerGb, refreshStorage, setAllowance, setsAllowances, setStorageLimit, shareOf, useStorageReport,
  type AllowanceTarget, type StoragePerson, type StorageReport,
} from "./storage";
import styles from "./StorageSettings.module.css";

const count = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
/** What the company's limit turns away once storage is full (STORAGE_FIELD_FOLDERS never are). */
const REFUSED = "new files in Drive and on plans, guide covers, résumés, chat pictures and equipment photos";
const percent = (share: number) => `${Math.floor(share * 100)}%`;

export function StorageSettings() {
  const session = useSession();
  const report = useStorageReport();
  if (report.isPending) return <CardSkeleton lines={5} />;
  if (!report.data) return <div className="card"><ErrorState error={report.error} onRetry={() => report.refetch()} /></div>;
  const o = report.data;
  const owner = setsAllowances(session);
  return (
    <div className={`stack ${styles.page}`}>
      <Usage o={o} />
      <LimitCard key={`${o.limit_mode}:${o.limit_bytes ?? ""}`} o={o} />
      {o.by_person && <People people={o.by_person} owner={owner} />}
      {owner && <Roles o={o} />}
      {o.by_area && o.by_area.length > 0 && <Areas areas={o.by_area} />}
      <HowItWorks />
    </div>
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
    <section className="card card-pad stack" aria-labelledby="storage-usage">
      <div className="row-between" style={{ alignItems: "flex-start", gap: 12 }}>
        <div className="stack-sm" style={{ gap: 2 }}>
          <h2 id="storage-usage" className={styles.title}>Storage</h2>
          <span className="muted small">Every photo and file in Crewtavo, the Trash included.</span>
        </div>
        {o.railway?.backend && <span className={`chip ${o.railway.backend === "bucket" ? "chip-blue" : ""}`}>{o.railway.backend === "bucket" ? "Bucket" : "Volume"}</span>}
      </div>
      <div className="stack-sm" style={{ gap: 2 }}>
        <span className="hero-number">{formatBytes(o.used_bytes)}</span>
        <span className="muted small">
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
      {o.railway?.pricePerGbMonth != null && <span className="small">{costLine(o, o.railway.pricePerGbMonth)}</span>}
    </section>
  );
}

function FullNote({ level, share, trash }: { level: "warning" | "danger" | "full"; share: number; trash: number }) {
  const title = level === "full" ? "Storage is full" : `Storage is ${percent(share)} full`;
  return (
    <div className={`callout ${level === "warning" ? "callout-warning" : "callout-danger"}`} role={level === "full" ? "alert" : undefined}>
      <Icon name="alert" size={18} />
      <div className="grow">
        <div>{title}</div>
        <div style={{ fontWeight: 400 }}>
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

function LimitCard({ o }: { o: StorageReport }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<StorageLimitMode>(o.limit_mode);
  const [size, setSize] = useState(gbField(o.limit_mode === "custom" ? o.limit_bytes : (o.default_bytes ?? o.limit_bytes)));
  const parsed = mode === "custom" ? parseGb(size) : null;
  const bytes = parsed && "bytes" in parsed ? parsed.bytes : null;
  // Sizes compared as shown (to the hundredth of a GB), so one saved as typed isn't "changed".
  const changed = mode !== o.limit_mode || (mode === "custom" && (bytes === null || gbField(bytes) !== gbField(o.limit_bytes)));
  const save = useMutation({
    meta: { inline: true, success: (_: unknown, m: StorageLimitMode) => (m === "none" ? "Storage has no limit now" : "Storage limit saved") },
    mutationFn: async (m: StorageLimitMode) => {
      if (m === "custom" && parsed && "problem" in parsed) throw new Error(parsed.problem);
      await setStorageLimit(session.company.id, m, m === "custom" ? bytes : null);
    },
    onSuccess: () => refreshStorage(queryClient),
  });
  const price = o.railway?.pricePerGbMonth ?? null;
  const volume = o.railway?.backend === "volume" ? o.railway.volumeBytes : null;
  const chosen = mode === "custom" ? bytes : mode === "default" ? o.default_bytes : null;
  const pick = (next: StorageLimitMode) => {
    setMode(next);
    save.reset();
  };

  return (
    <section className="card card-pad stack" aria-labelledby="storage-limit">
      <div className="stack-sm" style={{ gap: 2 }}>
        <h2 id="storage-limit" className={styles.title}>Limit</h2>
        <span className="muted small">Owners and admins get a bell and an email when files reach 80% and 95% of it.</span>
      </div>
      <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); if (changed) save.mutate(mode); }}>
        <fieldset className={styles.choices}>
          <legend className="sr-only">Storage limit</legend>
          <label className={styles.choice}>
            <input type="radio" name="storage-limit" checked={mode === "default"} onChange={() => pick("default")} />
            <span className={styles.choiceBody}>
              <strong>Default{o.default_bytes ? ` (${formatBytes(o.default_bytes)})` : ""}</strong>
              <span className="muted small">{defaultNote(o)}</span>
            </span>
          </label>
          <label className={styles.choice}>
            <input type="radio" name="storage-limit" checked={mode === "none"} onChange={() => pick("none")} />
            <span className={styles.choiceBody}>
              <strong>No limit</strong>
              <span className="muted small">Uploads are never turned away for space. Keep an eye on Railway's bill{volume ? " and how full the volume is" : ""}.</span>
            </span>
          </label>
          <label className={styles.choice}>
            <input type="radio" name="storage-limit" checked={mode === "custom"} onChange={() => pick("custom")} />
            <span className={styles.choiceBody}>
              <strong>Custom</strong>
              <span className="muted small">A size of your own.</span>
              <GbInput value={size} label="Custom storage limit in GB" invalid={mode === "custom" && Boolean(parsed && "problem" in parsed)} onFocus={() => mode !== "custom" && pick("custom")} onChange={(v) => { setSize(v); save.reset(); }} />
            </span>
          </label>
        </fieldset>
        {mode === "custom" && volume && bytes && bytes > volume ? (
          <div className="callout callout-warning">
            <Icon name="alert" size={18} />
            <div className="grow">
              <div>That's more than the volume holds</div>
              <div style={{ fontWeight: 400 }}>Your volume is {formatBytes(volume)}, and files stop when it's full whatever the limit. Grow the volume in Railway first.</div>
            </div>
          </div>
        ) : null}
        {price !== null && chosen ? <span className="small">At {formatBytes(chosen)}, storage would cost {monthly(chosen, price)} on Railway once files filled it.</span> : null}
        <FormError error={save.error} />
        <div className="row wrap">
          <Button type="submit" variant="primary" disabled={!changed} loading={save.isPending}>Save limit</Button>
          {changed && !save.isPending && <span className="muted small">Not saved yet</span>}
        </div>
      </form>
    </section>
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
    <section className="card" aria-labelledby="storage-people">
      <div className="card-head"><h2 id="storage-people">Who's using it</h2></div>
      <p className={`muted small ${styles.note}`}>
        What each person added that's still in use. The Trash doesn't count toward anyone's own limit, so moving old files there frees their room.
        {owner ? " Owners are never limited." : " Owners set each person's limit."}
      </p>
      <table className={`table table-stack ${styles.people}`}>
        <caption className="sr-only">Storage by person</caption>
        <thead>
          <tr>
            <th>Person</th>
            <th className={`num ${styles.usedCol}`}>Using</th>
            <th className={styles.limitCol}>Limit</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const limit = limitText(p);
            const share = shareOf(p.used_bytes, p.limit_bytes);
            const canSet = owner && limitable(p);
            return (
              <tr key={p.user_id ?? "crewtavo"}>
                <td>
                  <strong>{p.name}</strong>
                  {p.role_name && <div className="muted small">{p.role_name}</div>}
                </td>
                <td className="num">
                  <div className={styles.used}>
                    <span className="tabular">{formatBytes(p.used_bytes)}<span className={styles.stacked}> in use</span></span>
                    {share !== null && (
                      <div className="progress" data-level={fullness(share)} role="img" aria-label={`${percent(share)} of ${p.name}'s limit`}>
                        <span style={{ width: `${Math.min(100, share * 100)}%` }} />
                      </div>
                    )}
                  </div>
                </td>
                <td>
                  <div className={styles.limit}>
                    {/* Stacked on a phone, a size says what it is; a dash says nothing. */}
                    <span className={p.role ? undefined : styles.notStacked}>
                      {p.limit_bytes && p.role !== "owner" ? <span className={styles.stacked}>Limit: </span> : null}
                      {limit.size}
                    </span>
                    {limit.source && <span className="muted small">{limit.source}</span>}
                    {canSet && (
                      <button type="button" className="link-btn small" onClick={() => setSetting(p)} aria-label={`Set a storage limit for ${p.name}`}>
                        {p.limit_source === "person" ? "Change…" : "Set limit…"}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {setting && setting.user_id && (
        <AllowanceDialog
          target={{ user: setting.user_id }}
          name={setting.name}
          current={setting.limit_source === "person" ? setting.limit_bytes : null}
          roleLimit={setting.limit_source === "role" ? setting.limit_bytes : null}
          onClose={() => setSetting(null)}
        />
      )}
    </section>
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
    <section className="card" aria-labelledby="storage-roles">
      <div className="card-head"><h2 id="storage-roles">By role</h2></div>
      <p className={`muted small ${styles.note}`} style={{ paddingBottom: 12 }}>
        A limit for everyone with a role who has no limit of their own. A custom role's limit comes before its access level's.
      </p>
      {loading ? (
        <div className="card-pad"><SkeletonText lines={3} /></div>
      ) : (
        rows.map((r) => (
          <div key={r.key} className={`card-row ${styles.roleRow}`}>
            <span className="stack-sm" style={{ gap: 0 }}>
              <strong>{r.name}</strong>
              <span className="muted small">{r.detail}</span>
            </span>
            <span className={styles.roleLimit}>
              <span className="small">{r.limit ? `${formatBytes(r.limit)} each` : "No limit"}</span>
              <Button size="sm" onClick={() => setSetting(r)} aria-label={`Set a storage limit for ${r.name}`}>{r.limit ? "Change…" : "Set limit…"}</Button>
            </span>
          </div>
        ))
      )}
      {setting && <AllowanceDialog target={{ role: setting.key }} name={setting.name} current={setting.limit} onClose={() => setSetting(null)} />}
    </section>
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
        <fieldset className={styles.choices}>
          <legend className="sr-only">Storage limit</legend>
          <label className={styles.choice}>
            <input type="radio" name="allowance" checked={!limited} onChange={() => choose(false)} />
            <span className={styles.choiceBody}>
              <strong>{person ? "No limit for this person" : "No limit for this role"}</strong>
              <span className="muted small">
                {person
                  ? roleLimit ? `Their role's limit, ${formatBytes(roleLimit)}, applies.` : "Only the company's limit applies."
                  : "Each person's own limit, or the company's, applies."}
              </span>
            </span>
          </label>
          <label className={styles.choice}>
            <input type="radio" name="allowance" checked={limited} onChange={() => choose(true)} />
            <span className={styles.choiceBody}>
              <strong>{person ? "Limit" : "Limit for each person"}</strong>
              <GbInput value={size} label={`Storage limit for ${name} in GB`} invalid={limited && "problem" in parsed} onFocus={() => !limited && choose(true)} onChange={(v) => { setSize(v); save.reset(); }} />
            </span>
          </label>
        </fieldset>
        <p className="muted small" style={{ margin: 0 }}>
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
    <section className="card card-pad stack-sm" aria-labelledby="storage-areas">
      <h2 id="storage-areas" className={styles.title}>By area</h2>
      <span className="muted small">What each part of Crewtavo holds.</span>
      <ul className={styles.areas}>
        {rows.map((a) => (
          <li key={a.area}>
            <span>{areaLabel(a.area)}</span>
            <span className={styles.bar} data-area={a.area} aria-hidden="true"><span style={{ width: `${(a.bytes / most) * 100}%` }} /></span>
            <span className={styles.amount}>{formatBytes(a.bytes)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// What counts, and what's never refused
// ---------------------------------------------------------------------------------------------

function HowItWorks() {
  return (
    <section className="card card-pad stack-sm" aria-labelledby="storage-how">
      <h2 id="storage-how" className={styles.title}>How limits work</h2>
      <ul className={styles.notes}>
        <li>Every photo and file counts toward the company's limit, including what's in the Trash, until it's deleted for good 30 days after it went there.</li>
        <li>Visit photos, quote photos, receipts and sub paperwork are never refused, so crews can always finish a job. They still count.</li>
        <li>When storage is full, {REFUSED} are turned away until there's room.</li>
        <li>A person's own limit (or their role's) counts the files they added that aren't in the Trash, and stops only what they add to Drive, plans and guides. Owners are never limited.</li>
        <li>Public forms and one-time upload links (booking requests, a sub's paperwork) always go through.</li>
      </ul>
      <span className="muted small">A GB here is a billion bytes, as Railway counts it.</span>
    </section>
  );
}
