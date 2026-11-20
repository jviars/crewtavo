/** Requests from no-account pages (Client Hub, booking forms, unsubscribe, referrals). */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ApiError, loadConfig } from "./api";
import { OFFLINE } from "./errors";

export async function publicFetch<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new ApiError(OFFLINE, 0);
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(json.error ?? "Something went wrong. Try again.", res.status);
  return json as T;
}

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: { sitekey: string; callback: (token: string) => void; "expired-callback"?: () => void; language?: string }) => string | undefined;
      reset: (widget?: string) => void;
    };
  }
}

/**
 * Cloudflare Turnstile, only when the deployment configures it. Returns the widget ref and the token.
 * `language` is the box's own ("es"); left out, Cloudflare goes by the browser's.
 */
export function useTurnstile(ready: boolean, language?: string) {
  const config = useQuery({ queryKey: ["config"], queryFn: loadConfig, staleTime: Infinity });
  const siteKey = config.data?.turnstileSiteKey;
  const ref = useRef<HTMLDivElement>(null);
  const widget = useRef<string | undefined>(undefined);
  const [token, setToken] = useState("");
  useEffect(() => {
    if (!siteKey || !ready || !ref.current) return;
    const render = () => {
      widget.current = window.turnstile?.render(ref.current!, { sitekey: siteKey, callback: setToken, "expired-callback": () => setToken(""), ...(language ? { language } : {}) });
    };
    if (window.turnstile) return render();
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    script.async = true;
    script.onload = render;
    document.head.appendChild(script);
  }, [siteKey, ready]);
  /** A check's answer is good once: after using it, ask for a new one. */
  const reset = () => {
    setToken("");
    if (widget.current !== undefined) window.turnstile?.reset(widget.current);
  };
  return { ref, token, required: Boolean(siteKey), reset };
}
