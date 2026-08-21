/*
 * renderRoutes: which hosts a node answers on, given what it actually has
 * running. Pure throughout — no registry, no ingress, no processes.
 */

import { describe, expect, it } from "vitest";
import {
  APEX_ENVIRONMENT,
  FULL_WEIGHT,
  pickLeg,
  renderRoutes,
  type RenderRoutesInput,
  type RouteClaim,
  servingLegs,
} from "../src/core/placement/routes.ts";
import type { EnvironmentRecord, SplitEntry } from "../src/core/types/registry.ts";
import type { IngressBackend, IngressDesired, WeightedBackend } from "../src/core/types/ingress.ts";
import type { RuntimeProcess } from "../src/core/types/runtime.ts";
import { SLUG_MAX_LENGTH } from "../src/core/utils/slug.ts";

const DOMAIN = "apps.test";
const OTHER_DOMAIN = "apps.example";
const PROJECT = "shop";
const BUILD = "aaaa1111";
const OLDER = "bbbb2222";
const THIRD = "cccc3333";

describe("only what is ready is routed", () => {
  it("emits nothing for a process that has not passed its gate", () => {
    const desired = renderRoutes(
      input({
        environments: [environment(PROJECT, APEX_ENVIRONMENT, BUILD)],
        processes: [process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000, false)],
      }),
    );

    expect(desired.routes).toEqual([]);
  });

  it("emits nothing for an environment whose alias was never flipped", () => {
    const desired = renderRoutes(
      input({
        environments: [environment(PROJECT, "preview")],
        processes: [process(PROJECT, "preview", BUILD, 42_000, true)],
      }),
    );

    /* No alias means no environment host — but the build a running process
       serves is still reachable under its own hash. */
    expect(hosts(desired)).toEqual([`${PROJECT}--${BUILD}.${DOMAIN}`]);
  });
});

describe("the hosts an environment answers on", () => {
  it("gives production its own label and the project's apex", () => {
    const desired = renderRoutes(
      input({
        environments: [environment(PROJECT, APEX_ENVIRONMENT, BUILD)],
        processes: [process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000, true)],
      }),
    );

    /* Sorted by code unit, which puts "-" ahead of "." and so the labelled
       hosts ahead of the apex. */
    expect(hosts(desired)).toEqual([
      `${PROJECT}--${BUILD}.${DOMAIN}`,
      `${PROJECT}--${APEX_ENVIRONMENT}.${DOMAIN}`,
      `${PROJECT}.${DOMAIN}`,
    ]);
    for (const route of desired.routes) {
      /* One backend, and it carries the whole of the host's traffic: an
         environment with no split says so in the weighted shape too. */
      expect(route.backends).toEqual([
        {
          backend: { project: PROJECT, env: APEX_ENVIRONMENT, build: BUILD, port: 42_000 },
          weight: FULL_WEIGHT,
        },
      ]);
    }
  });

  it("gives every other environment its label and no apex", () => {
    const desired = renderRoutes(
      input({
        environments: [environment(PROJECT, "staging", BUILD)],
        processes: [process(PROJECT, "staging", BUILD, 42_010, true)],
      }),
    );

    expect(hosts(desired)).toEqual([
      `${PROJECT}--${BUILD}.${DOMAIN}`,
      `${PROJECT}--staging.${DOMAIN}`,
    ]);
  });

  it("repeats every host under each platform domain", () => {
    const desired = renderRoutes(
      input({
        platformDomains: [DOMAIN, OTHER_DOMAIN],
        environments: [environment(PROJECT, APEX_ENVIRONMENT, BUILD)],
        processes: [process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000, true)],
      }),
    );

    expect(hosts(desired)).toEqual([
      `${PROJECT}--${BUILD}.${OTHER_DOMAIN}`,
      `${PROJECT}--${BUILD}.${DOMAIN}`,
      `${PROJECT}--${APEX_ENVIRONMENT}.${OTHER_DOMAIN}`,
      `${PROJECT}--${APEX_ENVIRONMENT}.${DOMAIN}`,
      `${PROJECT}.${OTHER_DOMAIN}`,
      `${PROJECT}.${DOMAIN}`,
    ]);
  });
});

describe("build-hash routing", () => {
  it("keeps a superseded build reachable while its process still runs", () => {
    /* Mid-flip: the alias already names the new build and both processes are
       up, so the old one must stay inspectable under its own hash while the
       environment's own hosts have already moved. */
    const desired = renderRoutes(
      input({
        environments: [environment(PROJECT, APEX_ENVIRONMENT, BUILD)],
        processes: [
          process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000, true),
          process(PROJECT, APEX_ENVIRONMENT, OLDER, 42_002, true),
        ],
      }),
    );

    expect(backendOf(desired, `${PROJECT}.${DOMAIN}`)?.port).toBe(42_000);
    expect(backendOf(desired, `${PROJECT}--${BUILD}.${DOMAIN}`)?.port).toBe(42_000);
    expect(backendOf(desired, `${PROJECT}--${OLDER}.${DOMAIN}`)?.port).toBe(42_002);
  });

  it("leaves the environment's own hosts to the alias when a build id would collide", () => {
    /* An environment may legally be named the same as some build. The alias
       owns the label; the hash route for that build simply has nowhere to go. */
    const desired = renderRoutes(
      input({
        environments: [environment(PROJECT, OLDER, BUILD)],
        processes: [
          process(PROJECT, OLDER, BUILD, 42_000, true),
          process(PROJECT, "preview", OLDER, 42_004, true),
        ],
      }),
    );

    expect(backendOf(desired, `${PROJECT}--${OLDER}.${DOMAIN}`)).toMatchObject({
      env: OLDER,
      build: BUILD,
      port: 42_000,
    });
  });
});

describe("custom domains", () => {
  it("routes a claim to the environment's alias backend", () => {
    const desired = renderRoutes(
      input({
        environments: [environment(PROJECT, APEX_ENVIRONMENT, BUILD, ["shop.example"])],
        processes: [process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000, true)],
        claims: [{ host: "shop.example", project: PROJECT, environment: APEX_ENVIRONMENT }],
      }),
    );

    expect(backendOf(desired, "shop.example")).toEqual({
      project: PROJECT,
      env: APEX_ENVIRONMENT,
      build: BUILD,
      port: 42_000,
    });
  });

  it("drops a claim whose environment has nothing ready to serve it", () => {
    const desired = renderRoutes(
      input({
        environments: [environment(PROJECT, APEX_ENVIRONMENT, BUILD, ["shop.example"])],
        processes: [process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000, false)],
        claims: [{ host: "shop.example", project: PROJECT, environment: APEX_ENVIRONMENT }],
      }),
    );

    expect(hosts(desired)).toEqual([]);
  });
});

describe("an environment with a traffic split", () => {
  const NINETY_TEN: SplitEntry[] = [
    { build: BUILD, weight: 90 },
    { build: OLDER, weight: 10 },
  ];

  it("divides its own hosts between the legs, in the order the registry states them", () => {
    const desired = renderRoutes(
      input({
        environments: [environment(PROJECT, APEX_ENVIRONMENT, BUILD, [], NINETY_TEN)],
        processes: [
          process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000, true),
          process(PROJECT, APEX_ENVIRONMENT, OLDER, 42_002, true),
        ],
      }),
    );

    for (const host of [`${PROJECT}--${APEX_ENVIRONMENT}.${DOMAIN}`, `${PROJECT}.${DOMAIN}`]) {
      expect(weightsOf(desired, host), host).toEqual([`${BUILD}:90`, `${OLDER}:10`]);
    }
  });

  it("leaves the build-hash hosts single-backend, so each leg stays addressable alone", () => {
    const desired = renderRoutes(
      input({
        environments: [environment(PROJECT, APEX_ENVIRONMENT, BUILD, [], NINETY_TEN)],
        processes: [
          process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000, true),
          process(PROJECT, APEX_ENVIRONMENT, OLDER, 42_002, true),
        ],
      }),
    );

    expect(weightsOf(desired, `${PROJECT}--${BUILD}.${DOMAIN}`)).toEqual([`${BUILD}:100`]);
    expect(weightsOf(desired, `${PROJECT}--${OLDER}.${DOMAIN}`)).toEqual([`${OLDER}:100`]);
  });

  it("weights a claimed custom domain exactly as it weights the environment host", () => {
    const desired = renderRoutes(
      input({
        environments: [environment(PROJECT, APEX_ENVIRONMENT, BUILD, ["shop.example"], NINETY_TEN)],
        processes: [
          process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000, true),
          process(PROJECT, APEX_ENVIRONMENT, OLDER, 42_002, true),
        ],
        claims: [{ host: "shop.example", project: PROJECT, environment: APEX_ENVIRONMENT }],
      }),
    );

    expect(weightsOf(desired, "shop.example")).toEqual([`${BUILD}:90`, `${OLDER}:10`]);
  });

  it("hands a leg's share to the ready ones while it is still coming up", () => {
    /* A SPLIT IS A ROUTING PREFERENCE; AN OUTAGE IS NOT ONE OF THE OPTIONS. The
       10% leg has not passed its gate — the pass that started it, or a restart —
       so all 100 goes to the leg that has, rather than a tenth of the requests
       being sent at a port nothing answers on. */
    const desired = renderRoutes(
      input({
        environments: [environment(PROJECT, APEX_ENVIRONMENT, BUILD, [], NINETY_TEN)],
        processes: [
          process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000, true),
          process(PROJECT, APEX_ENVIRONMENT, OLDER, 42_002, false),
        ],
      }),
    );

    expect(weightsOf(desired, `${PROJECT}.${DOMAIN}`)).toEqual([`${BUILD}:100`]);
    /* And the leg that is not ready is routed nowhere at all, not even under its
       own hash: readiness decides that, and a split does not change it. */
    expect(hosts(desired)).not.toContain(`${PROJECT}--${OLDER}.${DOMAIN}`);
  });

  it("redistributes in proportion, and still sums to 100", () => {
    const desired = renderRoutes(
      input({
        environments: [
          environment(
            PROJECT,
            APEX_ENVIRONMENT,
            BUILD,
            [],
            [
              { build: BUILD, weight: 50 },
              { build: OLDER, weight: 30 },
              { build: THIRD, weight: 20 },
            ],
          ),
        ],
        processes: [
          process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000, true),
          /* The 30 is out; 50 and 20 share its work in the ratio they had. */
          process(PROJECT, APEX_ENVIRONMENT, OLDER, 42_002, false),
          process(PROJECT, APEX_ENVIRONMENT, THIRD, 42_004, true),
        ],
      }),
    );

    expect(weightsOf(desired, `${PROJECT}.${DOMAIN}`)).toEqual([`${BUILD}:71`, `${THIRD}:29`]);
    const total = (backendsOf(desired, `${PROJECT}.${DOMAIN}`) ?? []).reduce(
      (sum, leg) => sum + leg.weight,
      0,
    );
    expect(total).toBe(FULL_WEIGHT);
  });

  it("renders nothing for the environment when no leg is ready at all", () => {
    const desired = renderRoutes(
      input({
        environments: [environment(PROJECT, APEX_ENVIRONMENT, BUILD, [], NINETY_TEN)],
        processes: [
          process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000, false),
          process(PROJECT, APEX_ENVIRONMENT, OLDER, 42_002, false),
        ],
      }),
    );

    expect(hosts(desired)).toEqual([]);
  });

  it("serves the split rather than the alias when the alias is not one of the legs", () => {
    /* The alias is untouched by a split and stays the rollback target, so a
       build it names that is not a leg keeps running and stays reachable under
       its own hash — it simply takes none of the environment's traffic. */
    const desired = renderRoutes(
      input({
        environments: [
          environment(
            PROJECT,
            APEX_ENVIRONMENT,
            THIRD,
            [],
            [
              { build: BUILD, weight: 60 },
              { build: OLDER, weight: 40 },
            ],
          ),
        ],
        processes: [
          process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000, true),
          process(PROJECT, APEX_ENVIRONMENT, OLDER, 42_002, true),
          process(PROJECT, APEX_ENVIRONMENT, THIRD, 42_004, true),
        ],
      }),
    );

    expect(weightsOf(desired, `${PROJECT}.${DOMAIN}`)).toEqual([`${BUILD}:60`, `${OLDER}:40`]);
    expect(weightsOf(desired, `${PROJECT}--${THIRD}.${DOMAIN}`)).toEqual([`${THIRD}:100`]);
  });

  it("weights a build named twice once, at the sum of its legs", () => {
    const desired = renderRoutes(
      input({
        environments: [
          environment(
            PROJECT,
            APEX_ENVIRONMENT,
            BUILD,
            [],
            [
              { build: BUILD, weight: 40 },
              { build: OLDER, weight: 20 },
              { build: BUILD, weight: 40 },
            ],
          ),
        ],
        processes: [
          process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000, true),
          process(PROJECT, APEX_ENVIRONMENT, OLDER, 42_002, true),
        ],
      }),
    );

    /* Dialling the same process twice at part of its weight would say the same
       thing in a shape a driver has to be careful with. */
    expect(weightsOf(desired, `${PROJECT}.${DOMAIN}`)).toEqual([`${BUILD}:80`, `${OLDER}:20`]);
  });

  it("renders the same weights whatever order the processes arrive in", () => {
    const environments = [environment(PROJECT, APEX_ENVIRONMENT, BUILD, [], NINETY_TEN)];
    const processes = [
      process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000, true),
      process(PROJECT, APEX_ENVIRONMENT, OLDER, 42_002, true),
    ];

    const forwards = renderRoutes(input({ environments, processes }));
    const backwards = renderRoutes(input({ environments, processes: [...processes].reverse() }));

    expect(backwards).toEqual(forwards);
  });
});

describe("labels that do not fit", () => {
  it("skips the host that overflows and keeps the ones that do not", () => {
    /* `project--production` is over the DNS label limit here, while the apex
       host and the label of a shorter environment are both still buildable. */
    const long = "p".repeat(SLUG_MAX_LENGTH - 5);
    expect(`${long}--${APEX_ENVIRONMENT}`.length).toBeGreaterThan(SLUG_MAX_LENGTH);

    const desired = renderRoutes(
      input({
        environments: [environment(long, APEX_ENVIRONMENT, BUILD)],
        processes: [process(long, APEX_ENVIRONMENT, BUILD, 42_000, true)],
      }),
    );

    expect(hosts(desired)).toEqual([`${long}.${DOMAIN}`]);
  });
});

describe("the hosts a parked environment holds open", () => {
  const AGENT_PORT = 7400;
  const CUSTOM = "shop.example";

  it("claims its label under every platform domain, and the apex when it has one", () => {
    const desired = renderRoutes(
      input({
        platformDomains: [DOMAIN, OTHER_DOMAIN],
        wake: { port: AGENT_PORT, parked: [environment(PROJECT, APEX_ENVIRONMENT, BUILD)] },
      }),
    );

    /* Nothing is running for it, so it has no routes at all — its hosts name
       the node's own agent, to be woken by the request that asked for them. */
    expect(desired.routes).toEqual([]);
    expect(desired.wake).toEqual({
      port: AGENT_PORT,
      hosts: [
        `${PROJECT}--${APEX_ENVIRONMENT}.${OTHER_DOMAIN}`,
        `${PROJECT}--${APEX_ENVIRONMENT}.${DOMAIN}`,
        `${PROJECT}.${OTHER_DOMAIN}`,
        `${PROJECT}.${DOMAIN}`,
      ],
      domains: [DOMAIN, OTHER_DOMAIN],
    });
  });

  it("gives every other environment its label and no apex", () => {
    const desired = renderRoutes(
      input({ wake: { port: AGENT_PORT, parked: [environment(PROJECT, "preview", BUILD)] } }),
    );

    expect(desired.wake?.hosts).toEqual([`${PROJECT}--preview.${DOMAIN}`]);
  });

  it("claims every custom domain its record mirrors", () => {
    /* A parked environment is reached by its custom names exactly as it is by
       its own, and the record mirrors every domain claimed for it. */
    const desired = renderRoutes(
      input({
        wake: {
          port: AGENT_PORT,
          parked: [environment(PROJECT, "preview", BUILD, [CUSTOM, `www.${CUSTOM}`])],
        },
      }),
    );

    expect(desired.wake?.hosts).toEqual([`${PROJECT}--preview.${DOMAIN}`, CUSTOM, `www.${CUSTOM}`]);
  });

  it("sorts and deduplicates, whatever order the parked records arrive in", () => {
    const parked = [
      environment(PROJECT, "preview", BUILD, [CUSTOM]),
      environment(PROJECT, "staging", BUILD, [CUSTOM]),
    ];
    const wakeOf = (records: typeof parked): string[] =>
      renderRoutes(
        input({
          platformDomains: [DOMAIN, OTHER_DOMAIN],
          wake: { port: AGENT_PORT, parked: records },
        }),
      ).wake?.hosts ?? [];

    /* A claim that has moved between environments is mirrored by both records
       until the one it left is rewritten; it is one host either way. */
    const forwards = wakeOf(parked);
    expect(wakeOf([...parked].reverse())).toEqual(forwards);
    expect(forwards).toEqual([...new Set(forwards)].sort());
    expect(forwards.filter((host) => host === CUSTOM)).toHaveLength(1);
  });

  it("leaves a host to the process already answering on it", () => {
    /*
     * Mid-wake, and the two overlap for a whole pass: the record still reads
     * parked to a node that has not re-read it, while the process it started is
     * already ready. The ready process is the better answer of the two — routing
     * the host to the agent would hold a request for something that is up.
     */
    const parked = environment(PROJECT, APEX_ENVIRONMENT, BUILD, [CUSTOM]);
    const desired = renderRoutes(
      input({
        environments: [parked],
        processes: [process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000, true)],
        wake: { port: AGENT_PORT, parked: [parked] },
      }),
    );

    expect(hosts(desired)).toEqual([
      `${PROJECT}--${BUILD}.${DOMAIN}`,
      `${PROJECT}--${APEX_ENVIRONMENT}.${DOMAIN}`,
      `${PROJECT}.${DOMAIN}`,
    ]);
    /* No claim was passed for the custom domain, so nothing routes it and it is
       the one host still held open. */
    expect(desired.wake?.hosts).toEqual([CUSTOM]);
    for (const host of hosts(desired)) expect(desired.wake?.hosts).not.toContain(host);
  });

  it("mirrors the platform domains it was given, in the order it was given them", () => {
    const platformDomains = [DOMAIN, OTHER_DOMAIN];

    const desired = renderRoutes(
      input({ platformDomains, wake: { port: AGENT_PORT, parked: [] } }),
    );

    expect(desired.wake?.domains).toEqual(platformDomains);
    /* A copy: a routing a caller is holding must not change when the node's own
       configuration array does. */
    expect(desired.wake?.domains).not.toBe(platformDomains);
  });

  it("holds the domains open with nothing parked at all", () => {
    const desired = renderRoutes(input({ wake: { port: AGENT_PORT, parked: [] } }));

    /* An unmatched host under a platform domain is a name scafo knows nothing
       about, and the agent answers it 404 — which is why the domains are routed
       at all rather than left to whatever the ingress does with an unknown host. */
    expect(desired.wake).toEqual({ port: AGENT_PORT, hosts: [], domains: [DOMAIN] });
  });
});

describe("a routing rendered with no wake at all", () => {
  it("carries no wake member, which is what scafo rendered before this existed", () => {
    const desired = renderRoutes(
      input({
        environments: [environment(PROJECT, APEX_ENVIRONMENT, BUILD, ["shop.example"])],
        processes: [process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000, true)],
        claims: [{ host: "shop.example", project: PROJECT, environment: APEX_ENVIRONMENT }],
      }),
    );

    /* A caller with no agent address to hand out renders routes and nothing
       else — not an empty wake, which would claim the platform domains. */
    expect(Object.keys(desired)).toEqual(["routes"]);
    expect(hosts(desired)).toEqual([
      `${PROJECT}--${BUILD}.${DOMAIN}`,
      `${PROJECT}--${APEX_ENVIRONMENT}.${DOMAIN}`,
      `${PROJECT}.${DOMAIN}`,
      "shop.example",
    ]);
  });
});

describe("determinism", () => {
  it("renders the same routing whatever order its inputs arrive in", () => {
    const environments = [
      environment("alpha", APEX_ENVIRONMENT, BUILD),
      environment("beta", "staging", OLDER),
      environment(PROJECT, APEX_ENVIRONMENT, BUILD, ["shop.example"]),
    ];
    const processes = [
      process("alpha", APEX_ENVIRONMENT, BUILD, 42_000, true),
      process("beta", "staging", OLDER, 42_002, true),
      process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_004, true),
    ];
    const claims: RouteClaim[] = [
      { host: "shop.example", project: PROJECT, environment: APEX_ENVIRONMENT },
    ];

    const forwards = renderRoutes(input({ environments, processes, claims }));
    const backwards = renderRoutes(
      input({
        environments: [...environments].reverse(),
        processes: [...processes].reverse(),
        claims: [...claims].reverse(),
      }),
    );

    expect(backwards).toEqual(forwards);
    expect(hosts(forwards)).toEqual([...hosts(forwards)].sort());
    expect(hosts(forwards)).toContain("shop.example");
  });
});

/*
 * The seam the agent's wake surface answers from, so that what serves an
 * environment is decided ONCE. A wake holds a single request and hands it to one
 * leg, where an ingress load-balances a stream of them across all of them, but
 * both read the same legs and the same weights — that is the whole point of the
 * export.
 */
describe("the legs one held request is answered from", () => {
  const SPLIT: SplitEntry[] = [
    { build: BUILD, weight: 90 },
    { build: OLDER, weight: 10 },
  ];
  const both = [
    process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000, true),
    process(PROJECT, APEX_ENVIRONMENT, OLDER, 42_002, true),
  ];

  it("gives the very legs the environment's own hosts are rendered with", () => {
    const { project, env } = environment(PROJECT, APEX_ENVIRONMENT, BUILD, [], SPLIT);
    const processes = [
      /* Unsorted, and carrying a build the split does not name: the same
         filtering the render does, because it IS the render's. */
      process(PROJECT, APEX_ENVIRONMENT, OLDER, 42_002, true),
      process(PROJECT, APEX_ENVIRONMENT, THIRD, 42_004, true),
      process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000, true),
    ];
    const desired = renderRoutes(input({ environments: [{ project, env }], processes }));

    const legs = servingLegs(project, env, processes);

    expect(legs).toEqual(backendsOf(desired, `${PROJECT}.${DOMAIN}`));
    expect(legs.map((leg) => `${leg.backend.build}:${String(leg.weight)}`)).toEqual([
      `${BUILD}:90`,
      `${OLDER}:10`,
    ]);
  });

  it("gives nothing when no leg is ready, which is what a wake falls through on", () => {
    const { project, env } = environment(PROJECT, APEX_ENVIRONMENT, BUILD);

    expect(servingLegs(project, env, [])).toEqual([]);
    expect(
      servingLegs(project, env, [process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000, false)]),
    ).toEqual([]);
  });

  it("walks the shares in the order the legs are stated", () => {
    const { project, env } = environment(PROJECT, APEX_ENVIRONMENT, BUILD, [], SPLIT);
    const legs = servingLegs(project, env, both);

    /* 90/10: every draw below 0.9 takes the first leg and every draw from it the
       second, which over many of them is the distribution the weights state. */
    expect(taken(legs, [0, 0.5, 0.899])).toEqual([BUILD, BUILD, BUILD]);
    expect(taken(legs, [0.9, 0.95, 0.999])).toEqual([OLDER, OLDER, OLDER]);
  });

  it("names a leg for a draw off either end, rather than nothing", () => {
    const { project, env } = environment(PROJECT, APEX_ENVIRONMENT, BUILD, [], SPLIT);

    expect(taken(servingLegs(project, env, both), [-1, 1, 2])).toEqual([BUILD, OLDER, OLDER]);
  });

  it("has nothing to pick from when there are no legs", () => {
    expect(pickLeg([], 0.5)).toBeUndefined();
  });
});

function input(overrides: Partial<RenderRoutesInput>): RenderRoutesInput {
  return {
    platformDomains: [DOMAIN],
    environments: [],
    processes: [],
    claims: [],
    ...overrides,
  };
}

function environment(
  project: string,
  name: string,
  build?: string,
  domains: string[] = [],
  split: SplitEntry[] | null = null,
): { project: string; env: EnvironmentRecord } {
  return {
    project,
    env: {
      v: 1,
      name,
      prefix: `fleets/${project}/${name}`,
      alias: build === undefined ? null : { build, flippedAt: "2026-01-01T00:00:00.000Z" },
      split,
      domains,
      placement: "auto",
      ephemeral: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

function process(
  project: string,
  env: string,
  build: string,
  port: number,
  ready: boolean,
): RuntimeProcess {
  return {
    processId: `${project}--${env}--${build}`,
    project,
    env,
    build,
    port,
    internalPort: port + 1,
    ready,
  };
}

function hosts(desired: IngressDesired): string[] {
  return desired.routes.map((route) => route.host);
}

/** The one backend a single-backend host reaches. */
function backendOf(desired: IngressDesired, host: string): IngressBackend | undefined {
  const backends = backendsOf(desired, host);
  expect(backends, host).toHaveLength(1);
  return backends?.[0]?.backend;
}

/** What a host divides its traffic between, as `build:weight` in rendered order. */
function weightsOf(desired: IngressDesired, host: string): string[] {
  return (backendsOf(desired, host) ?? []).map(
    (leg) => `${leg.backend.build}:${String(leg.weight)}`,
  );
}

function backendsOf(
  desired: IngressDesired,
  host: string,
): IngressDesired["routes"][number]["backends"] | undefined {
  return desired.routes.find((route) => route.host === host)?.backends;
}

/** The build each draw takes, in order. */
function taken(legs: WeightedBackend[], draws: number[]): Array<string | undefined> {
  return draws.map((draw) => pickLeg(legs, draw)?.backend.build);
}
