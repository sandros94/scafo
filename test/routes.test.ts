/* How a platform host is spelled, and read back. */

import { describe, expect, it } from "vitest";
import { hostUnder } from "../src/core/placement/routes.ts";
import { platformApplication, platformLabel } from "../src/core/placement/hosts.ts";

describe("platform hosts", () => {
  it("builds a platform host as the name under the domain", () => {
    expect(hostUnder("apps.test", "shop")).toBe("shop.apps.test");
    expect(hostUnder("apps.test", "shop-preview")).toBe("shop-preview.apps.test");
    expect(hostUnder("apps.test", "a".repeat(64))).toBeNull();
  });

  it("reads a platform host back into the application it names", () => {
    expect(platformLabel("shop.apps.test", ["apps.test"])).toBe("shop");
    expect(platformApplication("shop-preview.apps.test", ["apps.test"])).toBe("shop-preview");

    /* The apex names no application, and neither does a label scafo could never
       have rendered. */
    expect(platformApplication("apps.test", ["apps.test"])).toBeNull();
    expect(platformApplication("shop--preview.apps.test", ["apps.test"])).toBeNull();
    expect(platformApplication("shop.example.com", ["apps.test"])).toBeNull();
  });
});
