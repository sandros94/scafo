/*
 * `scafo operator show` and `scafo operator enroll`: how somebody who has a key gets that key
 * admitted by somebody who can admit it.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { H3 } from "h3";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createNodeApp } from "../src/daemon/app.ts";
import type { DaemonConfig } from "../src/daemon/config.ts";
import {
  generateOperatorKey,
  INLINE_PREFIX,
  loadPublicOperator,
  type OperatorKeyFile,
  PUBLIC_KIND,
  PUBLIC_VERSION,
  publicOperator,
  readPublicOperator,
} from "../src/cli/_operator-key.ts";
import {
  assertScopedEnrollment,
  describeEnrollment,
  enrollInBucket,
  enrollOnWire,
  enrollPath,
  operatorProjects,
  showOperator,
} from "../src/cli/_operators.ts";
import { addRemote } from "../src/cli/_remotes.ts";
import { getOperator, trustOperator } from "../src/core/registry/operators.ts";
import type { Supervisor } from "../src/core/types/supervisor.ts";
import { toBase64 } from "../src/core/utils/base64.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock, rejectsWith } from "./_helpers.ts";

const NODE_URL = "http://10.0.0.4:7400";
const REMOTE = "prod";
const VERSION = "0.0.0-test";

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

describe("what an operator shows of themselves", () => {
  it("prints the id and the public half of the key the remote signs with", async () => {
    const { home, key } = await registeredRemote();

    const shown = await showOperator({ home, env: {}, flags: {}, readFile: noConfig });

    expect(shown.remote).toBe(REMOTE);
    expect(shown.public).toEqual({
      v: PUBLIC_VERSION,
      kind: PUBLIC_KIND,
      id: key.id,
      publicKey: { kty: "OKP", crv: "Ed25519", x: key.publicKey.x },
    });
  });

  it("NEVER puts private material in the document, whatever the key file holds", async () => {
    const { home, key } = await registeredRemote();

    const shown = await showOperator({ home, env: {}, flags: {}, readFile: noConfig });

    /* The key file this was read from holds both halves — that is what makes
       the check worth making rather than trivially true. */
    expect(key.privateKey.d).toBeTypeOf("string");
    expect(shown.document).not.toContain(key.privateKey.d);
    expect(shown.document).not.toContain('"d"');
    expect(shown.document).not.toContain("privateKey");
  });

  it("keeps the document and the human notice apart, so a redirect is still a document", async () => {
    const { home } = await registeredRemote();

    const shown = await showOperator({ home, env: {}, flags: {}, readFile: noConfig });

    /* `scafo operator show > me.json` has to produce a file `enroll` can read
       as it stands, so nothing but the document may go to stdout. */
    expect(() => JSON.parse(shown.document)).not.toThrow();
    expect(shown.notice).not.toContain(shown.document);
    expect(shown.notice).toContain("PUBLIC");
  });

  it("shows the key --key names instead, for an operator with no remote at all", async () => {
    const home = await scratch();
    const key = await generateOperatorKey();
    const path = join(home, "loose-key.json");
    await writeFile(path, JSON.stringify(key), "utf8");

    const shown = await showOperator({
      home,
      env: {},
      flags: { key: path },
      readFile: noConfig,
    });

    expect(shown.public.id).toBe(key.id);
    expect(shown.remote).toBeUndefined();
  });

  it("prints a document enroll reads back, which is the whole point of it", async () => {
    const { home, key } = await registeredRemote();

    const shown = await showOperator({ home, env: {}, flags: {}, readFile: noConfig });

    expect(readPublicOperator(shown.document, "stdout")).toEqual(publicOperator(key));
  });
});

describe("which way an enrollment goes", () => {
  it("takes the wire when a remote is named", () => {
    expect(enrollPath({ remote: REMOTE })).toBe("wire");
  });

  it("takes the bucket when the bucket flags are given instead", () => {
    expect(enrollPath({ bucket: true })).toBe("bucket");
  });

  it("REFUSES both at once, because they are authorized by different credentials", async () => {
    const error = await rejectsWith(
      async () => enrollPath({ remote: REMOTE, bucket: true }),
      "invalid-input",
    );

    expect(error.detail).toContain("--remote");
    expect(error.detail).toContain("bucket");
  });

  it("REFUSES neither, naming both paths and what each is for", async () => {
    const error = await rejectsWith(async () => enrollPath({}), "invalid-input");

    /* A default here would be wrong in both directions: reaching for the bucket
       unasked is an escalation, and reaching for a node unasked fails at the
       exact moment recovery was what was wanted. */
    expect(error.detail).toContain("--remote");
    expect(error.detail).toContain("--config");
    expect(error.detail).toContain("recovered");
  });
});

describe("admitting a key over the wire", () => {
  it("records the public half a colleague sent, at the tier the admin asked for", async () => {
    const { home } = await registeredRemote();
    const joiner = publicOperator(await generateOperatorKey());

    const enrolled = await enrollOnWire(home, REMOTE, joiner, {
      role: "operator",
      /* Named because an operator-tier key must name what it reaches, and the
         admin doing the enrolling carries no scope for it to inherit. */
      projects: ["acme"],
      fetchFn: through(app),
    });

    expect(enrolled).toMatchObject({ id: joiner.id, role: "operator", path: "wire" });
    await expect(getOperator(clock.ctx, joiner.id)).resolves.toMatchObject({
      role: "operator",
      projects: ["acme"],
      publicKey: { kty: "OKP", crv: "Ed25519", x: joiner.publicKey.x },
    });
  });

  it("REFUSES an operator-tier key that names no projects, whoever is enrolling it", async () => {
    const { home } = await registeredRemote();
    const joiner = publicOperator(await generateOperatorKey());

    /* The default-deny, read from this end: an admin has no scope to hand down,
       so an enrollment that leaves the flag off used to mean every project. */
    await rejectsWith(
      () => enrollOnWire(home, REMOTE, joiner, { role: "operator", fetchFn: through(app) }),
      "invalid-input",
    );
    await expect(getOperator(clock.ctx, joiner.id)).resolves.toBeNull();
  });

  it("reports the tier the NODE decided, rather than the one that was asked for", async () => {
    const { home } = await registeredRemote("operator");
    const joiner = publicOperator(await generateOperatorKey());

    /* An operator-tier caller asking for an admin is refused by the node; what
       must never happen is this end reporting the tier it wanted. */
    await rejectsWith(
      () => enrollOnWire(home, REMOTE, joiner, { role: "admin", fetchFn: through(app) }),
      "auth-scope",
    );
    await expect(getOperator(clock.ctx, joiner.id)).resolves.toBeNull();
  });

  it("defaults to least privilege when no tier is named", async () => {
    const { home } = await registeredRemote();
    const joiner = publicOperator(await generateOperatorKey());

    const enrolled = await enrollOnWire(home, REMOTE, joiner, {
      projects: ["acme"],
      fetchFn: through(app),
    });

    expect(enrolled.role).toBe("operator");
  });
});

describe("the projects an enrollment scopes a key to", () => {
  it("reads a comma-separated list, the way endpoints and labels are read", () => {
    expect(operatorProjects("acme,globex")).toEqual({ projects: ["acme", "globex"] });
    expect(operatorProjects(" acme , globex ")).toEqual({ projects: ["acme", "globex"] });
  });

  it("leaves an absent list absent, for the NODE to decide what that means", () => {
    /* Absent must stay absent all the way down rather than becoming a `[]`:
       what it means depends on the tier the key lands at, which is the node's
       to settle — every project for an admin, and a refusal below that. */
    expect(operatorProjects(undefined)).toEqual({});
    expect(operatorProjects("")).toEqual({});
  });

  it('passes "*" through unchecked, because whether it is allowed is the node\'s to say', () => {
    /* It is not a slug, so validating it here would mean either teaching this
       the rule that it stands alone — policy in the one place that cannot
       enforce it — or refusing it with a message about lowercase letters. */
    expect(operatorProjects("*")).toEqual({ projects: ["*"] });
    expect(operatorProjects("*,acme")).toEqual({ projects: ["*", "acme"] });
  });

  it("refuses a name that is not a project slug, here rather than at the node", async () => {
    await rejectsWith(async () => operatorProjects("Not A Slug"), "invalid-slug");
  });

  it("scopes the key a node records, and reports the scope the node decided", async () => {
    const { home } = await registeredRemote();
    const joiner = publicOperator(await generateOperatorKey());

    const enrolled = await enrollOnWire(home, REMOTE, joiner, {
      projects: ["acme"],
      fetchFn: through(app),
    });

    expect(enrolled.projects).toEqual(["acme"]);
    await expect(getOperator(clock.ctx, joiner.id)).resolves.toMatchObject({
      role: "operator",
      projects: ["acme"],
    });
  });

  it("says which projects the key may reach, where it is scoped at all", async () => {
    const { home } = await registeredRemote();
    const joiner = publicOperator(await generateOperatorKey());

    const said = describeEnrollment(
      await enrollOnWire(home, REMOTE, joiner, { projects: ["acme"], fetchFn: through(app) }),
    );

    expect(said).toContain("acme");
  });

  it("REFUSES the ceremony flags together with a scope", async () => {
    /* The bucket path is for seeding and for recovery, both of which produce an
       ADMIN — and an admin is never scoped, so the pair asks for something that
       cannot exist. */
    const error = await rejectsWith(
      async () => assertScopedEnrollment("bucket", ["acme"]),
      "invalid-input",
    );

    expect(error.detail).toContain("admin");
  });

  it("REFUSES the ceremony flags together with an operator TIER", async () => {
    /* The same contradiction from the other end: that path names no projects,
       and an operator-tier key naming none may reach nothing at all. */
    const error = await rejectsWith(
      async () => assertScopedEnrollment("bucket", undefined, "operator"),
      "invalid-input",
    );

    expect(error.detail).toContain("--remote");
  });

  it("lets the ceremony run when it is admitting an admin, which is all it admits", () => {
    expect(() => assertScopedEnrollment("bucket", undefined)).not.toThrow();
    expect(() => assertScopedEnrollment("bucket", undefined, "admin")).not.toThrow();
    expect(() => assertScopedEnrollment("wire", ["acme"], "operator")).not.toThrow();
  });
});

describe("admitting a key through the bucket", () => {
  it("seeds an installation that has no admin to ask, and makes that first key one", async () => {
    const joiner = publicOperator(await generateOperatorKey());

    const enrolled = await enrollInBucket(clock.ctx, joiner);

    /* The ceremony's whole reason to exist: nothing trusted anything yet, so
       there was no key that could have authorized this over the wire. */
    expect(enrolled).toMatchObject({ id: joiner.id, role: "admin", path: "bucket" });
    await expect(getOperator(clock.ctx, joiner.id)).resolves.toMatchObject({ role: "admin" });
  });

  it("re-seeds an admin into a fleet whose operators are all locked out", async () => {
    await trustOperator(clock.ctx, {
      id: "op-locked",
      publicKey: { kty: "OKP", crv: "Ed25519", x: "x-nobody-holds" },
      role: "admin",
    });
    const rescue = publicOperator(await generateOperatorKey());

    const enrolled = await enrollInBucket(clock.ctx, rescue, { role: "admin" });

    expect(enrolled.role).toBe("admin");
    await expect(getOperator(clock.ctx, rescue.id)).resolves.toMatchObject({ role: "admin" });
  });

  it("says it was the ceremony, and what the ordinary way is", async () => {
    const said = describeEnrollment(
      await enrollInBucket(clock.ctx, publicOperator(await generateOperatorKey())),
    );

    expect(said).toContain("scafo operator enroll");
    expect(said).toContain("recovery");
  });
});

describe("the document an enrollment accepts", () => {
  it("reads one out of an inline base64: value", async () => {
    const joiner = publicOperator(await generateOperatorKey());

    const loaded = await loadPublicOperator(
      INLINE_PREFIX + toBase64(new TextEncoder().encode(JSON.stringify(joiner))),
    );

    expect(loaded).toEqual(joiner);
  });

  it("reads one written out on the command line", async () => {
    const joiner = publicOperator(await generateOperatorKey());

    await expect(loadPublicOperator(JSON.stringify(joiner))).resolves.toEqual(joiner);
  });

  it("reads one out of a file, which is what a redirect of show produced", async () => {
    const { home } = await registeredRemote();
    const shown = await showOperator({ home, env: {}, flags: {}, readFile: noConfig });
    const path = join(await scratch(), "colleague.json");
    await writeFile(path, shown.document, "utf8");

    await expect(loadPublicOperator(path)).resolves.toEqual(shown.public);
  });

  it("REFUSES a whole key file, and says a private key has just been sent somewhere", async () => {
    const path = join(await scratch(), "whole-key.json");
    await writeFile(path, JSON.stringify(await generateOperatorKey()), "utf8");

    const error = await rejectsWith(() => loadPublicOperator(path), "invalid-input");

    /* Narrowing it to the public fields and carrying on would bury the one thing
       worth saying: somebody's private half is now in somebody else's hands. */
    expect(error.message).toContain("PRIVATE");
    expect(error.detail).toContain("scafo operator show");
  });

  it("REFUSES a document of a version this scafo does not write", async () => {
    const joiner = publicOperator(await generateOperatorKey());
    const error = await rejectsWith(
      async () => readPublicOperator(JSON.stringify({ ...joiner, v: 99 }), "the future"),
      "invalid-input",
    );

    expect(error.detail).toContain("99");
  });
});

async function registeredRemote(
  role: "admin" | "operator" = "admin",
): Promise<{ home: string; key: OperatorKeyFile }> {
  const home = await scratch();

  if (role === "operator") {
    /* An operator-tier home only ever exists beside an admin: the first key of
       an installation is always an admin, whatever is asked for. */
    await trustOperator(clock.ctx, {
      id: "op-9999admin",
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

async function scratch(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "scafo-enroll-"));
  homes.push(home);
  return home;
}

/** A working directory holding no project configuration at all. */
function noConfig(): Promise<string | null> {
  return Promise.resolve(null);
}

/** Calls that reach the app in this process; the app may answer synchronously. */
function through(target: H3): typeof fetch {
  return async (input, init) => target.request(String(input), init);
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
      bindHost: "127.0.0.1",
    },
    observability: { enabled: false },
    api: { public: true, jsonBytes: 65_536 },
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
