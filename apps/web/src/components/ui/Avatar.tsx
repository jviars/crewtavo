/**
 * People's faces: their photo (Settings → Profile, or People and Roles for an admin), or their
 * initials. Photos are in the private files bucket, so each one needs a signed link; the links for
 * all the faces a screen shows at once come in one request.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { signedUrls } from "@/lib/files";

export function initials(name: string | null | undefined) {
  return (name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

/** Links last a day. A face asks for a new one after half that, well before its link stops working. */
const LINK_SECONDS = 24 * 3600;
const FRESH_MS = 12 * 3600_000;

type Waiting = { resolve: (url: string | null) => void; reject: (error: unknown) => void };
let waiting: Map<string, Waiting[]> | null = null;

/** A signed link to a photo, asked for along with every other photo wanted at the same moment. */
function photoLink(path: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (!waiting) {
      waiting = new Map();
      setTimeout(signWaiting, 0);
    }
    waiting.set(path, [...(waiting.get(path) ?? []), { resolve, reject }]);
  });
}

async function signWaiting() {
  const batch = waiting!;
  waiting = null;
  try {
    const urls = await signedUrls([...batch.keys()], LINK_SECONDS);
    for (const [path, list] of batch) for (const w of list) w.resolve(urls[path] ?? null);
  } catch (error) {
    for (const list of batch.values()) for (const w of list) w.reject(error);
  }
}

/** A link to show the photo at `path` (profiles.avatar_url), or null while there's none. */
export function usePhotoUrl(path: string | null | undefined): string | null {
  const { data } = useQuery({
    queryKey: ["photo", path],
    enabled: Boolean(path),
    queryFn: () => photoLink(path!),
    staleTime: FRESH_MS,
    gcTime: FRESH_MS,
    meta: { silent: true },
  });
  return (path && data) || null;
}

/** What goes inside an avatar circle: the person's photo, or their initials until it loads (or if it can't). */
export function Face({ name, photo }: { name: string | null | undefined; photo?: string | null }) {
  const url = usePhotoUrl(photo);
  const [broken, setBroken] = useState<string | null>(null);
  if (!url || broken === url) return <>{initials(name)}</>;
  return <img className="avatar-photo" src={url} alt="" draggable={false} onError={() => setBroken(url)} />;
}
