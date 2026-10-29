/**
 * First run of a Crewtavo instance (one business per Railway project or docker compose stack).
 * GET /api/setup (apps/api/src/routes/setup.ts) says where it stands:
 *   - still starting, or something kept it from starting → "Finish setting up Crewtavo" with steps;
 *   - ready but nobody has an account yet → the owner creates theirs (OwnerSetupPage).
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { ShellSkeleton } from "@/components/ui/Skeleton";
import { AuthLayout, authMessage } from "@/features/auth/LoginPage";
import { SpareKeysSheet } from "@/features/auth/SpareKeys";
import styles from "@/features/auth/auth.module.css";
import { api, ApiError, supabase } from "@/lib/api";

export interface SetupStatus {
  ready: boolean;
  platform: "railway" | "compose" | "server";
  database: "ok" | "starting" | "not_connected" | "wrong_keys" | "unreachable" | "empty" | "migration_failed";
  migration: { problem?: "wrong_password" | "unreachable" | "bad_url" | "services_not_ready" | "migration_failed"; detail?: string } | null;
  needsOwner: boolean;
}

async function loadSetup(): Promise<SetupStatus> {
  const res = await fetch("/api/setup", { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("setup");
  return (await res.json()) as SetupStatus;
}

export function useSetupStatus(enabled = true) {
  return useQuery({
    queryKey: ["setup"],
    queryFn: loadSetup,
    enabled,
    retry: 1,
    staleTime: 5_000,
    // While it's starting or unfinished, keep checking so the page moves on by itself.
    refetchInterval: (query) => (!query.state.data || query.state.data.ready ? false : query.state.data.database === "starting" ? 3_000 : 15_000),
    meta: { silent: true },
  });
}

/** Reload once setup finishes, so config and the session start from scratch. */
function useReloadWhenReady(ready: boolean | undefined) {
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (ready === false) setWaiting(true);
    else if (ready && waiting) window.location.reload();
  }, [ready, waiting]);
  return Boolean(ready && waiting);
}

/**
 * Wrap an error screen: if the cause is unfinished setup, show the setup steps instead. Otherwise
 * (or if the check itself fails) the error shows as before.
 */
export function SetupGate({ children }: { children: ReactNode }) {
  const status = useSetupStatus();
  const reloading = useReloadWhenReady(status.data?.ready);
  if (status.isPending || reloading) return <ShellSkeleton />;
  if (status.data && !status.data.ready) return <SetupPage status={status.data} onCheck={() => status.refetch()} checking={status.isFetching} />;
  return <>{children}</>;
}

/** Before anyone signs in to a one-business instance: setup steps, or the owner's first account. */
export function FirstRun({ children }: { children: ReactNode }) {
  const status = useSetupStatus();
  const reloading = useReloadWhenReady(status.data?.ready);
  // Once owner setup starts it stays until the owner is signed in: the account exists as soon as
  // it's made, so the next check says no owner is needed, and the key file screen mustn't vanish.
  const [ownerSetup, setOwnerSetup] = useState(false);
  useEffect(() => {
    if (status.data?.needsOwner) setOwnerSetup(true);
  }, [status.data?.needsOwner]);
  if (ownerSetup || status.data?.needsOwner) {
    return <OwnerSetupPage onTaken={() => { setOwnerSetup(false); void status.refetch(); }} />;
  }
  if (status.isPending || reloading) return <ShellSkeleton />;
  if (status.data && !status.data.ready) return <SetupPage status={status.data} onCheck={() => status.refetch()} checking={status.isFetching} />;
  return <>{children}</>;
}

const Code = ({ children }: { children: ReactNode }) => <code style={{ fontSize: 13, padding: "1px 5px", borderRadius: "var(--radius-sm)", background: "var(--fill)" }}>{children}</code>;

function steps(s: SetupStatus): { title: string; summary: string; steps: ReactNode[] } {
  const railway = s.platform === "railway";
  const restart = railway ? <>In your Railway project, open the <strong>crewtavo</strong> service and choose <strong>Redeploy</strong>.</> : <>Restart Crewtavo (<Code>docker compose restart app</Code>).</>;
  const services = railway
    ? <>Open your Railway project and check that every service (Postgres, auth, rest, storage) says <strong>Active</strong>. If one has crashed, open it and choose <strong>Redeploy</strong>.</>
    : <>Run <Code>docker compose ps</Code> in the Crewtavo folder and check every service is running. Start any that stopped with <Code>docker compose up -d</Code>.</>;
  const fail = (summary: string, list: ReactNode[]) => ({ title: "Finish setting up Crewtavo", summary, steps: list });

  if (s.database === "starting")
    return { title: "Crewtavo is starting up", summary: "It's setting up its database. The first start takes a minute or two; this page moves on by itself.", steps: [] };

  if (s.database === "migration_failed")
    switch (s.migration?.problem) {
      case "services_not_ready":
        return fail("The database or one of its helper services didn't start in time.", [services, restart]);
      case "wrong_password":
        return fail("Crewtavo couldn't sign in to its database. This happens when the database password was changed after the first start.", [
          railway
            ? <>In Railway, open the <strong>Postgres</strong> service's <strong>Variables</strong> and put back the original <Code>POSTGRES_PASSWORD</Code>. The other services read it from there.</>
            : <>Put the original <Code>POSTGRES_PASSWORD</Code> back in the <Code>.env</Code> file next to <Code>docker-compose.yml</Code>.</>,
          restart,
        ]);
      case "unreachable":
        return fail("Crewtavo can't reach its database.", [services, restart]);
      case "bad_url":
        return fail("The database address Crewtavo was given isn't valid.", [
          railway ? <>On the <strong>crewtavo</strong> service, check <Code>SUPABASE_DB_URL</Code> under <strong>Variables</strong>. The template sets it; if it was edited, put the template's value back.</> : <>Check <Code>SUPABASE_DB_URL</Code> in <Code>docker-compose.yml</Code>.</>,
          restart,
        ]);
      default:
        return fail("Setting up the database failed. This is a problem in Crewtavo itself, not in anything you did.", [
          <>Send this to whoever supports your Crewtavo: <Code>{s.migration?.detail ?? "unknown error"}</Code></>,
          <>Once it's fixed, redeploy. Your data is safe: each step either finishes completely or not at all.</>,
        ]);
    }

  if (s.database === "not_connected")
    return fail("Crewtavo is running on its own, without its database and the services that come with it.", [
      <>Deploy Crewtavo with its Railway template, which includes everything, or run <Code>docker compose up</Code> in the Crewtavo folder.</>,
    ]);
  if (s.database === "empty") return fail("The database hasn't been set up yet.", [restart]);
  if (s.database === "wrong_keys") return fail("Crewtavo's keys don't match its services. This happens when JWT_SECRET differs between services.", [<>Make sure every service uses the same <Code>JWT_SECRET</Code>, then redeploy them.</>]);
  return fail("Crewtavo can't reach its sign-in and data services.", [services, restart]);
}

export function SetupPage({ status, onCheck, checking }: { status: SetupStatus; onCheck: () => void; checking: boolean }) {
  const { title, summary, steps: list } = steps(status);
  const starting = status.database === "starting";
  return (
    <AuthLayout>
      <div className={`card card-pad ${styles.card} ${styles.wide}`} style={{ padding: 28, gap: 18 }}>
        <div style={{ display: "grid", gap: 6 }}>
          <h1 className={styles.title}>{title}</h1>
          <p className="muted" style={{ margin: 0 }}>{summary}{list.length > 0 && " Whoever installed it can fix this in a few minutes:"}</p>
        </div>
        {list.length > 0 && (
          <ol style={{ margin: 0, paddingLeft: 22, display: "grid", gap: 12, lineHeight: 1.5 }}>
            {list.map((step, i) => <li key={i}>{step}</li>)}
          </ol>
        )}
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span className="muted small">{starting ? "Checking every few seconds…" : "This page goes away by itself once everything is running."}</span>
          {!starting && <Button variant="primary" icon="refresh" loading={checking} onClick={onCheck}>Check again</Button>}
        </div>
      </div>
    </AuthLayout>
  );
}

/** A new instance's first visitor: create the owner account, then set up the business (OnboardingPage). */
export function OwnerSetupPage({ onTaken }: { onTaken: () => void }) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Shown once, right after the account is made, before signing in.
  const [spareKeys, setSpareKeys] = useState<string[] | null>(null);

  async function signIn() {
    setBusy(true);
    const { error: signInError } = await supabase().auth.signInWithPassword({ email: email.trim(), password });
    // Signed in: SessionProvider moves on to setting up the business.
    if (signInError) {
      setError(authMessage(signInError));
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (fullName.trim().length < 2) return setError("Enter your name.");
    if (password.length < 8) return setError("Use at least 8 characters for your password.");
    setBusy(true);
    try {
      const result = await api.post<{ spare_keys: string[] | null }>("/setup/owner", { full_name: fullName.trim(), email: email.trim(), password });
      if (result.spare_keys?.length) {
        setSpareKeys(result.spare_keys);
        setBusy(false);
      } else await signIn();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : authMessage(err as { message: string });
      setError(message);
      if (/already set up|someone else/i.test(message)) onTaken();
      setBusy(false);
    }
  }

  if (spareKeys)
    return (
      <AuthLayout>
        <div className={`card card-pad ${styles.card}`} style={{ padding: 28 }}>
          <h1 className={styles.title}>Save your key file</h1>
          <SpareKeysSheet keys={spareKeys} email={email.trim()} doneLabel="Continue" busy={busy} onDone={signIn} />
          {error && <div className="callout callout-warning" role="alert" style={{ padding: "10px 12px" }}><Icon name="alert" size={16} /><span className="grow small" style={{ fontWeight: 600 }}>{error}</span></div>}
        </div>
      </AuthLayout>
    );

  return (
    <AuthLayout>
      <form className={`card card-pad ${styles.card}`} style={{ padding: 28 }} onSubmit={submit}>
        <div style={{ display: "grid", gap: 6 }}>
          <h1 className={styles.title}>Welcome to Crewtavo</h1>
          <p className="muted" style={{ margin: 0 }}>Create your owner account. Next you'll set up your business, then invite your team.</p>
        </div>
        <Field label="Your name"><input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" required minLength={2} maxLength={120} autoFocus /></Field>
        <Field label="Email"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" inputMode="email" required /></Field>
        <Field label="Password" hint="At least 8 characters. You'll sign in with this.">
          <div className="input-group">
            <input className="input" type={show ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} required style={{ paddingLeft: 12, paddingRight: 40 }} />
            <button type="button" className="icon-btn" style={{ position: "absolute", right: 3 }} aria-label={show ? "Hide password" : "Show password"} onClick={() => setShow(!show)}><Icon name={show ? "eye" : "lock"} size={16} /></button>
          </div>
        </Field>
        {error && <div className="callout callout-warning" role="alert" style={{ padding: "10px 12px" }}><Icon name="alert" size={16} /><span className="grow small" style={{ fontWeight: 600 }}>{error}</span></div>}
        <Button type="submit" variant="primary" size="lg" loading={busy}>Create owner account</Button>
      </form>
    </AuthLayout>
  );
}
