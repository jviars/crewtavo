/** Every tool the MCP server (mcp.ts) offers, by name. */
import { automationTools } from "./automations";
import { bookingTools } from "./booking";
import { checklistTools } from "./checklists";
import { companyTools } from "./company";
import { crewTools } from "./crews";
import { guideTools } from "./guides";
import { priceTools } from "./prices";
import { recordTools } from "./records";
import type { AnyTool } from "./tool";

export const TOOLS: Record<string, AnyTool> = {
  ...recordTools,
  ...companyTools,
  ...priceTools,
  ...crewTools,
  ...checklistTools,
  ...bookingTools,
  ...guideTools,
  ...automationTools,
};

export { friendly, rows, type AnyTool, type ToolContext } from "./tool";
