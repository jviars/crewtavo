/**
 * Adding, changing and removing the business logo (PUT and DELETE /api/company/logo), in Settings →
 * Company. Clients see it on the Client Hub (and so on printed and PDF quotes and invoices) and at
 * the top of emails. The picture becomes a trimmed PNG on this device first, see-through background
 * and all.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { api } from "@/lib/api";
import { base64Of, logoPicture } from "@/lib/files";
import { useSession } from "@/lib/session";

export function CompanyLogo({ path }: { path: string | null }) {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  // Settings → Company saves the settings it loaded, so it reloads them with the new logo, and the
  // session's copy has it too, for the top bar.
  const changed = () => {
    queryClient.invalidateQueries({ queryKey: ["company", company.id] });
    session.refresh();
  };
  // The logo changing in place says it worked.
  const set = useMutation({
    mutationFn: async (file: File) => {
      const png = await logoPicture(file);
      if (!png) throw new Error("Crewtavo can't open that picture. Try a PNG, JPEG or SVG.");
      return api.put<{ logo: string }>("/company/logo", { logo: await base64Of(png) });
    },
    onSuccess: changed,
  });
  const remove = useMutation({
    mutationFn: () => api.delete("/company/logo"),
    onSuccess: changed,
  });
  return (
    <div className="set-logo">
      {/* On white, as clients see it. */}
      {path ? (
        <span className="set-logo-tile">
          <img src={`/api/public/logo/${path.replace("/logo/", "/")}`} alt="Your logo" />
        </span>
      ) : (
        <span className="set-logo-tile" data-empty aria-hidden="true"><Icon name="image" size={18} /></span>
      )}
      <Button size="sm" icon={path ? undefined : "upload"} loading={set.isPending} slowHint={false} disabled={remove.isPending} onClick={() => input.current?.click()}>
        {path ? "Replace" : "Add your logo"}
      </Button>
      {path && <Button size="sm" variant="ghost" loading={remove.isPending} disabled={set.isPending} onClick={() => remove.mutate()} aria-label="Remove logo">Remove</Button>}
      <span className="hint">A PNG or SVG with a see-through background looks best.</span>
      <input
        ref={input}
        type="file"
        accept="image/*,.svg,.heic,.heif"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) set.mutate(file);
        }}
      />
    </div>
  );
}
