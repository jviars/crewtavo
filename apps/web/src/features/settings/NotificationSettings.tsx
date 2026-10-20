/**
 * How I hear about things outside the app: per kind of notification, by email, text, or a push to
 * this phone. The bell in the app always shows everything. Above it, where the browser offers it,
 * installing Crewtavo as an app on this device (lib/install.ts).
 */
import { DEFAULT_NOTIFICATION_PREFS, NOTIFICATION_TOPICS, type NotificationChannel, type NotificationTopic } from "@crewtavo/core/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { api, supabase, unwrap } from "@/lib/api";
import { useInstallHint } from "@/lib/install";
import { disablePush, enablePush, pushState } from "@/lib/push";
import { hasRole, useSession, type Session } from "@/lib/session";
import { toast } from "@/lib/toast";
import { InstallAppButton } from "../field/InstallAppCard";
import { chatOn } from "../chat/data";

type Prefs = Record<NotificationChannel, NotificationTopic[]>;

/** Railway's warnings go to owners and admins of a Crewtavo on Railway (Settings → Hosting). */
const railwayWarnings = (session: Session) => hasRole(session, "admin") && session.config.platform === "railway";

const COLUMNS: Array<{ channel: NotificationChannel; label: string }> = [
  { channel: "push", label: "This phone" },
  { channel: "email", label: "Email" },
  { channel: "sms", label: "Text" },
];

export function NotificationSettings({ phone }: { phone: string | null }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const key = ["notification-prefs", session.company.id, session.userId];
  const prefs = useQuery({
    queryKey: key,
    queryFn: async () => {
      const row = unwrap(await supabase().from("notification_prefs").select("email, sms, push").eq("company_id", session.company.id).eq("user_id", session.userId).maybeSingle());
      return (row ?? DEFAULT_NOTIFICATION_PREFS) as Prefs;
    },
  });
  const push = useQuery({ queryKey: ["push-state"], queryFn: pushState, staleTime: 0 });
  // On an iPhone, adding Crewtavo to the Home Screen is explained where notifications are turned on (PushRow).
  const canInstall = useInstallHint() === "prompt";

  const save = useMutation({
    mutationFn: async (next: Prefs) =>
      unwrap(await supabase().from("notification_prefs").upsert({ company_id: session.company.id, user_id: session.userId, ...next })),
    onMutate: (next) => {
      const previous = queryClient.getQueryData<Prefs>(key);
      queryClient.setQueryData(key, next);
      return { previous };
    },
    onError: (_e, _v, ctx) => ctx?.previous && queryClient.setQueryData(key, ctx.previous),
  });
  const pushToggle = useMutation({
    meta: { inline: true },
    mutationFn: async (on: boolean) => (on ? enablePush() : disablePush()),
    onSuccess: (_r, on) => toast.success(on ? "Notifications are on for this phone" : "Notifications are off for this phone"),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["push-state"] }),
  });
  const test = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post("/push/test", {}),
    onSuccess: () => toast.success("Test sent. It should pop up in a few seconds."),
  });

  const toggle = (channel: NotificationChannel, topic: NotificationTopic, on: boolean) => {
    const current = prefs.data ?? DEFAULT_NOTIFICATION_PREFS;
    save.mutate({ ...current, [channel]: on ? [...new Set([...current[channel], topic])] : current[channel].filter((t) => t !== topic) });
  };
  const available = (channel: NotificationChannel) =>
    channel === "email" ? session.config.features.email : channel === "sms" ? session.config.features.sms && Boolean(phone) : true;

  return (
    <>
    {canInstall && (
      <div className="card card-pad stack-sm">
        <strong>Crewtavo app</strong>
        <span className="muted small">Install Crewtavo on this device. It opens in its own window, from your home screen or app list, like any other app.</span>
        <InstallAppButton style={{ justifySelf: "start" }} />
      </div>
    )}
    <div className="card card-pad stack-sm">
      <strong>Notifications</strong>
      <span className="muted small">The bell shows everything. Choose what also reaches you when you're not in Crewtavo.</span>

      <PushRow state={push.data} busy={pushToggle.isPending} onToggle={(on) => pushToggle.mutate(on)} onTest={() => test.mutate()} testing={test.isPending} />
      <FormError error={pushToggle.error ?? test.error} />

      {prefs.isPending ? (
        <Skeleton height={140} radius={8} />
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="table" style={{ minWidth: 340 }}>
            <thead>
              <tr>
                <th scope="col" style={{ paddingLeft: 0 }}>Tell me about</th>
                {COLUMNS.map((c) => <th key={c.channel} scope="col" style={{ textAlign: "center", width: 64, padding: "10px 4px" }}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {NOTIFICATION_TOPICS.filter((t) => (t.key !== "chat" || chatOn(session)) && (t.key !== "hosting" || railwayWarnings(session))).map((t) => (
                <tr key={t.key}>
                  <th scope="row" style={{ fontWeight: 600, fontSize: 14, color: "var(--ink)", whiteSpace: "normal", padding: "10px 8px 10px 0" }}>
                    {t.label}
                    <span className="muted small" style={{ display: "block", fontWeight: 400 }}>{t.hint}</span>
                  </th>
                  {COLUMNS.map((c) => (
                    <td key={c.channel} style={{ textAlign: "center", padding: "10px 4px" }}>
                      <input
                        type="checkbox"
                        style={{ width: 20, height: 20 }}
                        aria-label={`${t.label} by ${c.label.toLowerCase()}`}
                        checked={(prefs.data ?? DEFAULT_NOTIFICATION_PREFS)[c.channel].includes(t.key)}
                        disabled={!available(c.channel)}
                        onChange={(e) => toggle(c.channel, t.key, e.target.checked)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!session.config.features.sms ? (
        <span className="muted small">Texts need texting turned on for the company.</span>
      ) : !phone ? (
        <span className="muted small">Add your mobile phone above to get texts.</span>
      ) : null}
      {!session.config.features.email && <span className="muted small">Email needs the company's email connected (Settings → Email).</span>}
      <FormError error={save.error} />
    </div>
    </>
  );
}

function PushRow({ state, busy, testing, onToggle, onTest }: { state: Awaited<ReturnType<typeof pushState>> | undefined; busy: boolean; testing: boolean; onToggle: (on: boolean) => void; onTest: () => void }) {
  if (!state) return <Skeleton height={38} radius={8} />;
  if (state === "needs-install") {
    return (
      <div className="callout callout-info">
        <Icon name="phone" size={18} />
        <div className="grow small" style={{ fontWeight: 400 }}>
          <div style={{ fontWeight: 700 }}>Get notifications on this iPhone</div>
          Tap the Share button, choose <strong>Add to Home Screen</strong>, then open Crewtavo from your Home Screen and turn notifications on here.
        </div>
      </div>
    );
  }
  if (state === "unsupported") return <span className="muted small">This browser can't show notifications. Email and text still work.</span>;
  if (state === "blocked") {
    return (
      <div className="callout callout-warning">
        <Icon name="bell" size={18} />
        <div className="grow small" style={{ fontWeight: 400 }}>Notifications are blocked for Crewtavo in this browser. Allow them in the browser's site settings, then come back here.</div>
      </div>
    );
  }
  return (
    <div className="row wrap" style={{ gap: 8 }}>
      {state === "on" ? (
        <>
          <span className="chip chip-green"><Icon name="check" size={12} />On for this phone</span>
          <Button size="sm" icon="send" loading={testing} onClick={onTest}>Send a test</Button>
          <Button size="sm" variant="ghost" loading={busy} onClick={() => onToggle(false)}>Turn off</Button>
        </>
      ) : (
        <Button variant="primary" icon="bell" loading={busy} onClick={() => onToggle(true)}>Turn on notifications for this phone</Button>
      )}
    </div>
  );
}
