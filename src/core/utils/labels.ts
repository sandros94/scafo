/*
 * Labels: the `key=value` pairs an operator sets on a node, and that an
 * environment's selector is written in.
 *
 * One charset and one parser for both ends, because a label an operator can set
 * but never select for — or select for but never set — is a fleet that silently
 * places nothing.
 */

import { ScafoError } from "../error.ts";

/**
 * Lowercase alphanumerics, dots, dashes and underscores, beginning and ending on
 * an alphanumeric.
 *
 * Wider than a slug and narrower than free text. Wider, because the words a
 * fleet is actually described in carry separators a slug refuses — `eu-west-1`,
 * `node.kind`, `gpu_a100`. Narrower than free text, because a label is compared
 * for exact equality by machines on both sides of a bucket: whitespace, case and
 * unicode confusables in it would make two labels that look identical fail to
 * match, with nothing anywhere to explain why.
 */
export const LABEL_RE: RegExp = /^[a-z\d](?:[a-z\d._-]*[a-z\d])?$/;

/** Longest a single label key or value may be, matching the DNS label limit. */
export const LABEL_MAX_LENGTH: number = 63;

export function isLabel(s: string): boolean {
  return s.length > 0 && s.length <= LABEL_MAX_LENGTH && LABEL_RE.test(s);
}

/**
 * Throws `ScafoError("invalid-input")` naming `what` unless `s` is a label.
 *
 * `what` is how the value is described back to whoever typed it — "label key",
 * "label value" — so a refusal says which half of a pair was the problem.
 */
export function assertLabel(s: unknown, what: string = "label"): void {
  if (typeof s === "string" && isLabel(s)) return;

  throw new ScafoError("invalid-input", "Invalid label", {
    detail:
      `${describe(s)} is not a usable ${what}: 1-${LABEL_MAX_LENGTH} lowercase alphanumeric ` +
      `characters, dots, dashes and underscores, beginning and ending on a letter or a digit`,
  });
}

/**
 * Throws `ScafoError("invalid-input")` unless `value` is an object whose every
 * key and value is a label. `field` names the setting in the refusal.
 *
 * An empty object passes: whether "no labels at all" is meaningful is the
 * caller's question, and the two callers answer it differently — a node with no
 * labels is ordinary, while a selector with no entries constrains nothing and is
 * refused where it is set.
 */
export function assertLabels(
  value: unknown,
  field: string,
): asserts value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ScafoError("invalid-input", "Invalid labels", {
      detail: `${field} must be an object of label keys and values, such as {"tier": "fast"}`,
    });
  }

  for (const [key, entry] of Object.entries(value)) {
    assertLabel(key, `${field} label key`);
    assertLabel(entry, `${field} value for "${key}"`);
  }
}

/**
 * Reads labels written as text — a command-line flag, an environment variable —
 * into the record the registry stores: `"k=v,k2=v2"`.
 *
 * Blank entries are skipped, so a trailing comma is a typo that costs nothing.
 * A DUPLICATE KEY is refused rather than resolved: both "the first wins" and
 * "the last wins" are defensible, which is exactly why neither should be guessed
 * at on the operator's behalf. Anything unusable is `ScafoError("invalid-input")`
 * naming `field`, so a typo never becomes a placement decision.
 */
export function parseLabels(text: string, field: string): Record<string, string> {
  const labels: Record<string, string> = {};

  for (const entry of text.split(",")) {
    const pair = entry.trim();
    if (pair === "") continue;

    const at = pair.indexOf("=");
    if (at < 1) {
      throw new ScafoError("invalid-input", "Invalid labels", {
        detail: `${field} entry "${pair}" must be written as "key=value"`,
      });
    }

    const key = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    assertLabel(key, `${field} label key`);
    assertLabel(value, `${field} value for "${key}"`);

    if (key in labels) {
      throw new ScafoError("invalid-input", "Invalid labels", {
        detail: `${field} names "${key}" twice, as "${labels[key]}" and as "${value}"`,
      });
    }
    labels[key] = value;
  }

  if (Object.keys(labels).length === 0) {
    throw new ScafoError("invalid-input", "Invalid labels", {
      detail: `${field} carries no label at all; write it as "key=value" or leave it unset`,
    });
  }
  return labels;
}

/**
 * Labels as one line of text, keys sorted, in the same `k=v,k2=v2` spelling
 * {@link parseLabels} reads. What a refusal or a terminal names them with, so an
 * operator can copy what they are shown straight back into a flag.
 */
export function formatLabels(labels: Record<string, string>): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join(",");
}

function describe(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : String(value);
}
