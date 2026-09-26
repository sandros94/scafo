/* What the fleet's own API is kept off, and how a platform host is spelled. */

import { isScafoError } from "../error.ts";
import { assertSlug } from "../utils/slug.ts";

/** API paths denied at platform apexes: TLS storage, and the fleet's routing in
    every format, which all live under the one prefix — both name where every
    process listens. Drivers match path-segment boundaries. */
export const API_DENIED_PREFIXES: string[] = ["/v1/storage", "/v1/ingress/routes"];

/** Builds a platform host, skipping names too long for DNS rather than failing all routes. */
export function hostUnder(domain: string, application: string): string | null {
  try {
    assertSlug(application);
    return `${application}.${domain}`;
  } catch (error) {
    if (isScafoError(error) && error.code === "invalid-slug") return null;
    throw error;
  }
}
