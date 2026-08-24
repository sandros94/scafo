/*
 * Rotating the key a remote signs with, expand-contract, against the real node
 * app over an injected `fetch`.
 *
 * THE ORDER IS THE DESIGN, and it is what these cases are about. The new key is
 * registered with the fleet and then PROVED — an authenticated call made with it
 * — before the home is repointed, and the old key is deregistered only after the
 * home has been repointed and only under the new key's signature. Every one of
 * the three writes can therefore be the last thing that happens, and none of
 * them leaves a fleet nobody holds a key for:
 *
 *   - died before the flip: both keys trusted, home still on the old one, and
 *     the pending key waiting in the home for the rerun to pick up
 *   - died after the flip: home on the new key, old one still trusted, which is
 *     a key too many rather than a key too few
 *
 * The crashes are injected through the `fetch` seam alone, so what is being
 * tested is the production path stopping where a real interruption would stop
 * it, rather than a test-only hook.
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { H3 } from "h3";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createNodeApp } from "../src/daemon/app.ts";
import type { DaemonConfig } from "../src/daemon/config.ts";
import { addRemote, type RemoteEntry, readRemotes } from "../src/cli/_remotes.ts";
import { homeKeysDir, resolveHomePath } from "../src/cli/_home.ts";
import type { OperatorKeyFile } from "../src/cli/_operator-key.ts";
import { formatRemoteKeys, listRemoteKeys, revokeRemoteKey } from "../src/cli/_operators.ts";
import { describeRotation, rotateRemoteKey } from "../src/cli/_rotate.ts";
import { signNodeToken } from "../src/core/auth/index.ts";
import {
  getOperator,
  type OperatorRole,
  listOperators,
  trustOperator,
} from "../src/core/registry/operators.ts";
import type { Supervisor } from "../src/core/types/supervisor.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock, rejectsWith } from "./_helpers.ts";

const NODE_URL = "http://10.0.0.4:7400";
const REMOTE = "prod";
const VERSION = "0.0.0-test";

/** The admin an operator-tier home is set up beside; see `registeredRemote`. */
const ADMIN_ID = "op-9999admin";

const homes: string[] = [];

let clock: ManualClock;
let app: H3;

afterAll(async () => {
  await Promise.all(homes.map((path) => rm(path, { recursive: true, force: true })));
});

beforeEach(() => {
  clock = ctxWith(new MemoryCasStore());
  app = nodeApp();
});

describe("the whole rotation", () => {
  it("mints a key, has the fleet trust it, repoints the home and drops the old one", async () => {
    const { home, key } = await registeredRemote();

    const rotated = await rotateRemoteKey(home, REMOTE, { fetchFn: through(app) });

    expect(rotated.oldKeyId).toBe(key.id);
    expect(rotated.newKeyId).not.toBe(key.id);
    expect(rotated.contracted).toBe(true);
    expect(rotated.resumed).toBe(false);

    /* One key trusted, and it is the new one: expand, then contract. */
    expect(await trustedIds()).toEqual([rotated.newKeyId]);
    expect((await entryOf(home, REMOTE)).key.path).toBe(refOf(home, rotated.newKeyPath));
  });

  it("leaves a fleet the new key can work and the old key cannot", async () => {
    const { home, key } = await registeredRemote();

    const rotated = await rotateRemoteKey(home, REMOTE, { fetchFn: through(app) });
    const rotatedKey = await keyFileAt(rotated.newKeyPath);

    /*
     * Asked of a FRESH app, because a verifier caches the keys it has read for
     * the length of its revocation bound: the app that carried the rotation out
     * would go on accepting the old key for up to a minute, which is the
     * documented cost of revocation rather than a fact about this rotation.
     */
    const later = nodeApp();
    const withNew = await later.request(`${NODE_URL}/v1/operators`, {
      headers: {
        authorization: `Bearer ${await signNodeToken(rotatedKey.privateKey, rotated.newKeyId)}`,
      },
    });
    const withOld = await later.request(`${NODE_URL}/v1/operators`, {
      headers: { authorization: `Bearer ${await signNodeToken(key.privateKey, key.id)}` },
    });

    expect(withNew.status).toBe(200);
    expect(withOld.status).toBe(401);
  });

  it("keeps the old key FILE, referenced by no remote, rather than deleting it", async () => {
    const { home, key } = await registeredRemote();

    const rotated = await rotateRemoteKey(home, REMOTE, { fetchFn: through(app) });

    /* A private key is not scafo's to destroy on its own initiative: whatever
       else that file signed for, and whatever an operator archived it against,
       is not knowable from here. */
    expect(rotated.purged).toBe(false);
    await expect(keyFileAt(rotated.oldKeyPath)).resolves.toMatchObject({ id: key.id });

    const referenced = Object.values((await readRemotes(home)).remotes).map(
      (entry) => entry.key.path,
    );
    expect(referenced).not.toContain(refOf(home, rotated.oldKeyPath));
  });
});

describe("rotating across the two tiers", () => {
  it("rotates an ADMIN key end to end, and records the lineage for the audit trail", async () => {
    const { home, key } = await registeredRemote("admin");

    const rotated = await rotateRemoteKey(home, REMOTE, { fetchFn: through(app) });

    expect(rotated.role).toBe("admin");
    expect(rotated.contracted).toBe(true);
    /* An admin passes the admin check anyway; the lineage is recorded all the
       same, because it is what says which key replaced which. */
    await expect(getOperator(clock.ctx, rotated.newKeyId)).resolves.toMatchObject({
      role: "admin",
      supersedes: key.id,
    });
  });

  it("rotates an OPERATOR-tier key end to end, contracting through its own lineage", async () => {
    const { home, key } = await registeredRemote("operator");

    const rotated = await rotateRemoteKey(home, REMOTE, { fetchFn: through(app) });

    /*
     * The wrinkle the whole design turns on: DELETE is no longer open to every
     * trusted key, so an operator-tier rotation would have nothing authorizing
     * its contract step. The new key superseding the old is what does.
     */
    expect(rotated.role).toBe("operator");
    expect(rotated.contracted).toBe(true);
    expect(await trustedIds()).toEqual([ADMIN_ID, rotated.newKeyId].sort());
    await expect(getOperator(clock.ctx, rotated.newKeyId)).resolves.toMatchObject({
      role: "operator",
      supersedes: key.id,
    });
  });

  it("never promotes a rotated key, whatever tier the fleet's other keys are", async () => {
    const { home } = await registeredRemote("operator");

    const rotated = await rotateRemoteKey(home, REMOTE, { fetchFn: through(app) });

    /* A rotation replaces a key; it is not a way to acquire a better one. */
    expect(rotated.role).not.toBe("admin");
    await expect(getOperator(clock.ctx, ADMIN_ID)).resolves.toMatchObject({ role: "admin" });
  });

  it("says which tier the new key landed at", async () => {
    const { home } = await registeredRemote("operator");

    const said = describeRotation(await rotateRemoteKey(home, REMOTE, { fetchFn: through(app) }));

    expect(said).toContain("operator-tier");
  });
});

describe("a rotation that was interrupted", () => {
  it("dies before the flip leaving BOTH keys trusted and the home on the old one", async () => {
    const { home, key } = await registeredRemote();

    await rejectsWith(
      () => rotateRemoteKey(home, REMOTE, { fetchFn: crashOn(app, "GET") }),
      "draining",
    );

    /* Nothing has been taken away: the fleet answers to the key the home still
       points at, so every other command goes on working. */
    expect(await trustedIds()).toHaveLength(2);
    expect(await trustedIds()).toContain(key.id);
    expect((await entryOf(home, REMOTE)).key.path).toBe("keys/prod.json");
  });

  it("is finished by a rerun that ADOPTS the pending key rather than minting a third", async () => {
    const { home, key } = await registeredRemote();
    await rejectsWith(
      () => rotateRemoteKey(home, REMOTE, { fetchFn: crashOn(app, "GET") }),
      "draining",
    );
    const pending = (await trustedIds()).find((id) => id !== key.id) as string;

    const rotated = await rotateRemoteKey(home, REMOTE, { fetchFn: through(app) });

    expect(rotated.resumed).toBe(true);
    expect(rotated.newKeyId).toBe(pending);
    /* Exactly one key trusted afterwards: the interrupted run left nothing
       behind for an operator to go and find later. */
    expect(await trustedIds()).toEqual([pending]);
  });

  it("dies after the flip leaving the home on the new key and the old one still trusted", async () => {
    const { home, key } = await registeredRemote();

    await rejectsWith(
      () => rotateRemoteKey(home, REMOTE, { fetchFn: crashOn(app, "DELETE") }),
      "draining",
    );

    const entry = await entryOf(home, REMOTE);
    const flipped = await keyFileAt(resolveHomePath(home, entry.key.path));
    expect(flipped.id).not.toBe(key.id);
    /* A key too many, never a key too few — and the home holds the one that
       still works. */
    expect(await trustedIds()).toContain(key.id);
    expect(await trustedIds()).toContain(flipped.id);
  });

  it("is finished by revoking the old key, which the NEW key is what authorizes", async () => {
    const { home, key } = await registeredRemote();
    await rejectsWith(
      () => rotateRemoteKey(home, REMOTE, { fetchFn: crashOn(app, "DELETE") }),
      "draining",
    );

    const revoked = await revokeRemoteKey(home, REMOTE, key.id, { fetchFn: through(app) });

    expect(revoked.removed).toBe(key.id);
    expect(await trustedIds()).not.toContain(key.id);
  });

  it("is also survivable by rerunning the rotation, which then names what is left over", async () => {
    const { home, key } = await registeredRemote();
    await rejectsWith(
      () => rotateRemoteKey(home, REMOTE, { fetchFn: crashOn(app, "DELETE") }),
      "draining",
    );

    const rotated = await rotateRemoteKey(home, REMOTE, { fetchFn: through(app) });

    /* A rerun rotates again rather than finishing the previous run's contract —
       it can only deregister the key the home was pointing at — so the one the
       interrupted run left behind is REPORTED instead of silently kept. */
    expect(rotated.alsoTrusted).toEqual([key.id]);
    expect(await trustedIds()).toContain(rotated.newKeyId);
  });
});

describe("--keep-old", () => {
  it("stops after the flip, leaving both keys trusted", async () => {
    const { home, key } = await registeredRemote();

    const rotated = await rotateRemoteKey(home, REMOTE, { fetchFn: through(app), keepOld: true });

    expect(rotated.contracted).toBe(false);
    expect((await trustedIds()).sort()).toEqual([key.id, rotated.newKeyId].sort());
    expect((await entryOf(home, REMOTE)).key.path).toBe(refOf(home, rotated.newKeyPath));
  });

  it("is refused together with --purge-old, which asks for the opposite thing", async () => {
    const { home } = await registeredRemote();

    /* Keeping a key trusted while destroying the only copy of its private half
       leaves a way in that nobody holds — refused rather than resolved in
       either direction. */
    const error = await rejectsWith(
      () => rotateRemoteKey(home, REMOTE, { fetchFn: through(app), keepOld: true, purgeOld: true }),
      "invalid-input",
    );

    expect(error.detail).toContain("--keep-old");
    expect(error.detail).toContain("--purge-old");
  });
});

describe("--purge-old", () => {
  it("deletes the old key file once the fleet no longer trusts it", async () => {
    const { home } = await registeredRemote();

    const rotated = await rotateRemoteKey(home, REMOTE, { fetchFn: through(app), purgeOld: true });

    expect(rotated.purged).toBe(true);
    await expect(keyFileAt(rotated.oldKeyPath)).rejects.toThrow("ENOENT");
  });

  it("KEEPS it when another remote in this home still signs with it", async () => {
    const { home } = await registeredRemote();
    await addRemote(home, { name: "mirror", endpoints: [NODE_URL], keyName: REMOTE });

    const rotated = await rotateRemoteKey(home, REMOTE, { fetchFn: through(app), purgeOld: true });

    expect(rotated.purged).toBe(false);
    expect(rotated.sharedWith).toEqual(["mirror"]);
    await expect(keyFileAt(rotated.oldKeyPath)).resolves.toBeDefined();
  });
});

describe("the other remotes in the home", () => {
  it("are left exactly as they were, key reference included", async () => {
    const { home, key } = await registeredRemote();
    await addRemote(home, { name: "mirror", endpoints: [NODE_URL], keyName: REMOTE });
    const before = await entryOf(home, "mirror");

    const rotated = await rotateRemoteKey(home, REMOTE, { fetchFn: through(app) });

    /* Repointing them would rotate installations the operator never named. */
    expect(await entryOf(home, "mirror")).toEqual(before);
    expect((await entryOf(home, "mirror")).key.path).toBe("keys/prod.json");
    expect(rotated.sharedWith).toEqual(["mirror"]);
    expect(await keyFileAt(resolveHomePath(home, before.key.path))).toMatchObject({ id: key.id });
  });

  it("do not get a key file of their own out of the rotation", async () => {
    const { home } = await registeredRemote();

    const rotated = await rotateRemoteKey(home, REMOTE, { fetchFn: through(app) });

    /* The old file and the new one, and nothing else: a rotation writes one key. */
    const files = (await readdir(homeKeysDir(home))).sort();
    expect(files).toHaveLength(2);
    expect(files).toContain(rotated.newKeyPath.split("/").pop());
  });
});

describe("reading what a fleet trusts", () => {
  it("names every key, and which of them this home signs with", async () => {
    const { home, key } = await registeredRemote();
    const rotated = await rotateRemoteKey(home, REMOTE, { fetchFn: through(app), keepOld: true });

    const view = await listRemoteKeys(home, REMOTE, { fetchFn: through(app) });

    expect(view.own).toBe(rotated.newKeyId);
    expect(view.trusted.map((entry) => entry.id).sort()).toEqual([key.id, rotated.newKeyId].sort());
  });

  it("marks the operator's own key in what it prints", async () => {
    const { home, key } = await registeredRemote();
    await trustOperator(clock.ctx, {
      id: "op-cccc3333",
      publicKey: { kty: "OKP", crv: "Ed25519", x: "x-for-a-colleague" },
      role: "operator",
    });

    const printed = formatRemoteKeys(await listRemoteKeys(home, REMOTE, { fetchFn: through(app) }));

    expect(printed).toContain("2 operator keys");
    expect(printed).toMatch(new RegExp(`${key.id}.*this home signs with it`));
    expect(printed).toMatch(/op-cccc3333\s+operator\s*$/m);
  });

  it("names the TIER of every key, which is what says who may administer whom", async () => {
    const { home, key } = await registeredRemote("admin");
    await trustOperator(clock.ctx, {
      id: "op-cccc3333",
      publicKey: { kty: "OKP", crv: "Ed25519", x: "x-for-a-colleague" },
      role: "operator",
    });

    const printed = formatRemoteKeys(await listRemoteKeys(home, REMOTE, { fetchFn: through(app) }));

    expect(printed).toMatch(new RegExp(`${key.id}\\s+admin`));
    expect(printed).toMatch(/op-cccc3333\s+operator/);
  });

  it("names the key a rotated one replaced, where there is one", async () => {
    const { home, key } = await registeredRemote("admin");
    const rotated = await rotateRemoteKey(home, REMOTE, { fetchFn: through(app), keepOld: true });

    const printed = formatRemoteKeys(await listRemoteKeys(home, REMOTE, { fetchFn: through(app) }));

    expect(printed).toContain(`replaces ${key.id}`);
    expect(printed).toContain(rotated.newKeyId);
  });
});

describe("what a rotation says it did", () => {
  it("names the remotes it deliberately did NOT repoint, and why they matter", async () => {
    const { home } = await registeredRemote();
    await addRemote(home, { name: "mirror", endpoints: [NODE_URL], keyName: REMOTE });

    const said = describeRotation(await rotateRemoteKey(home, REMOTE, { fetchFn: through(app) }));

    /* Silence here is the failure mode worth guarding: a fleet reaching this
       same installation with the key just revoked stops working, and nothing
       else would tell the operator that. */
    expect(said).toContain("mirror");
    expect(said).toContain("NOT");
    expect(said).toContain("rotate them too");
  });

  it("says the old key file was kept, and what deletes it", async () => {
    const { home } = await registeredRemote();

    const said = describeRotation(await rotateRemoteKey(home, REMOTE, { fetchFn: through(app) }));

    expect(said).toContain("was kept");
    expect(said).toContain("--purge-old");
  });

  it("says what is still trusted after --keep-old, and how to remove it", async () => {
    const { home, key } = await registeredRemote();

    const said = describeRotation(
      await rotateRemoteKey(home, REMOTE, { fetchFn: through(app), keepOld: true }),
    );

    expect(said).toContain("STILL trusted");
    expect(said).toContain(`scafo operator revoke --remote ${REMOTE} --id ${key.id}`);
  });

  it("names the leftovers of an earlier interrupted run rather than hiding them", async () => {
    const { home, key } = await registeredRemote();
    await rejectsWith(
      () => rotateRemoteKey(home, REMOTE, { fetchFn: crashOn(app, "DELETE") }),
      "draining",
    );

    const said = describeRotation(await rotateRemoteKey(home, REMOTE, { fetchFn: through(app) }));

    expect(said).toContain(key.id);
    expect(said).toContain("also trusts");
    expect(said).toContain("scafo operator revoke");
  });

  it("says when it took over a key an interrupted run had already minted", async () => {
    const { home } = await registeredRemote();
    await rejectsWith(
      () => rotateRemoteKey(home, REMOTE, { fetchFn: crashOn(app, "GET") }),
      "draining",
    );

    const said = describeRotation(await rotateRemoteKey(home, REMOTE, { fetchFn: through(app) }));

    expect(said).toContain("took over");
  });
});

describe("revoking another operator's key", () => {
  it("removes it without touching the caller's own", async () => {
    const { home, key } = await registeredRemote();
    await trustOperator(clock.ctx, {
      id: "op-cccc3333",
      publicKey: { kty: "OKP", crv: "Ed25519", x: "x-for-a-colleague" },
      role: "operator",
    });

    const revoked = await revokeRemoteKey(home, REMOTE, "op-cccc3333", { fetchFn: through(app) });

    expect(revoked.removed).toBe("op-cccc3333");
    expect(await trustedIds()).toEqual([key.id]);
  });

  it("REFUSES the caller's own key, naming rotation as the way to replace it", async () => {
    const { home, key } = await registeredRemote();
    await trustOperator(clock.ctx, {
      id: "op-cccc3333",
      publicKey: { kty: "OKP", crv: "Ed25519", x: "x-for-a-colleague" },
      role: "operator",
    });

    const error = await rejectsWith(
      () => revokeRemoteKey(home, REMOTE, key.id, { fetchFn: through(app) }),
      "invalid-input",
    );

    expect(error.detail).toContain("rotate");
    expect(await trustedIds()).toContain(key.id);
  });

  it("cannot leave the fleet trusting nothing, the last key being the caller's own", async () => {
    const { home, key } = await registeredRemote();

    /* The same refusal as above, and it is the one that matters: the caller is
       always one of the trusted keys, so the key it is refused is exactly the
       key whose removal would leave nobody able to put one back. */
    await rejectsWith(
      () => revokeRemoteKey(home, REMOTE, key.id, { fetchFn: through(app) }),
      "invalid-input",
    );
    expect(await trustedIds()).toEqual([key.id]);
  });
});

/* ------------------------------------------------------------------ helpers */

/**
 * A home holding one remote whose key the installation already trusts, at the
 * tier asked for.
 *
 * An operator-tier home comes with an ADMIN beside it, because that is the only
 * way a fleet ever reaches that state: the first key of an installation is
 * always an admin, and operator-tier keys are what an admin adds afterwards.
 */
async function registeredRemote(
  role: OperatorRole = "admin",
): Promise<{ home: string; key: OperatorKeyFile }> {
  const home = await mkdtemp(join(tmpdir(), "scafo-rotate-"));
  homes.push(home);

  if (role === "operator") {
    await trustOperator(clock.ctx, {
      id: ADMIN_ID,
      publicKey: { kty: "OKP", crv: "Ed25519", x: "x-for-the-admin" },
      role: "admin",
    });
  }

  const added = await addRemote(home, { name: REMOTE, endpoints: [NODE_URL] });
  await trustOperator(clock.ctx, {
    id: added.key.id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: added.key.publicKey.x },
    role,
  });
  return { home, key: added.key };
}

/** Ids the installation trusts right now, in id order. */
async function trustedIds(): Promise<string[]> {
  return (await listOperators(clock.ctx)).map((entry) => entry.id);
}

async function entryOf(home: string, name: string): Promise<RemoteEntry> {
  return (await readRemotes(home)).remotes[name] as RemoteEntry;
}

/** How the home REFERS to a key file it holds. */
function refOf(home: string, path: string): string {
  return path.slice(home.length + 1).replaceAll("\\", "/");
}

async function keyFileAt(path: string): Promise<OperatorKeyFile> {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(path, "utf8")) as OperatorKeyFile;
}

/** Calls that reach the app in this process; the app may answer synchronously. */
function through(target: H3): typeof fetch {
  return async (input, init) => target.request(String(input), init);
}

/**
 * The same, until the rotation reaches `method` — where the process is taken to
 * have died. Nothing is answered and nothing is written; the call simply never
 * comes back, which is what an interruption looks like from the caller's side.
 */
function crashOn(target: H3, method: string): typeof fetch {
  return async (input, init) => {
    if ((init?.method ?? "GET").toUpperCase() === method) {
      const { ScafoError } = await import("../src/core/error.ts");
      throw new ScafoError("draining", "Injected fault", {
        detail: `the ${method} of the rotation was killed`,
      });
    }
    return target.request(String(input), init);
  };
}

function nodeApp(): H3 {
  return createNodeApp({
    config: daemonConfig(),
    nodeId: "node-a",
    registry: clock.ctx,
    supervisor: idleSupervisor(),
    version: VERSION,
  });
}

function daemonConfig(): DaemonConfig {
  return {
    bucket: {
      endpoint: "http://store.test:9000",
      region: "us-east-1",
      bucket: "registry",
      accessKey: "key",
      secretKey: "secret",
    },
    node: { id: "node-a", listen: "127.0.0.1:7400" },
    platformDomains: ["apps.test"],
    runtime: {
      binPath: "celld",
      portRangeStart: 42_000,
      probePath: "/",
      bindHost: "127.0.0.1",
      durability: "bucket",
      cellIdleEvictS: 900,
      pointerHoldMs: 3_000,
    },
    observability: { enabled: false },
    api: { public: true },
  };
}

function idleSupervisor(): Supervisor {
  return {
    start: (spec) => Promise.reject(new Error(`unexpected start of "${spec.id}"`)),
    stop: () => Promise.resolve(),
    status: () => null,
    list: () => [],
    onExit: () => {},
  };
}
