/**
 * Settings → AI assistants, for everyone: the one place to add Crewtavo to Claude or ChatGPT (the
 * connector link and the steps for each), the assistants you've connected and what each can change,
 * and, for owners and admins, the company's own limits and what assistants did
 * (features/apps/AssistantAccess.tsx). The Claude and ChatGPT pages under Apps point here.
 *
 * Also here, because it's each person's own: using your ChatGPT plan for Crewtavo's own AI
 * (features/apps/ChatGptPlan.tsx).
 */
import { Button } from "@/components/ui/Button";
import { Section } from "@/components/ui/Section";
import { copyText } from "@/lib/clipboard";
import { hasRole, useSession } from "@/lib/session";
import { AssistantAccess, ConnectedAssistants, TeamAssistants } from "@/features/apps/AssistantAccess";
import { ChatGptPlanCard } from "@/features/apps/ChatGptPlan";
import { CONNECTOR_STEPS } from "@/features/apps/assistantConnections";
import styles from "./settings.module.css";

export function AssistantSettings() {
  const session = useSession();
  const mcpUrl = `${window.location.origin}/mcp`;
  return (
    <>
      <Section level={3} title="Connect Claude or ChatGPT">
        <div className="set-stack">
          <p className="set-note">
            Ask about your clients and schedule, or have it set up your price list, crews, checklists, booking forms, guides and automations for you. It signs in as you, so it never sees more than you can.
          </p>
          <div className={styles.connector}>
            <code className="code-pill">{mcpUrl}</code>
            <Button icon="copy" onClick={() => copyText(mcpUrl, "Connector link copied")}>Copy</Button>
          </div>
          <details className={styles.howTo}>
            <summary>How to add it</summary>
            <div className="set-stack">
              <strong className="small">Claude</strong>
              <ol className="app-steps">{CONNECTOR_STEPS.anthropic.map((s) => <li key={s}>{s}</li>)}</ol>
              <strong className="small">ChatGPT</strong>
              <ol className="app-steps">{CONNECTOR_STEPS.chatgpt.map((s) => <li key={s}>{s}</li>)}</ol>
            </div>
          </details>
        </div>
      </Section>
      <ConnectedAssistants />
      {/* Not an assistant that uses Crewtavo, but Crewtavo's own AI on this person's ChatGPT plan: shown to whoever may connect one. */}
      {session.role !== "subcontractor" && <ChatGptPlanCard where="settings" />}
      {hasRole(session, "admin") && (
        <Section level={3} title={`For everyone at ${session.company.name}`}>
          <AssistantAccess />
        </Section>
      )}
      {session.role === "owner" && <TeamAssistants />}
    </>
  );
}
