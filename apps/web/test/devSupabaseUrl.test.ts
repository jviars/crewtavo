/**
 * A phone opening the dev server by its network address (Tailscale, Wi-Fi) signs in through the same
 * computer's Supabase, not a loopback address that would mean the phone itself (lib/api.ts).
 */
import { describe, expect, it } from "vitest";
import { reachableSupabaseUrl } from "../src/lib/api";

describe("reachableSupabaseUrl", () => {
  it("points a loopback Supabase at the address the page was opened on", () => {
    expect(reachableSupabaseUrl("http://127.0.0.1:56321", "100.64.0.5")).toBe("http://100.64.0.5:56321");
    expect(reachableSupabaseUrl("http://localhost:54321", "192.168.1.20")).toBe("http://192.168.1.20:54321");
  });

  it("leaves it alone on the computer itself and for a real address", () => {
    expect(reachableSupabaseUrl("http://127.0.0.1:56321", "localhost")).toBe("http://127.0.0.1:56321");
    expect(reachableSupabaseUrl("https://abc.supabase.co", "100.64.0.5")).toBe("https://abc.supabase.co");
    expect(reachableSupabaseUrl("https://acme.crewtavo.app", "acme.crewtavo.app")).toBe("https://acme.crewtavo.app");
  });
});
