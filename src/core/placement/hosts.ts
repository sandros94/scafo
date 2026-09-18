/*
 * Reading a host back into the application it names — the exact inverse of the
 * labels `renderRoutes` writes, and the one place that inversion lives.
 *
 * PURE AND REGISTRY-FREE, which is what makes it shareable. It answers with the
 * name the label carries and stops there: whether the installation really has
 * that application is a question only the bucket answers. Ingress counters take
 * the label as written, because a log line is counted rather than served.
 */

import { isSlug } from "../utils/slug.ts";

/**
 * The label a host carries under one of these platform domains, or null when it
 * is under none of them.
 *
 * The apex domain itself is not one: nothing is ever rendered at it, and a
 * request for it is not asking for an application. A custom domain is not one
 * either — resolving those needs the records that claimed them.
 */
export function platformLabel(host: string, platformDomains: string[]): string | null {
  for (const domain of platformDomains) {
    const suffix = `.${domain}`;
    if (host.endsWith(suffix)) return host.slice(0, -suffix.length);
  }
  return null;
}

/**
 * The application a host under one of these platform domains names, or null
 * when it is under none of them or carries a label scafo could never have
 * rendered.
 */
export function platformApplication(host: string, platformDomains: string[]): string | null {
  const label = platformLabel(host, platformDomains);
  return label !== null && isSlug(label) ? label : null;
}
