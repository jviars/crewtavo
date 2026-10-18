/**
 * The public demo (CREWTAVO_DEMO=1 on the server, apps/api/src/services/demo.ts): no sign-in. The
 * start screen gives each visitor their own copy of a sample paving company, and the bar above the
 * app lets them switch to the crew's view or open the client portal.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { AuthLayout } from "@/features/auth/LoginPage";
import { api, supabase } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import authStyles from "@/features/auth/auth.module.css";
import styles from "./demo.module.css";

/** Where "Get Crewtavo" goes: the guided setup on the website. */
const GET_CREWTAVO = "https://crewtavo.com/start/";
const DEMO_HOURS = 24;

interface DemoSession {
  access_token: string;
  refresh_token: string;
}

async function signInAs(session: DemoSession) {
  const { error } = await supabase().auth.setSession(session);
  if (error) throw error;
}

/** Arriving from crewtavo.com's "Try the demo" (…/?start) opens the demo without another click. */
const startRequested = (() => {
  try {
    return new URLSearchParams(window.location.search).has("start");
  } catch {
    return false;
  }
})();

/** In place of the sign-in page: start a copy of the sample company. */
export function DemoStart() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  async function start() {
    if (started.current) return;
    started.current = true;
    setBusy(true);
    setError(null);
    try {
      // SessionProvider takes over once the session is set.
      await signInAs(await api.post<DemoSession>("/demo/start"));
      const url = new URL(window.location.href);
      url.searchParams.delete("start");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
      started.current = false;
    }
  }

  useEffect(() => {
    if (startRequested) void start();
  }, []);

  return (
    <AuthLayout>
      <div className={`card card-pad ${authStyles.card}`} style={{ padding: 32 }}>
        <span className={styles.tag}>Live demo</span>
        <h1 className={authStyles.title}>Try Crewtavo</h1>
        <p style={{ margin: 0 }}>
          Click around <strong>Acme Paving</strong>, a sample company with clients, quotes waiting for approval, a week of crew visits, invoices and equipment.
        </p>
        <ul className={styles.points}>
          <li><Icon name="check" size={16} />No sign-up. This copy is yours alone, so change anything.</li>
          <li><Icon name="check" size={16} />See it as the owner, as the crew on their phones, and as a client.</li>
          <li><Icon name="check" size={16} />It's deleted after {DEMO_HOURS} hours. Nothing is emailed or texted.</li>
        </ul>
        <Button variant="primary" size="lg" block loading={busy} onClick={start}>
          {busy ? "Setting up your company…" : "Open the demo"}
        </Button>
        {error && <p role="alert" className="field-error" style={{ margin: 0 }}>{error}</p>}
        <p className="muted small" style={{ margin: 0, textAlign: "center" }}>
          Ready for your own? <a href={GET_CREWTAVO}>Get Crewtavo free</a>
        </p>
      </div>
    </AuthLayout>
  );
}

/** Above the app in the demo: who you're seeing it as, and ways to see the other sides. */
export function DemoBar() {
  const session = useSession();
  const [busy, setBusy] = useState<null | "switch" | "portal">(null);
  const owner = session.role === "owner";

  async function switchTo(as: "owner" | "crew") {
    setBusy("switch");
    try {
      await signInAs(await api.post<DemoSession>("/demo/switch", { as }));
      // A fresh start, so nothing from the other person's view lingers.
      window.location.assign(as === "crew" ? "/field" : "/");
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(null);
    }
  }

  async function openPortal() {
    // Opened now, filled in when the link arrives, so the browser doesn't block it as a pop-up.
    const tab = window.open("", "_blank");
    setBusy("portal");
    try {
      const { data } = await supabase().from("clients").select("id").eq("company_id", session.company.id).eq("display_name", "Jordan Rivera").maybeSingle();
      const first = data ?? (await supabase().from("clients").select("id").eq("company_id", session.company.id).limit(1).maybeSingle()).data;
      if (!first) throw new Error("Add a client first, then open their portal from the client's page.");
      const { link } = await api.get<{ link: string }>(`/clients/${first.id}/hub-link`);
      if (tab) tab.location.href = link;
      else window.location.assign(link);
    } catch (err) {
      tab?.close();
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={styles.bar} role="region" aria-label="Demo">
      <span className={styles.label}>
        <span className={styles.tag}>Demo</span>
        <span>
          You're seeing it as <strong>{session.profile.full_name}</strong> ({session.roleName.toLowerCase()}).{" "}
          <span className={styles.note}>Deleted after {DEMO_HOURS} hours.</span>
        </span>
      </span>
      <span className={styles.actions}>
        {owner ? (
          <>
            <Button size="sm" variant="ghost" icon="truck" loading={busy === "switch"} disabled={Boolean(busy)} onClick={() => switchTo("crew")}>Crew's view</Button>
            <Button size="sm" variant="ghost" icon="user" loading={busy === "portal"} disabled={Boolean(busy)} onClick={openPortal}>Client portal</Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" icon="arrowLeft" loading={busy === "switch"} disabled={Boolean(busy)} onClick={() => switchTo("owner")}>Owner's view</Button>
        )}
        <a className="btn btn-sm btn-primary" href={GET_CREWTAVO}>Get Crewtavo free</a>
      </span>
    </div>
  );
}
