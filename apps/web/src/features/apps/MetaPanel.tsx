/**
 * Facebook & Instagram on its Apps page, once signed in (apps/api/src/services/metaConnect.ts): the
 * Page posts go to and its Instagram account, picked from the Pages the sign-in manages; permissions
 * missing, by name, with Reconnect (and, for a Page in a business portfolio, the two Instagram needs
 * then); the last step, switching the Meta app to Live, which Meta's API can't tell Crewtavo about;
 * when Meta asks for a new sign-in; and Check again. Marketing has to be installed for posts to go.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button, cx } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Section } from "@/components/ui/Section";
import { ErrorState } from "@/components/ui/States";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { PrivacyLine } from "./AppKeysCard";
import type { AppRow } from "./catalog";
import { kit, Row, RowsSkeleton } from "./PanelKit";
import { dateLocale } from "@/lib/format";

interface MetaPageChoice {
  id: string;
  name: string;
  picture: string | null;
  can_post: boolean;
  instagram: { id: string; username: string | null } | null;
  business: boolean;
}

/** "Jan 29": when Meta asks for a new sign-in, if it's within two weeks. */
export function signInBy(expiresAt: number | null | undefined, now = Date.now()): string | null {
  if (!expiresAt || expiresAt * 1000 > now + 14 * 86_400_000) return null;
  return new Date(expiresAt * 1000).toLocaleDateString(dateLocale(), { month: "short", day: "numeric" });
}

/** Signs in again at Meta: `again` asks for declined permissions again, `ads` adds the two a business Page needs for Instagram. */
export function useMetaSignIn() {
  return useMutation({
    mutationFn: (options: { ads?: boolean; again?: boolean } = {}) =>
      api.post<{ authorization_url: string }>(`/apps/meta/connect${options.ads ? "?ads=1" : options.again ? "?again=1" : ""}`),
    onSuccess: (res) => window.location.assign(res.authorization_url),
  });
}

/** What Check again found, in a few words: a permission missing, Instagram linked but not used yet, or not linked at all. */
export function checkedWords(res: CheckResult): { tone: "info" | "success"; text: string; pickInstagram: boolean } {
  if (!res.user_sign_in) return { tone: "info", text: "Your Page still posts. Sign in again to change it or its permissions.", pickInstagram: false };
  if (res.missing.length) return { tone: "info", text: "Checked. Some permissions are still missing.", pickInstagram: false };
  if (res.instagram_linked && !res.instagram_used) {
    return { tone: "info", text: `Instagram${res.instagram_username ? ` @${res.instagram_username}` : ""} is linked to your Page now. Tick Post to Instagram too, then Use this Page.`, pickInstagram: true };
  }
  if (!res.instagram_linked) return { tone: "success", text: "Checked. Your Page is in place, and no Instagram account is linked to it.", pickInstagram: false };
  return { tone: "success", text: "Checked. Everything's in place.", pickInstagram: false };
}

interface CheckResult {
  user_sign_in: boolean;
  missing: string[];
  instagram_linked: boolean;
  instagram_used: boolean;
  instagram_username: string | null;
}

/** How wide a Page's or location's name stays beside its buttons before they wrap under it. */
export const NAME_BASIS = "12rem";

export function MetaPanel({ app, onChanged }: { app: AppRow; onChanged: () => void }) {
  const m = app.meta;
  const [picking, setPicking] = useState(false);
  // Check again found Instagram linked but not used: the picker opens with it ticked.
  const [offerInstagram, setOfferInstagram] = useState(false);
  const signIn = useMetaSignIn();
  const check = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<CheckResult>("/apps/meta/check"),
    onSuccess: (res) => {
      const said = checkedWords(res);
      if (said.tone === "info") toast.info(said.text);
      else toast.success(said.text);
      if (said.pickInstagram) {
        setOfferInstagram(true);
        setPicking(true);
      }
    },
    onSettled: onChanged,
  });
  const live = useMutation({
    meta: { inline: true },
    mutationFn: (confirmed: boolean) => api.post("/apps/meta/live", { confirmed }),
    onSuccess: (_, confirmed) => toast.success(confirmed ? "Thanks. Posts now show to everyone." : "Marked as not Live yet"),
    onSettled: onChanged,
  });
  if (!m || app.status === "disconnected") return null;
  const by = signInBy(m.data_access_expires_at);
  const pick = app.status === "connected" && !m.user_token_expired && (picking || m.problem === "pick");
  const canChange = app.status === "connected" && !m.user_token_expired;

  return (
    <Section id="app-setup" title="Your Page" className={kit.panel}>
      {!m.marketing_on && (
        <div className="callout callout-warning">
          <Icon name="pause" size={16} />
          <div className="grow">Marketing is off, so nothing posts. Posts already made stay. <Link to="/apps/marketing">Install Marketing</Link></div>
        </div>
      )}
      {app.status === "error" && (
        <div className="callout callout-danger" role="alert">
          <Icon name="alert" size={16} />
          <div className={cx("grow", kit.calloutBody)}>
            <div>Your Page's sign-in stopped working, so posts don't go.</div>
            <span>Reconnect as the Page's admin.</span>
            <div className={kit.actions}><Button size="sm" variant="primary" icon="refresh" loading={signIn.isPending} onClick={() => signIn.mutate({})}>Reconnect</Button></div>
          </div>
        </div>
      )}
      {app.status === "connected" && m.user_token_expired && (
        <div className="callout callout-info">
          <Icon name="info" size={16} />
          <div className={cx("grow", kit.calloutBody)}>
            <div>Meta's sign-in ran out.</div>
            <span>Sign in again to change the Page or its permissions. Posts keep going meanwhile.</span>
            <div className={kit.actions}><Button size="sm" loading={signIn.isPending} onClick={() => signIn.mutate({})}>Sign in again</Button></div>
          </div>
        </div>
      )}
      {app.status === "connected" && by && !m.user_token_expired && (
        <div className="callout callout-warning">
          <Icon name="clock" size={16} />
          <div className={cx("grow", kit.calloutBody)}>
            <div>Meta asks you to sign in again by {by}, so posts keep going.</div>
            <div className={kit.actions}><Button size="sm" loading={signIn.isPending} onClick={() => signIn.mutate({})}>Reconnect</Button></div>
          </div>
        </div>
      )}
      {m.missing.length > 0 && app.status === "connected" && (
        <div className="callout callout-warning">
          <Icon name="alert" size={16} />
          <div className={cx("grow", kit.calloutBody)}>
            <div>Meta wasn't given {m.missing.length === 1 ? "this permission" : "these permissions"}: {m.missing.map((p, i) => <span key={p}>{i ? ", " : ""}<code className={kit.code}>{p}</code></span>)}.</div>
            <span>Add {m.missing.length === 1 ? "it" : "them"} to your Meta app's use case if {m.missing.length === 1 ? "it isn't" : "they aren't"} there, then reconnect and allow {m.missing.length === 1 ? "it" : "them"}.</span>
            <div className={kit.actions}><Button size="sm" loading={signIn.isPending} onClick={() => signIn.mutate({ again: true })}>Reconnect</Button></div>
          </div>
        </div>
      )}
      {m.needs_business_permissions && (
        <div className="callout callout-warning">
          <Icon name="alert" size={16} />
          <div className={cx("grow", kit.calloutBody)}>
            <div>Your Page is in a business portfolio, so Meta needs <code className={kit.code}>ads_management</code> and <code className={kit.code}>ads_read</code> too before Instagram posts go.</div>
            <span>Add them to your Meta app, then reconnect.</span>
            <div className={kit.actions}><Button size="sm" loading={signIn.isPending} onClick={() => signIn.mutate({ ads: true })}>Reconnect with business Page permissions</Button></div>
          </div>
        </div>
      )}

      {pick ? (
        <PagePicker
          current={m.page?.id ?? null}
          instagramOn={Boolean(m.instagram) || offerInstagram}
          onDone={() => { setPicking(false); setOfferInstagram(false); onChanged(); }}
          onCancel={m.page ? () => { setPicking(false); setOfferInstagram(false); } : undefined}
          onBusiness={() => signIn.mutate({ ads: true })}
          onSignIn={() => signIn.mutate({})}
          signingIn={signIn.isPending}
        />
      ) : m.page ? (
        <div className={kit.rows}>
          {/* A basis for the name, so on a phone the buttons wrap under it rather than squeezing it to a word a line. */}
          <Row
            basis={NAME_BASIS}
            lead={m.page.picture ? <img className={kit.thumb} src={m.page.picture} alt="" width={36} height={36} /> : <span className={kit.roundIcon}><Icon name="globe" size={16} /></span>}
            title={m.page.name ?? "Your Page"}
            sub={m.instagram ? `Instagram: @${m.instagram.username ?? m.instagram.id}` : m.page_instagram ? `Instagram @${m.page_instagram.username ?? ""} is linked, but posts don't go to it` : "No Instagram account linked to this Page"}
            end={
              <>
                {canChange && <Button size="sm" onClick={() => setPicking(true)}>Change Page</Button>}
                <Button size="sm" variant="ghost" icon="refresh" loading={check.isPending} onClick={() => check.mutate()}>Check again</Button>
              </>
            }
          />
        </div>
      ) : null}

      {m.page && app.status === "connected" && (
        m.live_confirmed_at ? (
          <div className={kit.rows}>
            <label className={cx(kit.row, kit.tick)}>
              <input type="checkbox" checked disabled={live.isPending} onChange={() => live.mutate(false)} />
              <span className={kit.rowText}>
                <span className={kit.rowTitle}><span>My Meta app is Live</span></span>
                <span className={kit.rowSub}>Posts show to everyone who follows your Page.</span>
              </span>
            </label>
          </div>
        ) : (
          <div className="callout callout-warning">
            <Icon name="alert" size={16} />
            <div className={cx("grow", kit.calloutBody)}>
              <div>Last step: switch your Meta app to Live, or only you can see the posts.</div>
              <span>In your app's dashboard, fill in the privacy page under <strong>App settings → Basic</strong>, then use the <strong>App mode</strong> switch at the top. Meta's API can't tell Crewtavo when it's Live, so tick the box once you've switched it.</span>
              <div className={kit.calloutWide}><PrivacyLine /></div>
              <label className="checkbox">
                <input type="checkbox" checked={false} disabled={live.isPending} onChange={() => live.mutate(true)} />
                <span>I switched my app to Live</span>
              </label>
            </div>
          </div>
        )
      )}
      <FormError error={check.error ?? live.error ?? signIn.error} />
    </Section>
  );
}

/**
 * The Pages the sign-in manages, to pick the one posts go to, with whether its Instagram account is
 * used too. A Page in a business portfolio with Instagram on asks for the business Page permissions
 * right here, before any post fails for want of them.
 */
function PagePicker({ current, instagramOn, onDone, onCancel, onBusiness, onSignIn, signingIn }: { current: string | null; instagramOn: boolean; onDone: () => void; onCancel?: () => void; onBusiness: () => void; onSignIn: () => void; signingIn: boolean }) {
  const session = useSession();
  const [chosen, setChosen] = useState<string | null>(current);
  const [instagram, setInstagram] = useState(instagramOn || !current);
  const list = useQuery({ queryKey: ["meta-pages", session.company.id], queryFn: () => api.get<{ pages: MetaPageChoice[] }>("/apps/meta/pages") });
  const save = useMutation({
    meta: { inline: true },
    mutationFn: () => api.put<{ needs_business_permissions: boolean }>("/apps/meta/page", { page_id: chosen, instagram }),
    onSuccess: (res) => {
      toast.success("Page saved");
      if (res.needs_business_permissions) toast.info("Your Page is in a business portfolio: reconnect with business Page permissions so Instagram posts go.");
      onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (chosen) save.mutate();
  };
  if (list.isPending) return <RowsSkeleton rows={2} />;
  if (list.error) return <ErrorState compact error={list.error} onRetry={() => list.refetch()} />;
  const pages = list.data.pages;
  const another = <Button loading={signingIn} onClick={onSignIn}>Sign in with another Facebook account</Button>;
  if (!pages.length) {
    return (
      <div className={kit.form}>
        <p className={kit.note}>The Facebook account you signed in with doesn't manage a Page, or its Page wasn't picked when you signed in. Sign in with the Page's admin, and pick the Page.</p>
        <div className={kit.actions}>{another}</div>
      </div>
    );
  }
  const page = pages.find((p) => p.id === chosen);
  const none = !pages.some((p) => p.can_post);
  return (
    <form className={kit.form} onSubmit={submit}>
      <fieldset className={kit.choices}>
        <legend className={kit.label}>Pick your Page</legend>
        {pages.map((p) => {
          const on = chosen === p.id;
          return (
            <label key={p.id} className={kit.choice}>
              <input type="radio" name="meta-page" checked={on} disabled={!p.can_post} onChange={() => setChosen(p.id)} />
              {p.picture ? <img className={kit.thumb} src={p.picture} alt="" width={36} height={36} /> : <span className={kit.roundIcon}><Icon name="globe" size={16} /></span>}
              <span className={kit.rowText}>
                <span className={kit.rowTitle}><span>{p.name}</span></span>
                <span className={kit.rowSub}>{p.instagram ? `Instagram @${p.instagram.username ?? p.instagram.id}` : "No Instagram account linked"}{p.can_post ? "" : " · You can't post as this Page"}</span>
              </span>
            </label>
          );
        })}
      </fieldset>
      {page?.instagram && (
        <label className="checkbox">
          <input type="checkbox" checked={instagram} onChange={(e) => setInstagram(e.target.checked)} />
          <span>Post to Instagram too</span>
        </label>
      )}
      {page?.business && instagram && page.instagram && (
        <div className="callout callout-info">
          <Icon name="info" size={16} />
          <div className={cx("grow", kit.calloutBody)}>
            <div>This Page is in a business portfolio, so Instagram needs two more permissions, ads_management and ads_read.</div>
            <span>Save the Page, then reconnect with them.</span>
            <div className={kit.actions}><Button size="sm" onClick={onBusiness}>Reconnect with business Page permissions</Button></div>
          </div>
        </div>
      )}
      {none && <p className={kit.note}>You can't post as any of these Pages. Ask the Page's admin to give you full control of it, or sign in with their Facebook account.</p>}
      <FormError error={save.error} />
      <div className={kit.actions}>
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!chosen || !page?.can_post}>Use this Page</Button>
        {none && another}
        {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
}
