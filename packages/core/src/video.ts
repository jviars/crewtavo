/**
 * YouTube and Vimeo links as the video players guides embed. These two players are the only embeds
 * guides allow: the guide editor, the page sanitiser (apps/web/src/lib/html.ts) and markdownToGuide
 * all build the player from videoEmbed, so an embedded video is always our own iframe around a
 * checked video id, whatever was pasted or saved.
 */

export interface VideoEmbed {
  provider: "youtube" | "vimeo";
  /** The player: YouTube's privacy-enhanced one, or Vimeo's with tracking off. */
  src: string;
  title: string;
}

// Core builds without DOM or Node types; every runtime Crewtavo runs in has URL.
interface Params { get(name: string): string | null }
interface Link { protocol: string; hostname: string; pathname: string; hash: string; searchParams: Params }
declare const URL: new (input: string) => Link;
declare const URLSearchParams: new (init: string) => Params;

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"]);
const VIMEO_HOSTS = new Set(["vimeo.com", "www.vimeo.com", "player.vimeo.com"]);
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_PLAYLIST = /^[A-Za-z0-9_-]{2,64}$/;
const VIMEO_ID = /^\d{1,12}$/;
const VIMEO_HASH = /^[0-9a-f]{6,20}$/i;

/** A start time ("90", "90s", "1m30s", "1h2m3s") in seconds; 0 for none. */
function seconds(t: string | null | undefined): number {
  const m = t?.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
}

function parseLink(link: string): Link | null {
  const s = link.trim();
  try {
    const url = new URL(s.startsWith("//") ? `https:${s}` : /^https?:\/\//i.test(s) ? s : `https://${s}`);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function youtube(url: Link): VideoEmbed | null {
  const host = url.hostname.toLowerCase();
  if (host !== "youtu.be" && !YOUTUBE_HOSTS.has(host)) return null;
  const [first, second] = url.pathname.split("/").filter(Boolean);
  const player = (path: string) => ({ provider: "youtube" as const, src: `https://www.youtube-nocookie.com/embed/${path}`, title: "YouTube video" });
  const playlist = url.searchParams.get("list");
  if ((first === "playlist" || (first === "embed" && second === "videoseries")) && playlist && YOUTUBE_PLAYLIST.test(playlist)) return player(`videoseries?list=${playlist}`);
  const id = host === "youtu.be" ? first : first === "watch" ? url.searchParams.get("v") : ["embed", "shorts", "live", "v"].includes(first ?? "") ? second : null;
  if (!id || !YOUTUBE_ID.test(id)) return null;
  const start = seconds(url.searchParams.get("t") ?? url.searchParams.get("start"));
  return player(start ? `${id}?start=${start}` : id);
}

/** Where the video id is in a Vimeo address's path, or -1. */
function vimeoIdAt(parts: string[]): number {
  if (VIMEO_ID.test(parts[0] ?? "")) return 0; // vimeo.com/ID, or vimeo.com/ID/HASH for an unlisted video
  const video = parts.findIndex((p) => p === "video" || p === "videos"); // player.vimeo.com/video/ID, …/showcase/N/video/ID, …/groups/NAME/videos/ID
  if (video >= 0) return video + 1;
  return parts[0] === "channels" ? 2 : -1; // vimeo.com/channels/NAME/ID
}

function vimeo(url: Link): VideoEmbed | null {
  if (!VIMEO_HOSTS.has(url.hostname.toLowerCase())) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const at = vimeoIdAt(parts);
  const id = parts[at];
  if (at < 0 || !id || !VIMEO_ID.test(id)) return null;
  const hash = url.searchParams.get("h") ?? parts[at + 1];
  const start = seconds(new URLSearchParams(url.hash.slice(1)).get("t"));
  return {
    provider: "vimeo",
    src: `https://player.vimeo.com/video/${id}?${hash && VIMEO_HASH.test(hash) ? `h=${hash}&` : ""}dnt=1${start ? `#t=${start}s` : ""}`,
    title: "Vimeo video",
  };
}

/** The player for a YouTube or Vimeo link (with or without https://), or null for anything else. */
export function videoEmbed(link: string): VideoEmbed | null {
  const url = parseLink(link);
  return url && (youtube(url) ?? vimeo(url));
}

/** The video in something pasted: a YouTube or Vimeo link on its own, or the embed code those sites give. */
export function videoFromPaste(text: string): VideoEmbed | null {
  const s = text.trim();
  const embedCode = s.match(/<iframe\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/i);
  if (embedCode) return videoEmbed(embedCode[1].replace(/&amp;/g, "&"));
  return /^\S+$/.test(s) ? videoEmbed(s) : null;
}

/** The attributes every embedded player gets. */
export function videoAttributes(video: VideoEmbed): Record<string, string> {
  return {
    src: video.src,
    title: video.title,
    allow: "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share",
    allowfullscreen: "",
    loading: "lazy",
    referrerpolicy: "strict-origin-when-cross-origin",
  };
}

/** The player as HTML. */
export function videoIframe(video: VideoEmbed): string {
  const attrs = Object.entries(videoAttributes(video)).map(([name, value]) => (value ? `${name}="${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"` : name));
  return `<iframe ${attrs.join(" ")}></iframe>`;
}
