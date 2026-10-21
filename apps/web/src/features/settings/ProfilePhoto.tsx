/**
 * Adding, changing and removing someone's photo (PUT and DELETE /api/team/:id/photo): your own in
 * Settings → Profile, a teammate's in People and Roles. The picture becomes a 512-pixel square on
 * this device first, so a big phone photo sends quickly.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";
import { base64Of, squarePhoto } from "@/lib/files";
import { useSession } from "@/lib/session";

export function PhotoButtons({ userId, photo }: { userId: string; photo: string | null | undefined }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  // Faces show on many screens (the team, the schedule, timesheets, chat), so they all refresh.
  // Links to other people's photos stay as they are.
  const changed = async () => {
    await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "photo" });
    if (userId === session.userId) await session.refresh();
  };
  const set = useMutation({
    meta: { success: "Photo saved" },
    mutationFn: async (file: File) => {
      const square = await squarePhoto(file);
      if (!square) throw new Error("Crewtavo can't open that picture. Try a JPEG or PNG photo.");
      return api.put<{ avatar_url: string }>(`/team/${userId}/photo`, { photo: await base64Of(square) });
    },
    onSuccess: changed,
  });
  const remove = useMutation({
    meta: { success: "Photo removed" },
    mutationFn: () => api.delete(`/team/${userId}/photo`),
    onSuccess: changed,
  });
  return (
    <div className="row wrap" style={{ gap: 8 }}>
      <Button size="sm" icon="camera" loading={set.isPending} disabled={remove.isPending} onClick={() => input.current?.click()}>
        {photo ? "Change photo" : "Add a photo"}
      </Button>
      {photo && <Button size="sm" variant="ghost" loading={remove.isPending} disabled={set.isPending} onClick={() => remove.mutate()}>Remove photo</Button>}
      <input
        ref={input}
        type="file"
        accept="image/*,.heic,.heif"
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
