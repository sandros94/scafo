/*
 * Reading a host back into what it names — the exact inverse of the labels
 * `renderRoutes` writes, and the one place that inversion lives.
 *
 * PURE AND REGISTRY-FREE, which is what makes it shareable. It tells the project
 * from the ref beside it and stops there: whether that ref is an environment or
 * a build is a question only the bucket answers. Ingress counters take the label
 * as written, because a log line is counted rather than served.
 */

import { parseHostLabel } from "../utils/slug.ts";

/** What a host under a platform domain names, before anything is looked up. */
export interface PlatformHost {
  project: string;
  /**
   * The half after `--`, when the label carries one: an environment name or a
   * build id, indistinguishable here. Absent for an apex host, which names the
   * project's `APEX_ENVIRONMENT` and nothing else.
   */
  ref?: string;
}

/**
 * The label a host carries under one of these platform domains, or null when it
 * is under none of them.
 *
 * The apex domain itself is not one: nothing is ever rendered at it, and a
 * request for it is not asking for a project. A custom domain is not one either
 * — resolving those needs the records that claimed them.
 */
export function platformLabel(host: string, platformDomains: string[]): string | null {
  for (const domain of platformDomains) {
    const suffix = `.${domain}`;
    if (host.endsWith(suffix)) return host.slice(0, -suffix.length);
  }
  return null;
}

/**
 * What a host under one of these platform domains names, or null when it is
 * under none of them or carries a label scafo could never have rendered.
 */
export function parsePlatformHost(host: string, platformDomains: string[]): PlatformHost | null {
  const label = platformLabel(host, platformDomains);
  return label === null ? null : parseHostLabel(label);
}
