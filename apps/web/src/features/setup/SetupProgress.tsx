/**
 * Setting Crewtavo up, as one count from its first screen to its last: the bars and "Step 3 of 5"
 * across each screen's top, and the owner's "What happens next" list, from the same steps. A new
 * instance (one business) starts with its owner's account and key file; on Railway it ends with
 * connecting Railway and, if they like, a web address (features/setup/RailwaySetupPage.tsx).
 */
import { useQuery } from "@tanstack/react-query";
import styles from "@/features/auth/auth.module.css";
import { loadConfig, type AppConfig } from "@/lib/api";

export type SetupStep = "owner" | "keys" | "name" | "trade" | "terms" | "railway" | "address";

export const SETUP_STEPS: Record<SetupStep, { title: string; text: string }> = {
  owner: { title: "Your owner account", text: "You can do everything, and invite others." },
  keys: { title: "Save a key file", text: "Gets you back in if you lose your password." },
  name: { title: "Name your business", text: "It goes on your quotes, invoices and client page." },
  trade: { title: "Pick your trade", text: "Services, checklists and forms to start from." },
  terms: { title: "Agree to the terms", text: "The short version, the full terms a click away." },
  railway: { title: "Connect Railway", text: "So Crewtavo shows what it costs and warns you in time." },
  address: { title: "Your web address", text: "If you'd like one now. It can wait." },
};

/** This deployment's steps, in order. */
export function setupSteps(config: Pick<AppConfig, "singleCompany" | "platform"> | undefined): SetupStep[] {
  return [
    ...(config?.singleCompany ? (["owner", "keys"] as const) : []),
    "name", "trade", "terms",
    ...(config?.platform === "railway" ? (["railway", "address"] as const) : []),
  ];
}

export function useSetupSteps(): SetupStep[] {
  const config = useQuery({ queryKey: ["config"], queryFn: loadConfig, staleTime: Infinity, meta: { silent: true } });
  return setupSteps(config.data);
}

/** The bars and "Step 3 of 5" for the screen `at`. */
export function SetupProgress({ at }: { at: SetupStep }) {
  const steps = useSetupSteps();
  const n = steps.indexOf(at) + 1;
  return (
    <span className={styles.prog}>
      {steps.map((s, i) => <i key={s} data-on={i < n || undefined} aria-hidden="true" />)}
      <span>Step {n} of {steps.length}</span>
    </span>
  );
}
