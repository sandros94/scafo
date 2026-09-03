/* The token guarding this node's storage surface: where it comes from, and what the boot says about it. */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  loadOrCreateIngressToken,
  INGRESS_TOKEN_FILE,
  ingressTokenNotice,
  writeIngressToken,
} from "../src/cli/_ingress-token.ts";

const PATH = "/var/lib/scafo/ingress-token";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("what the boot says about the ingress token", () => {
  it("tells the operator to mount the file when the node minted the token itself", () => {
    /* Byte for byte what it has always said: the file is the only place this
       token exists, so mounting it is the whole of the handoff — and the TLS
       end-to-end suite reads this very line out of a node's log. */
    expect(ingressTokenNotice({ path: PATH, supplied: 0 })).toEqual([
      `scafo: ingress token at ${PATH}; mount it read-only into the process that terminates TLS`,
    ]);
  });

  it("says where a supplied token was written instead of asking for a mount", () => {
    const said = ingressTokenNotice({ path: PATH, supplied: 1 });

    expect(said).toHaveLength(1);
    expect(said[0]).toContain(`"ingress.token"`);
    expect(said[0]).toContain(PATH);
    /* The operator's own channel already carried it; a mount is not the step. */
    expect(said[0]).not.toContain("mount");
  });

  it("names the rotation an operator is mid-way through, and what to do next", () => {
    const said = ingressTokenNotice({ path: PATH, supplied: 2 });

    expect(said).toHaveLength(2);
    expect(said[0]).toContain("names 2");
    expect(said[0]).toContain("the primary");
    expect(said[0]).not.toContain("mount");
    expect(said[1]).toContain("contract the setting");
  });
});

describe("the file the notice names", () => {
  it("holds the token a node minted for itself", async () => {
    const dir = await stateDir();

    const token = await loadOrCreateIngressToken(dir);

    expect(await stored(dir)).toBe(token);
  });

  it("holds the primary of what the operator supplied, which is what the line claims", async () => {
    const dir = await stateDir();

    await writeIngressToken(dir, "primary-token");

    expect(await stored(dir)).toBe("primary-token");
  });
});

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scafo-ingress-token-"));
  dirs.push(dir);
  return dir;
}

async function stored(dir: string): Promise<string> {
  return (await readFile(join(dir, INGRESS_TOKEN_FILE), "utf8")).trim();
}
