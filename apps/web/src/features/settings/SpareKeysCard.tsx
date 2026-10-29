/** Settings → Profile, for the owner: how many uses their key file has left, and getting a new one. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { SpareKeysSheet } from "@/features/auth/SpareKeys";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";

const TOTAL = 8;

export function SpareKeysCard() {
  const session = useSession();
  const [making, setMaking] = useState(false);
  const status = useQuery({ queryKey: ["spare-keys"], queryFn: () => api.get<{ left: number; active: boolean }>("/account/spare-keys"), enabled: session.role === "owner", meta: { silent: true } });
  if (session.role !== "owner") return null;
  const left = status.data?.left;
  return (
    <div className="card card-pad stack-sm">
      <strong>Key file</strong>
      <span className="muted small">If you forget your password while Crewtavo can't email you, uploading your key file gets you back in.</span>
      {status.data && (left === 0 ? (
        <div className="callout callout-warning" style={{ padding: "10px 12px" }}>
          <Icon name="alert" size={16} />
          <span className="grow small" style={{ fontWeight: 600 }}>Your key file is used up. Get a new one and save it.</span>
        </div>
      ) : (
        <span>Good for {left} more {left === 1 ? "use" : "uses"} (of {TOTAL})</span>
      ))}
      {status.data && !status.data.active && <span className="muted small">Your email is set up, so Forgot password sends you a link. The key file only works while it isn't.</span>}
      <Button icon="lock" onClick={() => setMaking(true)} style={{ justifySelf: "start" }}>Get a new key file</Button>
      {making && <MakeSpareKeys onClose={() => setMaking(false)} />}
    </div>
  );
}

function MakeSpareKeys({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const make = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<{ keys: string[] }>("/account/spare-keys", { password }),
    onSuccess: () => {
      setPassword("");
      queryClient.invalidateQueries({ queryKey: ["spare-keys"] });
    },
  });
  return (
    <Dialog open onClose={onClose} title={make.data ? "Save your new key file" : "Get a new key file"}>
      <div className="dialog-body">
        {make.data ? (
          <SpareKeysSheet keys={make.data.keys} email={session.profile.email ?? ""} doneLabel="Done" onDone={onClose} />
        ) : (
          <form className="stack-sm" onSubmit={(e: FormEvent) => { e.preventDefault(); make.mutate(); }}>
            <p style={{ margin: 0 }}>Your old key file (and any printed keys) stop working as soon as you get a new one.</p>
            <Field label="Your password" hint="To make sure it's you.">
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required autoFocus />
            </Field>
            <FormError error={make.error} />
            <div className="form-actions">
              <Button onClick={onClose}>Cancel</Button>
              <Button type="submit" variant="primary" icon="lock" loading={make.isPending}>Get new key file</Button>
            </div>
          </form>
        )}
      </div>
    </Dialog>
  );
}
