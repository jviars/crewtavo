/**
 * Startup and identity: load config, restore the Supabase session, then load the user's companies.
 * No session -> sign-in page. No company yet -> onboarding. An owner or admin of a business that
 * hasn't agreed to the current license -> agree first. Otherwise children render with
 * useSession() available and API calls carry the active company.
 */
import type { Permission, Role } from "@crewtavo/core/roles";
import type { Session as AuthSession } from "@supabase/supabase-js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { ShellSkeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { LoginPage, SetPasswordPage } from "@/features/auth/LoginPage";
import { OnboardingPage } from "@/features/auth/OnboardingPage";
import { FirstRun, SetupGate } from "@/features/setup/SetupPage";
import { registerFieldActions } from "@/features/field/fieldActions";
import { TermsPage } from "@/features/legal/License";
import { api, ApiError, loadConfig, setActiveCompany, supabase, type AppConfig } from "./api";
import { forgetOfflineCache, keepQueuedFieldActions, pendingFieldActions, startOfflineCache } from "./offline";
import { setSessionExpiredHandler } from "./queryClient";
import { toast } from "./toast";

export interface Company {
  id: string;
  name: string;
  slug: string;
  trade_preset: string;
  timezone: string;
  currency: string;
  settings: Record<string, unknown>;
}

interface Me {
  profile: { user_id: string; email: string | null; full_name: string; phone: string | null; color?: string | null };
  memberships: Array<{ role: Role; role_name: string; permissions: Permission[]; company: Company; email_connected?: boolean; terms_accepted?: boolean }>;
}

export interface Session {
  config: AppConfig & { features: AppConfig["features"] & { devMail?: boolean } };
  userId: string;
  profile: Me["profile"];
  companies: Me["memberships"];
  company: Company;
  role: Role;
  /** The role's display name: a custom role ("Foreman") or a built-in one ("Office"). */
  roleName: string;
  /** Areas this person's role includes. */
  permissions: Permission[];
  switchCompany: (id: string) => void;
  signOut: () => Promise<void>;
  refresh: () => Promise<unknown>;
}

const SessionContext = createContext<Session | null>(null);
const COMPANY_KEY = "crewtavo.company";

function storedCompany(): string | null {
  try {
    return localStorage.getItem(COMPANY_KEY);
  } catch {
    return null;
  }
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16, background: "var(--ground)" }}>
      <div className="card" style={{ width: "min(480px, 100%)" }}>{children}</div>
    </div>
  );
}

/**
 * A one-time link from an email (invite, password reset, sign-in) opens the app with
 * ?token_hash=…&type=… (emailAuthLink in apps/api/src/lib/auth.ts), and the app redeems it here, so it
 * works whatever the Supabase project's Site URL is. Links from Supabase's own mailer arrive with
 * #access_token=…&type=… instead, and supabase-js signs in from those by itself.
 */
const LINK_TYPES = ["invite", "recovery", "magiclink", "signup", "email"] as const;
const emailLink = (() => {
  try {
    const query = new URLSearchParams(window.location.search);
    const tokenHash = query.get("token_hash");
    const type = LINK_TYPES.find((t) => t === query.get("type"));
    return tokenHash && type ? { tokenHash, type, welcome: query.get("welcome") === "1" } : null;
  } catch {
    return null;
  }
})();

/** Arriving from a password-reset or invitation email (read before Supabase clears the URL). */
const arrivedVia = (() => {
  if (emailLink) return emailLink.welcome || emailLink.type === "invite" ? "invite" : emailLink.type === "recovery" ? "recovery" : null;
  try {
    const type = new URLSearchParams(window.location.hash.slice(1)).get("type") ?? new URLSearchParams(window.location.search).get("type");
    return type === "recovery" || type === "invite" ? type : null;
  } catch {
    return null;
  }
})();

let redeeming: Promise<string | null> | null = null;

/** Trades the emailed token for a session, once (React runs effects twice in development). Resolves to a problem to show, or null. */
function redeemEmailLink(): Promise<string | null> {
  if (!emailLink) return Promise.resolve(null);
  redeeming ??= supabase()
    .auth.verifyOtp({ token_hash: emailLink.tokenHash, type: emailLink.type })
    .then(
      ({ error }) => (error ? "That link has expired or was already used. Sign in below, or ask for a new link." : null),
      () => "Couldn't open that link. Check your connection and try again.",
    )
    .finally(() => {
      // The token works once; keep it out of the address bar and history.
      const url = new URL(window.location.href);
      for (const key of ["token_hash", "type", "welcome"]) url.searchParams.delete(key);
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    });
  return redeeming;
}

export function SessionProvider({ children, requireCompany = true }: { children: ReactNode; requireCompany?: boolean }) {
  const queryClient = useQueryClient();
  // Runs with no signal too: loadConfig falls back to the settings saved last time.
  const config = useQuery({ queryKey: ["config"], queryFn: loadConfig, staleTime: Infinity, retry: 2, networkMode: "always", meta: { silent: true } });
  const [auth, setAuth] = useState<AuthSession | null | undefined>(undefined);
  const [companyId, setCompanyId] = useState<string | null>(storedCompany);
  const [settingPassword, setSettingPassword] = useState<"recovery" | "invite" | null>(arrivedVia);
  const [linkProblem, setLinkProblem] = useState<string | null>(null);
  /** The person chose to sign out (rather than the app signing them out). */
  const signingOut = useRef(false);

  useEffect(() => {
    if (!config.data) return;
    const client = supabase();
    let lastUser: string | null = null;
    redeemEmailLink()
      .then((problem) => {
        setLinkProblem(problem);
        return client.auth.getSession();
      })
      .then(({ data, error }) => {
        // No signal and the sign-in needs refreshing: keep going with the saved one (refreshed once
        // the connection is back) rather than sending the crew to the sign-in page.
        const session = data.session ?? (error && !navigator.onLine ? savedSession() : null);
        lastUser = session?.user.id ?? null;
        setAuth(session);
        // An expired reset or invite link leaves no session: just show sign-in.
        if (!session) setSettingPassword(null);
      });
    const { data } = client.auth.onAuthStateChange((event, session) => {
      setAuth(session);
      if (session) lastUser = session.user.id;
      // A re-sent invite arrives as a recovery link; keep the "set your password" wording.
      if (event === "PASSWORD_RECOVERY") setSettingPassword((current) => current ?? "recovery");
      if (event === "SIGNED_OUT") {
        // Signing out on purpose leaves nothing of theirs on the phone (it may be shared). Signed out
        // by the app (the sign-in expired, or couldn't be refreshed on a flaky connection), their
        // unsent field actions stay, and go out when they sign back in.
        if (lastUser && signingOut.current) forgetOfflineCache(lastUser);
        else if (lastUser) keepQueuedFieldActions(queryClient, lastUser);
        signingOut.current = false;
        lastUser = null;
        queryClient.clear();
      }
    });
    return () => data.subscription.unsubscribe();
  }, [config.data, queryClient]);

  useEffect(() => {
    setSessionExpiredHandler(() => {
      supabase().auth.signOut().catch(() => undefined);
    });
  }, []);

  const me = useQuery({
    queryKey: ["me", auth?.user.id],
    queryFn: async () => {
      const key = `crewtavo.me.${auth!.user.id}`;
      try {
        const fresh = await api.get<Me>("/me");
        try {
          localStorage.setItem(key, JSON.stringify(fresh));
        } catch {
          // Storage full or private mode.
        }
        return fresh;
      } catch (error) {
        // No signal: who I am and my companies, from last time.
        const saved = error instanceof ApiError && error.status === 0 ? localStorage.getItem(key) : null;
        if (saved) return JSON.parse(saved) as Me;
        throw error;
      }
    },
    networkMode: "always",
    enabled: Boolean(auth),
    staleTime: 5 * 60_000,
    meta: { silent: true },
  });

  const membership = me.data?.memberships.find((m) => m.company.id === companyId) ?? me.data?.memberships[0];
  setActiveCompany(membership?.company.id ?? null);

  // Crews keep their day on the phone; queued field actions survive closing the app (lib/offline.ts).
  const userId = auth?.user.id;
  const role = membership?.role;
  // Screens wait for the saved data, so it's in place before they start loading their own.
  const [cacheFor, setCacheFor] = useState<string | null>(null);
  useEffect(() => {
    if (!userId || !role) return;
    // In this order: startOfflineCache adds its retry rules to the defaults registered here.
    registerFieldActions(queryClient);
    const stop = startOfflineCache(queryClient, userId, role === "crew_lead" || role === "field_crew");
    setCacheFor(userId);
    return () => {
      stop();
      setCacheFor(null);
    };
  }, [userId, role, queryClient]);

  const switchCompany = useCallback(
    (id: string) => {
      try {
        localStorage.setItem(COMPANY_KEY, id);
      } catch {
        // Private mode: the choice just won't survive a reload.
      }
      setCompanyId(id);
      setActiveCompany(id);
      queryClient.removeQueries({ predicate: (q) => !["config", "me"].includes(String(q.queryKey[0])) });
    },
    [queryClient],
  );

  /** Signing out clears everything of theirs from this phone, so first say if field actions are still waiting to send. */
  const signOut = useCallback(async () => {
    const waiting = pendingFieldActions(queryClient);
    const ok =
      !waiting ||
      (await confirm({
        title: waiting === 1 ? "1 update hasn't sent yet" : `${waiting} updates haven't sent yet`,
        body: "They're saved on this phone and go out when you have signal. Signing out now deletes them.",
        confirmLabel: "Sign out anyway",
        danger: true,
      }));
    if (!ok) return;
    signingOut.current = true;
    await supabase().auth.signOut().catch(() => undefined);
    // Still set: no SIGNED_OUT came (the sign-in needed refreshing and that didn't get through).
    if (signingOut.current) toast.error("Couldn't sign out. Try again when you have signal.");
    signingOut.current = false;
  }, [queryClient]);

  const value = useMemo<Session | null>(() => {
    if (!config.data || !auth || !me.data || !membership || cacheFor !== auth.user.id) return null;
    // The company's own mailbox (Settings → Email) counts as email being on.
    const ownMailbox = Boolean(membership.email_connected);
    return {
      config: { ...config.data, features: { ...config.data.features, email: config.data.features.email || ownMailbox, devMail: !ownMailbox && Boolean((config.data.features as { devMail?: boolean }).devMail) } },
      userId: auth.user.id,
      profile: me.data.profile,
      companies: me.data.memberships,
      company: membership.company,
      role: membership.role,
      roleName: membership.role_name,
      permissions: membership.permissions ?? [],
      switchCompany,
      signOut,
      refresh: () => me.refetch(),
    };
  }, [config.data, auth, me, membership, switchCompany, signOut, cacheFor]);

  // Errors before anyone can use the app are usually unfinished setup: SetupGate shows the steps instead.
  if (config.error) {
    return (
      <SetupGate>
        <Centered>
          <ErrorState title="Can't reach Crewtavo" error={config.error} onRetry={() => config.refetch()} />
        </Centered>
      </SetupGate>
    );
  }
  if (!config.data || auth === undefined) return <ShellSkeleton />;
  if (!auth) {
    // A one-business instance: setup steps, or the owner's first account, before the sign-in page.
    return config.data.singleCompany ? <FirstRun><LoginPage notice={linkProblem} /></FirstRun> : <LoginPage notice={linkProblem} />;
  }
  if (settingPassword) return <SetPasswordPage kind={settingPassword} onDone={() => setSettingPassword(null)} />;
  if (me.error) {
    return (
      <SetupGate>
        <Centered>
          <ErrorState title="Couldn't load your account" error={me.error} onRetry={() => me.refetch()} />
          <div style={{ display: "flex", justifyContent: "center", paddingBottom: 24, marginTop: -12 }}>
            <Button variant="ghost" icon="logout" onClick={() => signOut()}>Sign out</Button>
          </div>
        </Centered>
      </SetupGate>
    );
  }
  if (!me.data) return <ShellSkeleton />;
  if (!membership) {
    return requireCompany ? <OnboardingPage onCreated={() => me.refetch()} /> : <>{children}</>;
  }
  // Only false from the server counts: an account saved for working offline may predate it.
  if (membership.terms_accepted === false && (membership.role === "owner" || membership.role === "admin")) {
    return <TermsPage companyName={membership.company.name} onAccepted={() => me.refetch()} />;
  }
  if (!value) return <ShellSkeleton />;
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside SessionProvider");
  return session;
}

/** Owners can do everything; otherwise check the member's role. */
export const hasRole = (session: Pick<Session, "role">, ...roles: string[]) => session.role === "owner" || roles.includes(session.role);

/** Does this person's role include an area (invoices, reports, marketing...)? */
export const can = (session: Pick<Session, "role" | "permissions">, permission: Permission) => session.role === "owner" || session.permissions.includes(permission);

/** The sign-in Supabase saved in this browser, for opening the app with no signal. */
function savedSession(): AuthSession | null {
  try {
    const key = Object.keys(localStorage).find((k) => /^sb-.+-auth-token$/.test(k));
    const parsed = key ? (JSON.parse(localStorage.getItem(key) ?? "null") as (AuthSession & { currentSession?: AuthSession }) | null) : null;
    const session = parsed?.access_token ? parsed : parsed?.currentSession ?? null;
    return session?.user ? session : null;
  } catch {
    return null;
  }
}
