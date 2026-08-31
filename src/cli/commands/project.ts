/*
 * `scafo project`: the things being hosted.
 *
 * A project is what an installation exists to serve — a namespace holding
 * builds, environments and a trust policy — and it comes into being on the first
 * deploy that names it rather than through a create verb here. So this group is
 * about projects that already exist: what there is, what state each is in, and
 * the two statements an ADMIN can make about one.
 *
 * BLOCK IS THE VERB WORTH READING TWICE. It is a full stop: a blocked project is
 * served nowhere in the fleet, its hosts leave ingress, it gets no certificates
 * and it accepts no deploys — while every build, environment, deployment notice and domain
 * it has is left exactly where it was. Unblocking is one call, and the next pass
 * of every node puts it all back. It is admin-only, and deliberately: the case
 * it exists for is a platform stopping a project it hosts, which is precisely
 * the case where the project's own operator would rather it did not.
 *
 * LABEL IS THE OTHER HALF OF THAT STORY and stops nothing. Labels are free-form
 * `k=v` pairs scafo stores and never reads — a billing account, a client's name,
 * a plan — so that a platform built over scafo can tag a project machine to
 * machine and read it back through the API it already talks to.
 *
 * Everything here reaches an installation through a NODE, on the authority of an
 * operator key. There is no bucket path, unlike `scafo env`: see `_projects.ts`.
 */

import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import { ScafoError } from "../../core/error.ts";
import type { ProjectRecord } from "../../core/types/registry.ts";
import { nodeBaseUrl, operatorSigner } from "../_node.ts";
import { resolveOperatorHome } from "../_home.ts";
import { OPERATOR_KEY_FORMS, operatorFlags, resolveOperator } from "../_operator.ts";
import {
  formatProject,
  formatProjectTable,
  type ProjectApi,
  projectApi,
  readLabelArgs,
} from "../_projects.ts";
import { readTextFile, reportFailure } from "../_utils.ts";

/* Which installation this invocation reaches, and with what. The same four the
   other wire-only commands take. */
const remoteArgs: ArgsDef = {
  config: { type: "string", description: "Path to scafo.config.jsonc, read for its remote pin" },
  remote: { type: "string", description: "Remote to act on, out of this operator's home" },
  node: { type: "string", description: "Node to reach, instead of the remote's first endpoint" },
  key: { type: "string", description: `Operator key to sign with: ${OPERATOR_KEY_FORMS}` },
};

const listArgs: ArgsDef = {
  ...remoteArgs,
  json: { type: "boolean", description: "Print the records as JSON instead of a table" },
};

const slugArgs: ArgsDef = {
  ...remoteArgs,
  slug: { type: "positional", required: true, description: "Project to act on" },
};

const labelArgs: ArgsDef = {
  ...slugArgs,
  pairs: {
    type: "positional",
    required: false,
    description: "Labels as key=value pairs, REPLACING every label the project carries",
  },
};

const list: CommandDef = defineCommand({
  meta: {
    name: "list",
    description: "List the projects this key reaches, and which of them are blocked",
  },
  args: listArgs,
  run: guarded(runList),
});

const show: CommandDef = defineCommand({
  meta: { name: "show", description: "Show one project: its state, when it began, its labels" },
  args: slugArgs,
  run: guarded(runShow),
});

const block: CommandDef = defineCommand({
  meta: {
    name: "block",
    description: "Stop serving and deploying a project, reversibly (admin only)",
  },
  args: slugArgs,
  run: guarded(runBlock),
});

const unblock: CommandDef = defineCommand({
  meta: {
    name: "unblock",
    description: "Put a blocked project back into service (admin only)",
  },
  args: slugArgs,
  run: guarded(runUnblock),
});

const label: CommandDef = defineCommand({
  meta: {
    name: "label",
    description: "Replace a project's labels, which scafo stores and never reads (admin only)",
  },
  args: labelArgs,
  run: guarded(runLabel),
});

export const project: CommandDef = defineCommand({
  meta: {
    name: "project",
    description: "The things this installation hosts: list, inspect, block and label them",
  },
  subCommands: { list, show, block, unblock, label },
});

/* ---------------------------------------------------------------- internals */

async function runList(flags: Record<string, unknown>): Promise<void> {
  const api = await apiFor(flags);
  const listing = await api.list();

  console.log(flags.json === true ? JSON.stringify(listing, null, 2) : formatProjectTable(listing));
}

async function runShow(flags: Record<string, unknown>): Promise<void> {
  const slug = required(flags, "slug");
  const api = await apiFor(flags);

  /*
   * Read out of the LISTING rather than through a route of its own, because the
   * listing is already narrowed to what this key reaches: a project the caller
   * cannot see is simply not in it, and reads as "no such project" without a
   * second surface having to decide what to disclose.
   */
  const found = (await api.list()).projects.find((entry) => entry.slug === slug);
  if (found === undefined) {
    throw new ScafoError("not-found", "No such project", {
      detail: `nothing this key reaches through ${api.via} is called "${slug}"`,
    });
  }
  console.log(formatProject(found));
}

async function runBlock(flags: Record<string, unknown>): Promise<void> {
  const slug = required(flags, "slug");
  const api = await apiFor(flags);
  const blocked = await api.block(slug);

  console.log(
    `scafo: blocked "${blocked.slug}" through ${api.via}; every node stops serving it on its ` +
      `next pass, its hosts leave ingress and it accepts no deploys — nothing of it has ` +
      `been deleted, and "scafo project unblock ${blocked.slug}" puts it all back`,
  );
}

async function runUnblock(flags: Record<string, unknown>): Promise<void> {
  const slug = required(flags, "slug");
  const api = await apiFor(flags);
  const project = await api.unblock(slug);

  assertNotBlocked(project);
  console.log(
    `scafo: "${project.slug}" is no longer blocked; the nodes that should serve it start it ` +
      `again on their next pass`,
  );
}

async function runLabel(flags: Record<string, unknown>): Promise<void> {
  const slug = required(flags, "slug");
  /* Read before anything is contacted, so a malformed pair costs no request. */
  const labels = readLabelArgs(positionals(flags));
  const api = await apiFor(flags);

  const updated = await api.setLabels(slug, labels);
  const count = Object.keys(updated.labels ?? {}).length;
  console.log(
    count === 0
      ? `scafo: cleared every label on "${updated.slug}"`
      : `scafo: "${updated.slug}" now carries ${String(count)} label${count === 1 ? "" : "s"}, ` +
          `and no others — scafo stores them and reads none of them`,
  );
}

/**
 * The project surface behind whichever remote this invocation resolved.
 *
 * A NODE IS REQUIRED, and the refusal says so rather than falling back to the
 * bucket: see the header of `_projects.ts` for why there is no bucket path here.
 */
async function apiFor(flags: Record<string, unknown>): Promise<ProjectApi> {
  const resolved = await resolveOperator({
    home: resolveOperatorHome(),
    env: process.env,
    flags: operatorFlags(flags),
    readFile: readTextFile,
  });

  if (resolved.nodeUrl === undefined) {
    throw new ScafoError("invalid-input", "No node to ask", {
      detail:
        `administering a project is an operator-key act rather than a bucket one, so it goes ` +
        `through a node: pass --node <url>, or --remote <name> of a remote that names one`,
    });
  }
  return projectApi({
    url: nodeBaseUrl(resolved.nodeUrl),
    authorize: operatorSigner(await resolved.readKey()),
  });
}

/** A block the node reports as still standing is a failure rather than a success line. */
function assertNotBlocked(project: ProjectRecord): void {
  if (project.blocked !== true) return;

  throw new ScafoError("cas-conflict", "Project is still blocked", {
    detail: `"${project.slug}" still carries the flag after the call`,
  });
}

/** Wraps a runner so every command reports a failure the same way. */
function guarded(
  run: (flags: Record<string, unknown>) => Promise<void>,
): (context: { args: Record<string, unknown> }) => Promise<void> {
  return async ({ args }) => {
    try {
      await run(args);
    } catch (error) {
      reportFailure(error);
    }
  };
}

/** The trailing positionals citty collects, which is where the label pairs land. */
function positionals(flags: Record<string, unknown>): string[] {
  const rest = flags._;
  if (!Array.isArray(rest)) return [];
  return rest.filter((entry): entry is string => typeof entry === "string");
}

function required(flags: Record<string, unknown>, name: string): string {
  const value = flags[name];
  if (typeof value === "string" && value.trim() !== "") return value.trim();

  throw new ScafoError("invalid-input", "Missing required argument", {
    detail: `<${name}> must be given`,
  });
}
