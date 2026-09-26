/* Internal: JSONC text an operator wrote, read as a plain document. */

import { type JSONCParseError, parseJSONC } from "confbox";
import { safeJsonParse } from "unsecure/sanitize";

/** What a JSONC document parsed to, or the first syntax error it has. */
export type JsoncDocument = { value: unknown } | { error: JSONCParseError };

/**
 * Parses JSONC into a value with no key an object answers for on its own.
 *
 * The parser assigns a `__proto__` member as a prototype instead of storing it
 * as a key, so a document can make an object answer for a setting it never
 * wrote and no validator can see. Re-serializing keeps own enumerable members
 * only, and the parse that follows strips the reserved names at every depth, so
 * the document holds exactly what its author spelled out.
 */
export function parseJsoncDocument(text: string): JsoncDocument {
  const errors: JSONCParseError[] = [];
  const parsed: unknown = parseJSONC(text, { errors, allowTrailingComma: true });
  const error = errors[0];
  if (error !== undefined) return { error };
  if (parsed === undefined) return { value: undefined };
  return { value: safeJsonParse<unknown>(JSON.stringify(parsed)) };
}
