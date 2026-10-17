import { toast } from "./toast";

/** Copy text and confirm with a toast; falls back to a prompt where the clipboard is blocked. */
export async function copyText(text: string, label = "Copied to clipboard") {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(label);
  } catch {
    window.prompt("Copy this:", text);
  }
}
