/*
 * The pinned Celld contract. Its constants are only as trustworthy as the links
 * beside them, so the links themselves are tested: a moving `main` or tag link
 * would say what upstream is today rather than what this build was read against.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  ASSET_INDEX_SCHEMA_VERSION,
  DEPLOYMENT_FEATURES,
  LEGACY_MANIFEST_SCHEMA_VERSION,
  MANIFEST_SCHEMA_VERSIONS,
  VERIFIED_CELLD_RELEASES,
  verifiedReleaseList,
} from "../src/core/registry/_celld-contract.ts";

const SOURCE = new URL("../src/core/registry/_celld-contract.ts", import.meta.url);

/** Every upstream link in the module, and the ref each one is pinned at. */
const LINK_RE = /https:\/\/github\.com\/denoland\/celld\/blob\/([^/]+)\/([^\s)]+)/g;

async function links(): Promise<Array<{ ref: string; path: string; whole: string }>> {
  const text = await readFile(SOURCE, "utf8");
  return [...text.matchAll(LINK_RE)].map((match) => ({
    ref: match[1],
    path: match[2],
    whole: match[0],
  }));
}

describe("the permalinks the contract is read from", () => {
  it("names upstream at all, in every one of the files the pinned commands depend on", async () => {
    const found = await links();

    expect(found.length).toBeGreaterThan(20);
    expect(new Set(found.map((link) => link.path.split("#")[0]))).toEqual(
      new Set([
        /* What `scafo deployment prune` reads: the deployment layout. */
        "crates/celld/protocol.rs",
        "crates/celld/deploy.rs",
        "crates/celld/container.rs",
        /* What `scafo app lease` reads: the node lease, its key, its name rule,
           the liveness rule it is judged by, and the failure it wedges on. */
        "crates/celld/ownership_store.rs",
        "crates/celld/node_log.rs",
        "crates/celld/main.rs",
        "crates/logic/peer.rs",
        "crates/logic/drain.rs",
        "crates/logic/dead_node_reconciliation.rs",
        /* What the version-skew gate rests on: upstream's word on which
           releases may roll. */
        "docs/README.md",
      ]),
    );
  });

  it("pins every link to a commit, never to a branch or a tag that can move", async () => {
    for (const link of await links()) {
      expect(link.ref, link.whole).toMatch(/^[\da-f]{40}$/);
    }
  });

  it("points every link at lines, and names the release those lines are of", async () => {
    const text = await readFile(SOURCE, "utf8");

    for (const link of await links()) {
      expect(link.path, link.whole).toMatch(/#L\d+(-L\d+)?$/);
      /* The tag is what a reader upgrading upstream compares against; a bare
         commit says nothing about which release it is. */
      expect(text, link.whole).toContain(`${link.whole} (v`);
    }
  });
});

describe("what the contract pins", () => {
  it("names at least one verified release, each a plain X.Y.Z", () => {
    expect(VERIFIED_CELLD_RELEASES.length).toBeGreaterThan(0);
    for (const release of VERIFIED_CELLD_RELEASES) expect(release).toMatch(/^\d+\.\d+\.\d+$/);
    expect(verifiedReleaseList()).toBe(VERIFIED_CELLD_RELEASES.join(", "));
  });

  it("names every release prune was run end to end against", () => {
    expect(verifiedReleaseList()).toBe("0.5.0, 0.5.1, 0.6.0, 0.6.1");
  });


  it("reads an absent manifest schema version as one it knows", () => {
    expect(MANIFEST_SCHEMA_VERSIONS).toContain(LEGACY_MANIFEST_SCHEMA_VERSION);
  });

  it("knows the features upstream's own loader supports", () => {
    expect([...DEPLOYMENT_FEATURES].sort()).toEqual(
      [
        "assets-v1",
        "containers-v1",
        "cron-v1",
        "d1-v1",
        "kv-v1",
        "queues-v1",
        "r2-v1",
        "sqlite-vec-v1",
        "wasm-v1",
        "workflows-v1",
        "python-workers-v1",
      ].sort(),
    );
    expect(ASSET_INDEX_SCHEMA_VERSION).toBe(1);
  });
});
