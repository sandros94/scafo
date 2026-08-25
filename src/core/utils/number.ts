import { ScafoError } from "../error.ts";

/** Refuses a value that cannot be used as a finite, enabled resource bound. */
export function assertPositiveSafeInteger(value: unknown, name: string): asserts value is number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return;
  throw new ScafoError("invalid-input", `Invalid ${name}`, {
    detail: `"${name}" must be a positive safe integer, got ${describe(value)}`,
  });
}

function describe(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Object.is(value, -0) ? "-0" : `${value}`;
    case "bigint":
      return `${value}n`;
    case "boolean":
      return value ? "true" : "false";
    case "undefined":
      return "undefined";
    case "symbol":
      return String(value);
    case "function":
      return "<function>";
    case "object":
      return "<object>";
    default:
      return "<unknown>";
  }
}
