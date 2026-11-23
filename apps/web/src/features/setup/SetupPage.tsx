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
import { AuthLayout, authMessage, PasswordInput } from "@/features/auth/LoginPage";
import { SpareKeysSheet } from "@/features/auth/SpareKeys";
import styles from "@/features/auth/auth.module.css";
import { api, ApiError, supabase } from "@/lib/api";
import { SETUP_STEPS, SetupProgress, useSetupSteps } from "./SetupProgress";

export interface SetupStatus {
  ready: boolean;
  platform: "railway" | "compose" | "server";
  database: "ok" | "starting" | "not_connected" | "wrong_keys" | "unreachable" | "empty" | "migration_failed";
  migration: { problem?: "wrong_password" | "unreachable" | "bad_url" | "services_not_ready" | "busy" | "newer_database" | "migration_failed"; detail?: string } | null;
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

const Code = ({ children }: { children: ReactNode }) => <code className={styles.code}>{children}</code>;

/** What went wrong, in a few words, for the note beside the steps; and what to know about the data, where it's sure. */
function cause(s: SetupStatus): { title: string; detail?: string } {
  if (s.database === "migration_failed") {
    switch (s.migration?.problem) {
      case "services_not_ready": return { title: "A service didn't start in time" };
      case "wrong_password": return { title: "Database password changed", detail: "Your data is safe. Crewtavo only needs its original password to reach it." };
      case "unreachable": return { title: "Can't reach the database" };
      case "bad_url": return { title: "The database address isn't valid" };
      // The summary already says it keeps trying.
      case "busy": return { title: "The database is busy" };
      case "newer_database": return { title: "The database is newer than this Crewtavo" };
      // The steps already say the data is safe.
      default: return { title: "Updating the database failed" };
    }
  }
  if (s.database === "not_connected") return { title: "No database" };
  if (s.database === "empty") return { title: "The database isn't set up yet" };
  if (s.database === "wrong_keys") return { title: "The keys don't match" };
  return { title: "Can't reach sign-in and data" };
}

const PLATFORM = { railway: "Railway", compose: "Docker Compose", server: "Your server" } as const;

function steps(s: SetupStatus): { title: string; summary: string; steps: ReactNode[] } {
  const railway = s.platform === "railway";
  // Docker Compose (npm run instance reads its secrets from .env.instance), or a server set up another way.
  const compose = s.platform === "compose";
  const restart = railway
    ? <>In your Railway project, open the <strong>crewtavo</strong> service and choose <strong>Redeploy</strong>.</>
    : compose
      ? <>Restart Crewtavo: in the Crewtavo folder, run <Code>docker compose --env-file .env.instance restart crewtavo</Code>.</>
      : <>Restart Crewtavo the way you started it.</>;
  const services = railway
    ? <>Open your Railway project and check that every service (Postgres, auth, rest, storage) says <strong>Active</strong>. If one has crashed, open it and choose <strong>Redeploy</strong>.</>
    : compose
      ? <>In the Crewtavo folder, run <Code>docker compose --env-file .env.instance ps</Code> and check every service is running. <Code>npm run instance</Code> starts any that stopped.</>
      : <>Check that the database and its helper services (auth, rest and storage) are running.</>;
  const fail = (summary: string, list: ReactNode[]) => ({ title: "Finish setting up Crewtavo", summary, steps: list });

  if (s.database === "starting")
    return { title: "Crewtavo is starting up", summary: "It's setting up its database. The first start takes a minute or two; this page moves on by itself.", steps: [] };

  if (s.database === "migration_failed")
    switch (s.migration?.problem) {
      case "services_not_ready":
        return fail("The database or one of its helper services didn't start in time.", [services, restart]);
      case "wrong_password":
        return fail("Crewtavo couldn't sign in to its database. This happens when the database password was changed after the first start.", railway
          ? [<>In Railway, open the <strong>Postgres</strong> service's <strong>Variables</strong> and put back the original <Code>POSTGRES_PASSWORD</Code>. The other services read it from there.</>, restart]
          : compose
            // A restart keeps the password the services were started with: only starting them again reads .env.instance.
            ? [<>Put the original <Code>POSTGRES_PASSWORD</Code> back in the <Code>.env.instance</Code> file next to <Code>docker-compose.yml</Code>, then run <Code>npm run instance</Code> in the Crewtavo folder. It starts every service again with it.</>]
            : [<>Give Crewtavo and its services the original <Code>POSTGRES_PASSWORD</Code> again.</>, restart]);
      case "unreachable":
        return fail("Crewtavo can't reach its database.", [services, restart]);
      case "bad_url":
        return fail("The database address Crewtavo was given isn't valid.", [
          railway ? <>On the <strong>crewtavo</strong> service, check <Code>SUPABASE_DB_URL</Code> under <strong>Variables</strong>. The template sets it; if it was edited, put the template's value back.</> : <>Check <Code>SUPABASE_DB_URL</Code> in <Code>docker-compose.yml</Code>.</>,
          restart,
        ]);
      case "busy":
        return fail("The database was too busy to update: something else was using the tables the update changes. Crewtavo keeps trying by itself.", []);
      case "newer_database":
        return fail("This is an older version of Crewtavo than the one that last updated its database.", [
          railway
            ? <>In your Railway project, open the <strong>crewtavo</strong> service's <strong>Settings</strong>, and under <strong>Source</strong> set the image to <Code>ghcr.io/jviars/crewtavo:latest</Code>, the newest version. Railway then redeploys it.</>
            : <>Get the newest Crewtavo (<Code>git pull</Code> in the Crewtavo folder) and run <Code>npm run instance</Code> again.</>,
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
  const foot = PLATFORM[status.platform] ?? PLATFORM.server;
  if (status.database === "starting")
    return (
      <AuthLayout center foot={foot}>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.sub} style={{ maxWidth: 440 }}>{summary}</p>
        <span className={styles.status} role="status" style={{ marginTop: 22 }}>Checking every few seconds</span>
      </AuthLayout>
    );
  const why = cause(status);
  // Beside the steps on a computer; in the column on a phone, where the side isn't shown.
  const note = (inline?: boolean) => (
    <div className={inline ? `${styles.cause} ${styles.causeInline}` : styles.cause}>
      <Icon name="alert" size={20} />
      <span><b>{why.title}</b>{why.detail}</span>
    </div>
  );
  return (
    <AuthLayout foot={foot} top={<span className={styles.status} role="status">Checking every 15 seconds</span>} aside={note()}>
      <div className={styles.flow}>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.sub}>{summary}{list.length > 0 && " Whoever installed it can fix this in a few minutes:"}</p>
        {note(true)}
        {list.length > 0 && <ol className={styles.steps}>{list.map((step, i) => <li key={i}><span>{step}</span></li>)}</ol>}
        <p className={styles.note} style={{ marginTop: 20 }}>This page goes away by itself once everything is running.</p>
        <div className={styles.acts}>
          <Button variant="primary" icon="refresh" loading={checking} onClick={onCheck}>Check again</Button>
        </div>
      </div>
    </AuthLayout>
  );
}

/** Setting up a new server, in four steps: the owner, the key file, the business, the team. */
/** A new instance's first visitor: create the owner account, then set up the business (OnboardingPage). */
export function OwnerSetupPage({ onTaken }: { onTaken: () => void }) {
  // Every step of setting up this Crewtavo, for "What happens next" (Railway's two at the end, on Railway).
  const steps = useSetupSteps();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
      <AuthLayout
        step={2}
        top={<SetupProgress at="keys" />}
        asideAlign="top"
        aside={
          <div>
            <p className={styles.asideLabel} style={{ fontSize: "var(--fs-14)", marginBottom: 14 }}>Keep it somewhere you'll find it</p>
            <ul className={styles.list}>
              <li><Icon name="check" size={16} />A password manager or a safe folder on your computer</li>
              <li><Icon name="check" size={16} />Printed, in the office filing cabinet</li>
              <li><Icon name="check" size={16} />Not in an email to yourself</li>
            </ul>
          </div>
        }
      >
        <div className={styles.flow}>
          <h1 className={styles.title}>Save your key file</h1>
          {error && <div className="callout callout-warning" role="alert" style={{ marginTop: 16 }}><Icon name="alert" size={16} /><span className="grow" style={{ fontWeight: 600 }}>{error}</span></div>}
          <SpareKeysSheet keys={spareKeys} email={email.trim()} doneLabel="Continue" busy={busy} onDone={signIn} bar />
        </div>
      </AuthLayout>
    );

  return (
    <AuthLayout
      step={1}
      top={<SetupProgress at="owner" />}
      asideAlign="top"
      aside={
        <div>
          <p className={styles.asideLabel} style={{ fontSize: "var(--fs-14)", marginBottom: 14 }}>What happens next</p>
          <ol className={styles.whatNext}>
            {steps.map((step, i) => <li key={step} data-on={i === 0 || undefined}><span aria-hidden="true">{i + 1}</span><span><b>{SETUP_STEPS[step].title}</b>{SETUP_STEPS[step].text}</span></li>)}
          </ol>
          <p className={styles.asideHint} style={{ marginTop: 16 }}>Then invite your team from Home, whenever you're ready.</p>
        </div>
      }
    >
      <form className={styles.flow} onSubmit={submit}>
        <h1 className={styles.title}>Welcome to Crewtavo</h1>
        <p className={styles.sub}>Create your owner account. Next you'll set up your business, then invite your team.</p>
        <div className={styles.form}>
          <Field label="Your name"><input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" required minLength={2} maxLength={120} autoFocus /></Field>
          <Field label="Email"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" inputMode="email" required /></Field>
          <Field label="Password" hint="At least 8 characters. You'll sign in with this.">
            <PasswordInput value={password} onChange={setPassword} autoComplete="new-password" minLength={8} />
          </Field>
          {error && <div className="callout callout-warning" role="alert"><Icon name="alert" size={16} /><span className="grow" style={{ fontWeight: 600 }}>{error}</span></div>}
        </div>
        <div className={styles.acts} data-stack="">
          <Button type="submit" variant="primary" loading={busy}>Create owner account</Button>
        </div>
      </form>
    </AuthLayout>
  );
}
