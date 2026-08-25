/*
 * Internal: the project surface of one node, and how a listing of it prints.
 *
 * WIRE ONLY, unlike `scafo env`, which falls back to writing the bucket when no
 * node is named. That is not an oversight and not a limitation to lift later:
 * blocking and labelling are ADMIN-ONLY acts, and the tier that makes them so is
 * a property of an operator KEY checked by a node. A bucket-side path would
 * authorize with bucket credentials instead — which are root, and would
 * therefore answer "yes" to everything, quietly turning an admin-only verb into
 * one anybody holding the bucket can take.
 *
 * Whoever holds the bucket can of course still write the flag by hand; the point
 * is that this command does not offer it as though it were the same act.
 */

import { ScafoError } from "../core/error.ts";
import type { ProjectRecord } from "../core/types/registry.ts";
import { type NodeOptions, nodeRequest } from "./_node.ts";
import { assertSlug } from "../core/utils/slug.ts";

/** What a node answers `GET /v1/projects` with. */
export interface ProjectListing {
  /**
   * WHOLE records for an admin; for anybody else the node strips each one's
   * `labels` before it answers, because those are the fleet's notes about a
   * tenant rather than the tenant's own.
   *
   * So a non-admin's rows print `-` in the LABELS column whether or not the
   * project carries any, and that is the redaction working rather than a bug to
   * fix here: the two cases are byte-identical on the wire on purpose, and
   * nothing on this side could tell them apart if it wanted to.
   */
  projects: ProjectRecord[];
  /** Set when the node showed only what this key reaches, rather than the fleet. */
  scoped?: true;
}

/** The project surface of one node, signed for by one key. */
export interface ProjectApi {
  /** Where these calls go, for whatever reports what was done and to whom. */
  via: string;
  list(): Promise<ProjectListing>;
  block(slug: string): Promise<ProjectRecord>;
  unblock(slug: string): Promise<ProjectRecord>;
  setLabels(slug: string, labels: Record<string, string>): Promise<ProjectRecord>;
}

export function projectApi(opts: NodeOptions): ProjectApi {
  const at = (suffix: string = ""): string => `${opts.url}/v1/projects${suffix}`;
  const call = (method: string): { method: string; fetchFn?: typeof fetch } => ({
    method,
    ...(opts.fetchFn === undefined ? {} : { fetchFn: opts.fetchFn }),
  });

  /* Validated rather than escaped: a slug that passes carries no separator and
     no traversal, so it can only ever address the route it was meant to. One
     that does not is a mistake worth naming here, before a node answers 404 to
     a path the operator cannot see anything wrong with. */
  const verb = async (slug: string, name: string): Promise<ProjectRecord> => {
    assertSlug(slug);
    const answer = await request(at(`/${slug}/${name}`), opts, call("POST"));
    return (answer as { project: ProjectRecord }).project;
  };

  return {
    via: opts.url,

    async list(): Promise<ProjectListing> {
      const answer = (await request(at(), opts, call("GET"))) as ProjectListing;
      return {
        projects: answer.projects,
        ...(answer.scoped === true ? { scoped: true as const } : {}),
      };
    },

    block: (slug) => verb(slug, "block"),
    unblock: (slug) => verb(slug, "unblock"),

    async setLabels(slug, labels): Promise<ProjectRecord> {
      assertSlug(slug);
      const answer = await request(at(`/${slug}/labels`), opts, {
        ...call("POST"),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ labels }),
      });
      return (answer as { project: ProjectRecord }).project;
    },
  };
}

/**
 * `k=v` pairs as the map the API takes.
 *
 * WHOLESALE is the contract, so this is what the whole map will BE rather than
 * what to add to it — see `setProjectLabels`. Naming no pair at all is therefore
 * how labels are cleared, which is stated in the command's own help rather than
 * left to be discovered.
 *
 * Throws `ScafoError("invalid-input")` for anything that is not a pair.
 */
export function readLabelArgs(pairs: string[]): Record<string, string> {
  const labels: Record<string, string> = {};

  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at <= 0) {
      throw new ScafoError("invalid-input", "Invalid label", {
        detail:
          `"${pair}" is not a "key=value" pair; labels are written as ` +
          `"scafo project label <slug> tenant=acme plan=pro"`,
      });
    }
    labels[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return labels;
}

/**
 * The listing as an operator reads it: one row per project, and a header saying
 * how many of them are stopped.
 *
 * THE BLOCKED COUNT IS THE LINE WORTH HAVING, for the same reason the node
 * listing leads with how many machines are live: somebody running this is
 * usually asking "is anything stopped that should not be?", and answering that
 * by making them read a column would be answering a different question.
 */
export function formatProjectTable(listing: ProjectListing): string {
  const projects = listing.projects;
  if (projects.length === 0) {
    return (
      `scafo: no project here${listing.scoped === true ? " that this key reaches" : ""}; a ` +
      `project comes into being on the first deploy that names it`
    );
  }

  const blocked = projects.filter((project) => project.blocked === true).length;
  const rows = projects.map((project) => [
    project.slug,
    project.blocked === true ? "blocked" : "serving",
    project.createdAt ?? "unknown",
    formatProjectLabels(project.labels ?? {}),
  ]);
  const head = ["PROJECT", "STATE", "CREATED", "LABELS"];
  const width = head.map((_, column) =>
    Math.max(...[head, ...rows].map((row) => (row[column] as string).length)),
  );

  return [
    `scafo: ${String(projects.length)} project${projects.length === 1 ? "" : "s"}, ` +
      `${String(blocked)} blocked` +
      /* Said plainly, because a filtered listing and a whole one are the same
         shape: a tenant reading this must not conclude the fleet has one
         project. */
      (listing.scoped === true ? " (the projects this key reaches)" : ""),
    "",
    ...[head, ...rows].map((row) => `  ${row.map(pad(width)).join("  ").trimEnd()}`),
  ].join("\n");
}

/** One project as `scafo project show` prints it. */
export function formatProject(project: ProjectRecord): string {
  const lines = [
    `scafo: project "${project.slug}"`,
    ``,
    `  state       ${project.blocked === true ? "blocked by an admin of this fleet" : "serving"}`,
    `  created     ${project.createdAt ?? "unknown (this record predates the stamp)"}`,
    `  placement   ${project.placement}`,
    `  labels      ${formatProjectLabels(project.labels ?? {})}`,
  ];
  if (project.blocked === true) {
    lines.push(
      ``,
      `  Nothing of it is served, woken or deployed to while it is blocked, and`,
      `  nothing of it has been deleted: "scafo project unblock ${project.slug}" puts it`,
      `  all back on the next pass of every node.`,
    );
  }
  return lines.join("\n");
}

/* ---------------------------------------------------------------- internals */

function formatProjectLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "-";
  return entries
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join(",");
}

function pad(width: number[]): (cell: string, column: number) => string {
  return (cell, column) => cell.padEnd(width[column] as number);
}

async function request(
  url: string,
  opts: NodeOptions,
  init: { method: string; fetchFn?: typeof fetch; headers?: Record<string, string>; body?: string },
): Promise<unknown> {
  const answer = await nodeRequest(url, await opts.authorize(), init);
  return answer.json();
}
