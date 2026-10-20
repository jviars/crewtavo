import { Navigate, useLocation, type RouteObject } from "react-router-dom";
import { AppShell } from "@/components/shell/AppShell";
import { RouteError } from "@/components/shell/RouteError";
import { OAuthConsentPage } from "@/features/auth/OAuthConsentPage";
import { HomePage } from "@/features/home/HomePage";
import { NotFound } from "@/features/placeholder/ScreenPlaceholder";
import { SessionProvider } from "@/lib/session";

type Loader = () => Promise<Record<string, unknown>>;

/** Screens download when first opened; after sign-in they're fetched in the background (prefetchScreens). */
const screens = {
  schedule: () => import("@/features/schedule/SchedulePage"),
  settings: () => import("@/features/settings/SettingsPage"),
  booking: () => import("@/features/booking/BookingAdminPage"),
  pipeline: () => import("@/features/pipeline/PipelinePage"),
  messages: () => import("@/features/messages/MessagesPage"),
  chat: () => import("@/features/chat/ChatPage"),
  chatSettings: () => import("@/features/chat/ChatSettingsPage"),
  timesheets: () => import("@/features/timesheets/TimesheetsPage"),
  finance: () => import("@/features/finance/FinancePage"),
  metrics: () => import("@/features/metrics/MetricsPage"),
  field: () => import("@/features/field/FieldTodayPage"),
  fieldVisit: () => import("@/features/field/FieldVisitPage"),
  kb: () => import("@/features/kb/KnowledgeBasePage"),
  sop: () => import("@/features/kb/SopPage"),
  sopEditor: () => import("@/features/kb/SopEditorPage"),
  apps: () => import("@/features/apps/AppsPage"),
  app: () => import("@/features/apps/AppDetailPage"),
  clients: () => import("@/features/clients/ClientsPage"),
  client: () => import("@/features/clients/ClientPage"),
  requests: () => import("@/features/requests/RequestsPage"),
  request: () => import("@/features/requests/RequestPage"),
  quotes: () => import("@/features/quotes/QuotesPage"),
  quote: () => import("@/features/quotes/QuotePage"),
  jobs: () => import("@/features/jobs/JobsPage"),
  job: () => import("@/features/jobs/JobPage"),
  invoices: () => import("@/features/invoices/InvoicesPage"),
  invoice: () => import("@/features/invoices/InvoicePage"),
  payouts: () => import("@/features/invoices/PayoutsPage"),
  marketing: () => import("@/features/marketing/MarketingPage"),
  campaign: () => import("@/features/marketing/CampaignPage"),
  automations: () => import("@/features/automations/AutomationsPage"),
  rule: () => import("@/features/automations/RulePage"),
  equipment: () => import("@/features/equipment/EquipmentPage"),
  equipmentItem: () => import("@/features/equipment/EquipmentDetailPage"),
} satisfies Record<string, Loader>;

/** The measuring tool pulls in map libraries, so it's only fetched when opened. */
const measure = () => import("@/features/measure/MeasurePage");

/** An address that moved: keeps the query string (tab, date range) so old links and bookmarks still land. */
function Moved({ to }: { to: string }) {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: to, search, hash }} replace />;
}

const page = (load: Loader, name: string): Pick<RouteObject, "lazy"> => ({
  lazy: async () => ({ Component: (await load())[name] as React.ComponentType }),
});

let prefetched = false;
/** Warm the browser cache with every screen so navigation is instant. */
export function prefetchScreens() {
  if (prefetched) return;
  prefetched = true;
  const run = () => Object.values(screens).forEach((load, i) => setTimeout(() => load().catch(() => undefined), i * 60));
  if ("requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 4000 });
  else setTimeout(run, 1500);
}

export const routes: RouteObject[] = [
  {
    // Staff screens: sign-in, then onboarding if the user has no company yet.
    element: (
      <SessionProvider>
        <AppShell />
      </SessionProvider>
    ),
    errorElement: <RouteError fullPage />,
    children: [
      {
        // Errors inside a screen keep the navigation around them.
        errorElement: <RouteError />,
        children: [
          { index: true, element: <HomePage /> },
          { path: "schedule", ...page(screens.schedule, "SchedulePage") },
          { path: "settings", ...page(screens.settings, "SettingsPage") },
          { path: "booking", ...page(screens.booking, "BookingAdminPage") },
          { path: "pipeline", ...page(screens.pipeline, "PipelinePage") },
          { path: "messages", ...page(screens.messages, "MessagesPage") },
          { path: "chat", ...page(screens.chat, "ChatPage") },
          { path: "chat/settings", ...page(screens.chatSettings, "ChatSettingsPage") },
          { path: "chat/:channelId", ...page(screens.chat, "ChatPage") },
          { path: "timesheets", ...page(screens.timesheets, "TimesheetsPage") },
          { path: "finance", ...page(screens.finance, "FinancePage") },
          { path: "metrics", ...page(screens.metrics, "MetricsPage") },
          // Reports became Finance and Metrics; Finance sends the tabs that moved on to Metrics.
          { path: "reports", element: <Moved to="/finance" /> },
          { path: "field", ...page(screens.field, "FieldTodayPage") },
          { path: "field/visits/:id", ...page(screens.fieldVisit, "FieldVisitPage") },
          { path: "measure", ...page(measure, "MeasurePage") },
          { path: "kb", ...page(screens.kb, "KnowledgeBasePage") },
          { path: "kb/new", ...page(screens.sopEditor, "SopEditorPage") },
          { path: "kb/:pageId", ...page(screens.sop, "SopPage") },
          { path: "kb/:pageId/edit", ...page(screens.sopEditor, "SopEditorPage") },
          { path: "apps", ...page(screens.apps, "AppsPage") },
          { path: "apps/:id", ...page(screens.app, "AppDetailPage") },
          { path: "clients", ...page(screens.clients, "ClientsPage") },
          { path: "clients/:id", ...page(screens.client, "ClientPage") },
          { path: "requests", ...page(screens.requests, "RequestsPage") },
          { path: "requests/:id", ...page(screens.request, "RequestPage") },
          { path: "quotes", ...page(screens.quotes, "QuotesPage") },
          { path: "quotes/:id", ...page(screens.quote, "QuotePage") },
          { path: "jobs", ...page(screens.jobs, "JobsPage") },
          { path: "jobs/:id", ...page(screens.job, "JobPage") },
          { path: "invoices", ...page(screens.invoices, "InvoicesPage") },
          { path: "invoices/:id", ...page(screens.invoice, "InvoicePage") },
          { path: "payouts", ...page(screens.payouts, "PayoutsPage") },
          { path: "marketing", ...page(screens.marketing, "MarketingPage") },
          { path: "marketing/campaigns/:id", ...page(screens.campaign, "CampaignPage") },
          { path: "automations", ...page(screens.automations, "AutomationsPage") },
          { path: "automations/:id", ...page(screens.rule, "RulePage") },
          { path: "equipment", ...page(screens.equipment, "EquipmentPage") },
          { path: "equipment/:id", ...page(screens.equipmentItem, "EquipmentDetailPage") },
          { path: "*", element: <NotFound /> },
        ],
      },
    ],
  },
  // Claude/ChatGPT connector consent (Supabase OAuth server). Needs sign-in but not a company.
  {
    path: "oauth/consent",
    errorElement: <RouteError fullPage />,
    element: (
      <SessionProvider requireCompany={false}>
        <OAuthConsentPage />
      </SessionProvider>
    ),
  },
  // Client-facing pages work without an account.
  { path: "hub/:token", errorElement: <RouteError fullPage />, ...page(() => import("@/features/hub/HubPage"), "HubPage") },
  { path: "book/:company/:form", errorElement: <RouteError fullPage />, ...page(() => import("@/features/booking/BookingFormPage"), "BookingFormPage") },
  { path: "u/:token", errorElement: <RouteError fullPage />, ...page(() => import("@/features/public/UnsubscribePage"), "UnsubscribePage") },
  { path: "refer/:token", errorElement: <RouteError fullPage />, ...page(() => import("@/features/public/ReferralPage"), "ReferralPage") },
  { path: "license", errorElement: <RouteError fullPage />, ...page(() => import("@/features/public/LicensePage"), "LicensePage") },
];
