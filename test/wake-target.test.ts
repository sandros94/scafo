/*
 * What a request's Host asks this node to wake, and every way it asks for
 * nothing.
 *
 * THE HOST GRAMMAR IS THE EXACT INVERSE OF WHAT THE ROUTING RENDERS, so the
 * cases below are the routing's own kinds of host read backwards: a project's
 * apex, an environment's label, a build's own hash, and a custom domain a parked
 * environment claimed.
 *
 * NULL IS THE ONLY FAILURE, and the matrix exists because the ways of arriving
 * at it must stay indistinguishable from outside: a name that never existed, an
 * environment that was retired, a build the reaper has taken, one whose record
 * predates recall, and one whose environment has recall turned off are one
 * answer. The registry is a memory store seeded through the registry API itself.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { ParkedEnvironment } from "../src/daemon/_desired.ts";
import { resolveWakeTarget, type WakeTarget } from "../src/daemon/_wake-target.ts";
import { APEX_ENVIRONMENT } from "../src/core/placement/routes.ts";
import {
  claimDomain,
  createBuild,
  createEnvironment,
  createProject,
  DEFAULT_BUILD_IDLE_S,
  flipAlias,
  getBuild,
  getEnvironment,
  resolveParkPolicy,
  retireEnvironment,
  setParkPolicy,
  stampBuildWake,
} from "../src/core/registry/index.ts";
import type { EnvironmentRecord } from "../src/core/types/registry.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock } from "./_helpers.ts";

const DOMAIN = "apps.test";
const OTHER_DOMAIN = "apps.example";
const PROJECT = "shop";
const PREVIEW = "preview";
const BUILD = "aaaa1111";
/** The build a flip left behind: what a build-hash host recalls. */
const SUPERSEDED = "bbbb2222";
const CUSTOM = "shop.example.com";

let clock: ManualClock;

beforeEach(async () => {
  clock = ctxWith(new MemoryCasStore());
  await createProject(clock.ctx, { slug: PROJECT });
});

describe("a host under a platform domain", () => {
  it("reads the apex as the project's production environment", async () => {
    const production = await deployed(APEX_ENVIRONMENT);

    await expect(resolve(`${PROJECT}.${DOMAIN}`)).resolves.toEqual({
      kind: "environment",
      project: PROJECT,
      env: production,
      policy: resolveParkPolicy(production),
    });
  });

  it("reads a label as that environment of that project", async () => {
    const preview = await deployed(PREVIEW);

    await expect(resolve(`${PROJECT}--${PREVIEW}.${DOMAIN}`)).resolves.toEqual({
      kind: "environment",
      project: PROJECT,
      env: preview,
      policy: resolveParkPolicy(preview),
    });
  });

  it("answers the same under every platform domain this installation serves", async () => {
    await deployed(PREVIEW);

    for (const domain of [DOMAIN, OTHER_DOMAIN]) {
      const target = await resolve(`${PROJECT}--${PREVIEW}.${domain}`);
      expect(target, domain).toMatchObject({ kind: "environment", env: { name: PREVIEW } });
    }
  });

  it("prefers the ENVIRONMENT when a build id is also an environment name", async () => {
    /* An environment may legally be named the same as some build. The label was
       rendered from the environment first, so it is read back that way, and the
       build's own host simply has nowhere to go. */
    const named = await deployed(SUPERSEDED);
    await deployed(PREVIEW, SUPERSEDED);

    const target = await resolve(`${PROJECT}--${SUPERSEDED}.${DOMAIN}`);

    expect(named.name).toBe(SUPERSEDED);
    expect(target).toMatchObject({ kind: "environment", env: { name: SUPERSEDED } });
  });

  it("reads a build hash as that build, once nothing answers to it as an environment", async () => {
    const preview = await deployed(PREVIEW);
    await recorded(SUPERSEDED, PREVIEW);

    /* Recalling a superseded build means starting a process against the fleet
       holding its code, and the build record is the only thing that says which
       fleet that is — which is why the target carries the environment too. */
    await expect(resolve(`${PROJECT}--${SUPERSEDED}.${DOMAIN}`)).resolves.toEqual({
      kind: "build",
      project: PROJECT,
      env: preview,
      build: await getBuild(clock.ctx, PROJECT, SUPERSEDED),
      policy: resolveParkPolicy(preview),
    });
  });

  it("never reads an apex host as a build", async () => {
    /* An apex host has no second half to read as one, so a project with no
       production environment is a 404 rather than a hunt through its builds. */
    await recorded(BUILD, PREVIEW);

    await expect(resolve(`${PROJECT}.${DOMAIN}`)).resolves.toBeNull();
  });

  it.each([
    [`${PROJECT}--ghost.${DOMAIN}`, "a name no environment and no build answers to"],
    [`${PROJECT}--deadbeef.${DOMAIN}`, "a build id nothing was ever recorded under"],
    [`ghost--${PREVIEW}.${DOMAIN}`, "a project that does not exist"],
    [`a--b--c.${DOMAIN}`, "a label with too many halves"],
    [`NOTALABEL.${DOMAIN}`, "a label that is not a slug"],
    [`${PROJECT}--${PREVIEW}.elsewhere.test`, "a domain this installation does not serve"],
    [DOMAIN, "the platform domain itself, which is nobody's project"],
  ])("answers nothing for %s — %s", async (host) => {
    await deployed(PREVIEW);

    await expect(resolve(host)).resolves.toBeNull();
  });
});

describe("an environment there is no point waking", () => {
  it("refuses a retired one rather than holding a request for it", async () => {
    /* On its way out: no node will start anything for it, however hard the
       request asks, so it is a 404 rather than a request held to the deadline. */
    await deployed(PREVIEW);
    await retireEnvironment(clock.ctx, PROJECT, PREVIEW);

    await expect(resolve(`${PROJECT}--${PREVIEW}.${DOMAIN}`)).resolves.toBeNull();
  });

  it("refuses one whose alias was never flipped", async () => {
    /* There is no build to serve at its own hosts, so waking it would achieve
       nothing. */
    await createEnvironment(clock.ctx, PROJECT, { name: PREVIEW, ephemeral: true });

    await expect(resolve(`${PROJECT}--${PREVIEW}.${DOMAIN}`)).resolves.toBeNull();
  });

  it("takes one whose alias was never flipped but has a build inside its window", async () => {
    /* The same outcome for a different reason, and the one exception: a build
       somebody woke is a process this node will start, and it does answer. */
    await createEnvironment(clock.ctx, PROJECT, { name: PREVIEW, ephemeral: true });
    await recorded(SUPERSEDED, PREVIEW);
    await stampBuildWake(clock.ctx, PROJECT, PREVIEW, SUPERSEDED);

    await expect(resolve(`${PROJECT}--${PREVIEW}.${DOMAIN}`)).resolves.toMatchObject({
      kind: "environment",
      env: { name: PREVIEW, alias: null },
    });
  });

  it("refuses one whose recalled build has aged out of its window", async () => {
    await createEnvironment(clock.ctx, PROJECT, { name: PREVIEW, ephemeral: true });
    await recorded(SUPERSEDED, PREVIEW);
    await stampBuildWake(clock.ctx, PROJECT, PREVIEW, SUPERSEDED);

    clock.tick(DEFAULT_BUILD_IDLE_S * 1000);

    await expect(resolve(`${PROJECT}--${PREVIEW}.${DOMAIN}`)).resolves.toBeNull();
  });

  it("refuses one whose fresh stamp names a build the reaper has taken", async () => {
    /* The record is READ rather than trusted: a stamp outlives the build it
       named, and one pointing at nothing wakes nothing. */
    await createEnvironment(clock.ctx, PROJECT, { name: PREVIEW, ephemeral: true });
    await stampBuildWake(clock.ctx, PROJECT, PREVIEW, "deadbeef");

    await expect(resolve(`${PROJECT}--${PREVIEW}.${DOMAIN}`)).resolves.toBeNull();
  });

  it("refuses one whose fresh stamp is under a policy that recalls nothing", async () => {
    await createEnvironment(clock.ctx, PROJECT, { name: PREVIEW, ephemeral: true });
    await recorded(SUPERSEDED, PREVIEW);
    await stampBuildWake(clock.ctx, PROJECT, PREVIEW, SUPERSEDED);
    await setParkPolicy(clock.ctx, PROJECT, PREVIEW, { recallBuilds: false });

    await expect(resolve(`${PROJECT}--${PREVIEW}.${DOMAIN}`)).resolves.toBeNull();
  });
});

describe("a build hash that recalls nothing", () => {
  it("refuses a build whose record does not say which fleet holds its code", async () => {
    /* A record that predates recall. Its host answers 404 rather than starting a
       process against a guess. */
    await deployed(PREVIEW);
    await createBuild(clock.ctx, PROJECT, { id: SUPERSEDED, runtimeConfigurable: true });

    await expect(resolve(`${PROJECT}--${SUPERSEDED}.${DOMAIN}`)).resolves.toBeNull();
  });

  it("refuses a build whose environment is gone", async () => {
    await recorded(SUPERSEDED, "ghost");

    await expect(resolve(`${PROJECT}--${SUPERSEDED}.${DOMAIN}`)).resolves.toBeNull();
  });

  it("refuses a build whose environment has been retired", async () => {
    await deployed(PREVIEW);
    await recorded(SUPERSEDED, PREVIEW);
    await retireEnvironment(clock.ctx, PROJECT, PREVIEW);

    await expect(resolve(`${PROJECT}--${SUPERSEDED}.${DOMAIN}`)).resolves.toBeNull();
  });

  it.each([{ recallBuilds: false }, { buildIdleS: 0 }])(
    "refuses one whose environment says %p",
    async (policy) => {
      /* `recallBuilds`, or a `buildIdleS` of zero, which is the same statement
         made with a clock. */
      await deployed(PREVIEW);
      await recorded(SUPERSEDED, PREVIEW);
      await setParkPolicy(clock.ctx, PROJECT, PREVIEW, policy);

      await expect(resolve(`${PROJECT}--${SUPERSEDED}.${DOMAIN}`)).resolves.toBeNull();
    },
  );
});

describe("a custom domain", () => {
  it("wakes the parked environment whose record mirrors it", async () => {
    const parked = await claimed(PREVIEW);

    await expect(resolve(CUSTOM, [{ project: PROJECT, env: parked }])).resolves.toEqual({
      kind: "environment",
      project: PROJECT,
      env: parked,
      policy: resolveParkPolicy(parked),
    });
  });

  it("answers nothing for one no parked record lists", async () => {
    /* A custom domain is only wakeable while the environment holding it is one
       this node reads as parked: nothing else claims a name scafo did not mint,
       and a claimed domain whose environment is up is served by that process. */
    await claimed(PREVIEW);

    await expect(resolve(CUSTOM)).resolves.toBeNull();
  });

  it("answers nothing for a host under no platform domain and no parked record", async () => {
    const parked = await claimed(PREVIEW);

    await expect(
      resolve("something.elsewhere.test", [{ project: PROJECT, env: parked }]),
    ).resolves.toBeNull();
  });
});

/** Resolves `host` against this installation's platform domains and parked list. */
function resolve(host: string, parked: ParkedEnvironment[] = []): Promise<WakeTarget | null> {
  return resolveWakeTarget(clock.ctx, { host, platformDomains: [DOMAIN, OTHER_DOMAIN], parked });
}

/** An ephemeral environment of the seeded project, with a build flipped onto it. */
async function deployed(name: string, build: string = BUILD): Promise<EnvironmentRecord> {
  await createEnvironment(clock.ctx, PROJECT, { name, ephemeral: true });
  await recorded(build, name);
  await flipAlias(clock.ctx, PROJECT, name, build);
  return getEnvironment(clock.ctx, PROJECT, name);
}

/** A build recorded against the fleet of `env`, which is what makes it recallable. */
async function recorded(build: string, env: string): Promise<void> {
  await createBuild(clock.ctx, PROJECT, {
    id: build,
    runtimeConfigurable: true,
    environment: env,
  });
}

/** A deployed environment with {@link CUSTOM} claimed for it, read back. */
async function claimed(name: string): Promise<EnvironmentRecord> {
  await deployed(name);
  await claimDomain(clock.ctx, CUSTOM, PROJECT, name);
  return getEnvironment(clock.ctx, PROJECT, name);
}
