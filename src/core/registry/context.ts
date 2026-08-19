import type { CasStore } from "../types/store.ts";

/** Everything a registry operation needs: the bucket, plus an injectable clock. */
export interface RegistryContext {
  store: CasStore;
  /** Defaults to `new Date()`; override for deterministic tests. */
  now?: () => Date;
}

/** Current time as seen by `ctx`. */
export function nowDate(ctx: RegistryContext): Date {
  return ctx.now?.() ?? new Date();
}

/** Current time as the ISO-8601 string every record stores. */
export function nowIso(ctx: RegistryContext): string {
  return nowDate(ctx).toISOString();
}
