/* Internal: JSONC text an operator wrote, read as a plain document. */

import { parseJSONC } from "confbox";
import { safeJsonParse } from "unsecure/sanitize";

/** Where a JSONC document stops being valid, when the parser says. */
export interface JsoncSyntaxError {
  /** 1-based line of the first syntax error. */
  line?: number;
  /** 1-based column of the first syntax error. */
  column?: number;
}

/** What a JSONC document parsed to, or the first syntax error it has. */
export type JsoncDocument = { value: unknown } | { error: JsoncSyntaxError };

/**
 * Parses JSONC into a value with no key an object answers for on its own.
 *
 * The parse keeps `__proto__`, `constructor` and `prototype` as ordinary
 * members, and any later assignment through one of them reaches a prototype.
 * Re-serializing keeps own enumerable members only, and the parse that follows
 * strips the reserved names at every depth, so the document holds exactly what
 * its author spelled out.
 */
export function parseJsoncDocument(text: string): JsoncDocument {
  let parsed: unknown;
  try {
    parsed = parseJSONC(text, { allowTrailingComma: true });
  } catch (error) {
    if (error instanceof SyntaxError) return { error: locate(error) };
    throw error;
  }
  return { value: safeJsonParse<unknown>(JSON.stringify(parsed)) };
}

/** Names a syntax error for a detail: `a syntax error at line 4, column 3`. */
export function describeJsoncError(error: JsoncSyntaxError): string {
  if (error.line === undefined || error.column === undefined) return "a syntax error";
  return `a syntax error at line ${String(error.line)}, column ${String(error.column)}`;
}

/* The engine's message is never carried: for some errors it quotes the text
   around the failure, and a config file holds bucket credentials. Only the
   location is read out of it, and a message without one leaves it unknown.
   Comments are blanked rather than removed before the parse, so the location
   is the one in the text as written. */
function locate(error: SyntaxError): JsoncSyntaxError {
  const at = /\(line (\d+) column (\d+)\)/.exec(error.message);
  if (at === null) return {};
  return { line: Number(at[1]), column: Number(at[2]) };
}
