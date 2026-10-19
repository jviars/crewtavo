/**
 * What an MCP tool is (mcp.ts serves them). Each runs as the person who connected the assistant,
 * through the Data API under row-level security, so it can't see or do more than they can. A tool
 * that changes something names its area; the person chooses which areas the assistant may change,
 * and deleting needs full access (packages/core/src/assistants.ts).
 */
import type { AssistantArea } from "@crewtavo/core";
import { z } from "zod";
import type { Env } from "../env";
import { ASSISTANT_READ_ONLY } from "../lib/assistants";
import type { Db } from "../lib/supabase";

export interface ToolContext {
  db: Db;
  env: Env;
  userId: string;
  companyId: string;
  timezone: string;
  /** Where this Crewtavo is, for links people share (booking forms). */
  origin: string;
  assistants: { enabled: boolean; read_only: boolean };
}

export interface Tool<S extends z.ZodType> {
  description: string;
  input: S;
  /** The area it changes. Tools without one only read. */
  area?: AssistantArea;
  /** It deletes something: only an assistant with full access may. */
  destructive?: boolean;
  run: (ctx: ToolContext, args: z.infer<S>) => Promise<unknown>;
}
export const tool = <S extends z.ZodType>(t: Tool<S>) => t;
export type AnyTool = Tool<z.ZodType>;

/** Database errors, worded for a person (no table or policy names). */
export function friendly(message: string) {
  if (/row-level security|permission denied|violates.*policy/i.test(message)) return "You don't have permission to do that in Crewtavo.";
  if (/violates foreign key|not present in table/i.test(message)) return "That record doesn't exist (or you can't see it).";
  if (/duplicate key/i.test(message)) return "There's already one with that name or link.";
  if (/invalid input syntax|violates check constraint/i.test(message)) return "One of the values isn't valid.";
  if (/read-only transaction/i.test(message)) return ASSISTANT_READ_ONLY;
  return message.length > 160 || /relation|column|function|syntax/i.test(message) ? "That didn't work. Try again." : message;
}

type Result<T> = PromiseLike<{ data: T | null; error: { message: string } | null }>;

export async function rows<T = Record<string, unknown>>(query: Result<T[]>) {
  const { data, error } = await query;
  if (error) throw new Error(friendly(error.message));
  return data ?? [];
}

/** One row back from an insert, update or lookup; `what` names it when there's none. */
export async function one<T>(query: PromiseLike<{ data: T; error: { message: string } | null }>, what: string): Promise<NonNullable<T>> {
  const { data, error } = await query;
  if (error) throw new Error(friendly(error.message));
  if (!data) throw new Error(`${what} not found (or you can't see it).`);
  return data as NonNullable<T>;
}

/** Ids of the rows a change reached; none means it wasn't there to change. */
export async function changed(query: Result<Array<{ id: string }>>, what: string) {
  const found = await rows(query);
  if (!found.length) throw new Error(`${what} not found (or you can't change it).`);
  return found;
}

export const companyArg = { company_id: z.uuid().optional().describe("Only needed if you belong to more than one company.") };
