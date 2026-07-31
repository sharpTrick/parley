/**
 * What a tool ADVERTISES, derived from the allowlist rather than restated per tool, and the JSON
 * text result every handler answers with. An agent discovers the allowlist from the tool list here —
 * no extra call — so names and patterns are JSON.stringified to stay quote/backslash-safe.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Allowlist } from '../allowlist.js';

/** The configured (explicit) topics as a comma-joined list. */
export function topicList(allow: Allowlist): string {
  return allow.topics().map((t) => JSON.stringify(t)).join(', ');
}

/** Human-readable summary of what topics a tool may target. */
export function describeAllowed(allow: Allowlist): string {
  const topics = allow.topics();
  let s = topics.length > 0 ? ` Configured topics: ${topicList(allow)}.` : '';
  const pats = allow.patterns();
  if (pats.length > 0) {
    s += ` Also allowed (post/fetch only): any topic fully matching regex ${pats
      .map((p) => JSON.stringify(p))
      .join(', ')} — except the reserved presence topic, which is refused even when a pattern covers it.`;
  }
  return s;
}

/**
 * A Zod schema for a `topic` field. When the allowlist is closed (no post pattern widens it) the
 * schema is a `z.enum` so the SDK advertises the allowed topics as a JSON-Schema `enum`; when a
 * pattern widens the set — or the closed set is empty — it falls back to `z.string()` (an empty
 * `z.enum([])` is illegal). Runtime membership is still enforced by `allow.assert` in the handler.
 */
export function topicSchema(allow: Allowlist, description: string): z.ZodType<string> {
  const en: string[] = allow.patterns().length === 0 ? [...allow.topics()] : [];
  const base = en.length > 0 ? z.enum(en as [string, ...string[]]) : z.string();
  return base.describe(description);
}

/** Alias the SDK's result type so handlers align with the CallTool result exactly. */
export type ToolResult = CallToolResult;

export const textResult = (obj: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
});
