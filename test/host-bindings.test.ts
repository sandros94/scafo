/*
 * Which application a host names — the one reading the fleet's routing is
 * rendered from and the one the access counters attribute a log line by.
 */

import { describe, expect, it } from "vitest";
import {
  createHostIndex,
  type HostApplication,
  hostBindings,
} from "../src/core/placement/host-bindings.ts";

const DOMAINS = ["apps.test", "preview.test"];
const BASE = "shop.example.com";

describe("the hosts an installation answers on", () => {
  it("mints a platform host per domain, then the claims, then what a wildcard covers", () => {
    expect(
      hostBindings({
        platformDomains: ["apps.test"],
        applications: [
          covering(application("shop", [BASE]), [BASE]),
          application("shop-preview"),
          application("blog"),
        ],
      }),
    ).toEqual([
      /* Platform hosts first, in name order: a claim can never shadow one. */
      { host: "blog.apps.test", application: "blog" },
      { host: "shop.apps.test", application: "shop" },
      { host: "shop-preview.apps.test", application: "shop-preview" },
      /* Then every claim, exactly as it was made. */
      { host: BASE, application: "shop" },
      /* Then the family members one label under the base, and the base's
         catch-all last, so an exact entry always wins. */
      { host: `preview.${BASE}`, application: "shop-preview" },
      { host: `*.${BASE}`, application: "shop" },
    ]);
  });

  it("leaves out a name too long to be a host", () => {
    const long = "a".repeat(64);
    const hosts = hostBindings({
      platformDomains: ["apps.test"],
      applications: [application(long)],
    });

    expect(hosts).toEqual([]);
  });
});

describe("reading a request host back", () => {
  it("names the application a platform host spells, and nothing for the apex", () => {
    const index = createHostIndex({ platformDomains: DOMAINS, applications: [] });

    /* The grammar alone answers: a platform host is rendered from a name and
       from nothing else, so it reads back without asking the registry. */
    expect(index.resolve("shop.apps.test")).toBe("shop");
    expect(index.resolve("shop-preview.preview.test")).toBe("shop-preview");
    expect(index.resolve("apps.test")).toBeNull();
    expect(index.resolve("shop--preview.apps.test")).toBeNull();
    expect(index.resolve("elsewhere.test")).toBeNull();
  });

  it("names the application that claimed a host exactly", () => {
    const index = createHostIndex({
      platformDomains: DOMAINS,
      applications: [application("shop", [BASE])],
    });

    expect(index.resolve(BASE)).toBe("shop");
    /* An exact claim covers the host and nothing under it. */
    expect(index.resolve(`preview.${BASE}`)).toBeNull();
  });

  it("applies the three rules a wildcard claim stands for", () => {
    const index = createHostIndex({
      platformDomains: DOMAINS,
      applications: [
        covering(application("shop", [BASE]), [BASE]),
        application("shop-preview"),
        application("blog"),
      ],
    });

    /* Rule 1: the base itself is the holder's. */
    expect(index.resolve(BASE)).toBe("shop");
    /* Rule 2: one label under it naming an application of the family. */
    expect(index.resolve(`preview.${BASE}`)).toBe("shop-preview");
    /* Rule 3: every other name one label under it is the holder's. */
    expect(index.resolve(`staging.${BASE}`)).toBe("shop");
    expect(index.resolve(`blog.${BASE}`)).toBe("shop");
    /* Two labels under it is nobody's, as under a wildcard certificate. */
    expect(index.resolve(`a.preview.${BASE}`)).toBeNull();
  });

  it("falls to the catch-all for an environment no application is named for", () => {
    const index = createHostIndex({
      platformDomains: DOMAINS,
      applications: [covering(application("shop", [BASE]), [BASE])],
    });

    /* Nothing is named `shop-preview`, so the host is one the holder answers. */
    expect(index.resolve(`preview.${BASE}`)).toBe("shop");
  });

  it("lets an exact claim under the base win over the wildcard enclosing it", () => {
    const index = createHostIndex({
      platformDomains: DOMAINS,
      applications: [
        covering(application("shop", [BASE]), [BASE]),
        /* The family member holds the same host exactly; the claim decides. */
        application("shop-preview", [`preview.${BASE}`]),
      ],
    });

    expect(index.resolve(`preview.${BASE}`)).toBe("shop-preview");
  });

  it("answers for a host of an application nothing is serving", () => {
    /* Resolution is a question about names, not about what is running: a claim
       outlives every process that ever answered on it. */
    const index = createHostIndex({
      platformDomains: DOMAINS,
      applications: [application("shop", [BASE])],
    });

    expect(index.resolve(BASE)).toBe("shop");
    expect(index.resolve("shop.apps.test")).toBe("shop");
  });

  it("answers nothing for an installation that claimed no wildcard", () => {
    const index = createHostIndex({
      platformDomains: DOMAINS,
      applications: [application("shop", ["shop.example.com"])],
    });

    expect(index.resolve("anything.example.com")).toBeNull();
    expect(index.resolve("203.0.113.9")).toBeNull();
  });
});

function application(name: string, domains: string[] = []): HostApplication {
  return { name, domains };
}

/** The same record with some of its hosts claimed WITH their subdomains. */
function covering(record: HostApplication, hosts: string[]): HostApplication {
  return { ...record, wildcardDomains: hosts };
}
