/*
 * Internal: the people. Who this operator is, who else the fleet admits, and the
 * two ways a key gets in.
 *
 * EVERY HUMAN HERE IS AN OPERATOR; admin is a role an operator holds. The tiers
 * decide who may admit whom, and nothing else about them is a different kind of
 * person.
 *
 * The bucket and the wire are the two ways to the same records. Administering
 * them goes through a NODE by default, on purpose: the credential it needs is a
 * key the fleet already trusts, and nothing else — an operator who had to hold
 * the bucket's access key to change their own would be carrying the credential
 * that makes the whole exercise unnecessary. The BUCKET remains for the two
 * cases the wire cannot serve: an installation being bootstrapped, which has no
 * trusted key yet, and one whose operator keys have all been lost, which no
 * longer has one.
 */

import { ScafoError } from "../core/error.ts";
import type { RegistryContext } from "../core/registry/context.ts";
import type { OperatorRole, TrustedOperator } from "../core/registry/operators.ts";
import { assertNodeId } from "../core/registry/paths.ts";
import {
  type NodeCallOptions,
  type NodeOptions,
  nodeBaseUrl,
  nodeRequest,
  operatorSigner,
} from "./_node.ts";
import {
  formatPublicOperator,
  type PublicOperator,
  publicOperator,
  registerOperatorKey,
} from "./_operator-key.ts";
import { type ResolveOperatorOptions, resolveOperator } from "./_operator.ts";
import { type RemoteEntry, getRemote, readRemoteKey } from "./_remotes.ts";

export type { OperatorRole, TrustedOperator };

/**
 * A key as it is offered to a remote: the public half, and at most the tier and
 * the lineage it claims.
 *
 * Both are OPTIONAL because the node decides them — least privilege when no role
 * is named, and the caller's own tier for a key that supersedes the caller — and
 * a client that stated a default here would be stating a policy it does not own.
 */
export interface OperatorGrant {
  id: string;
  publicKey: TrustedOperator["publicKey"];
  role?: OperatorRole;
  /** Key this one replaces; a node accepts only the CALLER's own id here. */
  supersedes?: string;
}

/** What every command about a remote's trusted keys needs beyond the remote itself. */
export interface RemoteKeyOptions {
  /** Node to reach, when something names one other than the remote's first endpoint. */
  nodeUrl?: string;
  /** How the calls are made; defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
}

/** What an operator can do to the set of keys a fleet trusts. */
export interface OperatorApi {
  /** How the operator is acting, as a command's own output names it. */
  readonly via: string;
  /** Every key the fleet trusts, in id order. */
  list(): Promise<TrustedOperator[]>;
  /** Records a public half. Repeating it is a no-op, not a failure. */
  trust(key: OperatorGrant): Promise<TrustedOperator>;
  /** Stops the fleet trusting `id`; answers the id that went. */
  revoke(id: string): Promise<string>;
}

/** A revocation as it happened. */
export interface RevokedKey {
  remote: string;
  removed: string;
}

/** What the fleet behind a remote trusts, and which of it this home holds. */
export interface RemoteKeys {
  remote: string;
  /** Id this home signs for that remote with. */
  own: string;
  trusted: TrustedOperator[];
}

/** The trusted-key surface of one node, signed for by one key. */
export function operatorApi(opts: NodeOptions): OperatorApi {
  const at = (suffix: string = ""): string => `${opts.url}/v1/operators${suffix}`;
  const call = (method: string): { method: string; fetchFn?: typeof fetch } => ({
    method,
    ...(opts.fetchFn === undefined ? {} : { fetchFn: opts.fetchFn }),
  });

  return {
    via: opts.url,

    async list(): Promise<TrustedOperator[]> {
      const answer = await nodeRequestJson(at(), opts, call("GET"));
      return (answer as { operators: TrustedOperator[] }).operators;
    },

    async trust(key): Promise<TrustedOperator> {
      const answer = await nodeRequestJson(at(), opts, {
        ...call("POST"),
        headers: { "content-type": "application/json" },
        /* The public half alone leaves here. A node has no use for the private
           one, and a registry every node of the fleet reads is the last place
           it would belong. */
        body: JSON.stringify({
          id: key.id,
          publicKey: key.publicKey,
          ...(key.role === undefined ? {} : { role: key.role }),
          ...(key.supersedes === undefined ? {} : { supersedes: key.supersedes }),
        }),
      });
      return (answer as { operator: TrustedOperator }).operator;
    },

    async revoke(id): Promise<string> {
      /* Validated rather than escaped: an id is held to the charset a bucket key
         is, so one that passes carries no separator and no traversal. One that
         does not is a mistake worth naming here, before a node answers 404 to a
         path the operator cannot see anything wrong with. */
      assertNodeId(id);
      const answer = await nodeRequestJson(at(`/${id}`), opts, call("DELETE"));
      return (answer as { removed: string }).removed;
    },
  };
}

/** Where a remote is reached, and how the call is made. */
export function remoteConnection(
  entry: RemoteEntry,
  name: string,
  opts: RemoteKeyOptions,
): Omit<NodeOptions, "authorize"> {
  const url = opts.nodeUrl ?? entry.endpoints[0];
  if (url === undefined || url === "") {
    throw new ScafoError("invalid-input", "Remote has no endpoint", {
      detail:
        `nothing could reach "${name}": its entry names no node daemon, so give --node <url> ` +
        `of one of them`,
    });
  }
  return {
    url: nodeBaseUrl(url),
    ...(opts.fetchFn === undefined ? {} : { fetchFn: opts.fetchFn }),
  };
}

/** The trusted-key surface behind a remote, signed for by the key this home holds. */
export async function reachRemote(
  home: string,
  name: string,
  opts: RemoteKeyOptions,
): Promise<OperatorApi> {
  const entry = await getRemote(home, name);
  const key = await readRemoteKey(home, entry);
  return operatorApi({ ...remoteConnection(entry, name, opts), authorize: operatorSigner(key) });
}

/**
 * Stops the fleet behind a remote trusting one key, signed for by the key this
 * home holds.
 *
 * For the multi-operator case — a fleet several people administer — and for the
 * leftovers of a rotation that was interrupted after its flip. A fleet REFUSES
 * to revoke the key the request was signed with, because that removal is the one
 * nothing could verify afterwards; replacing one's own key is `scafo operator
 * rotate` and never this.
 */
export async function revokeRemoteKey(
  home: string,
  name: string,
  id: string,
  opts: RemoteKeyOptions = {},
): Promise<RevokedKey> {
  const api = await reachRemote(home, name, opts);
  return { remote: name, removed: await api.revoke(id) };
}

/** Every key that fleet trusts, and the one this home speaks with. */
export async function listRemoteKeys(
  home: string,
  name: string,
  opts: RemoteKeyOptions = {},
): Promise<RemoteKeys> {
  const entry = await getRemote(home, name);
  const key = await readRemoteKey(home, entry);
  const api = operatorApi({
    ...remoteConnection(entry, name, opts),
    authorize: operatorSigner(key),
  });

  return { remote: name, own: key.id, trusted: await api.list() };
}

/** How a revocation reads on the terminal, revocation bound included. */
export function describeRevocation(revoked: RevokedKey): string {
  return (
    `scafo: "${revoked.remote}" no longer trusts "${revoked.removed}"; a node that has ` +
    `already read that key goes on accepting it for up to a minute, which is how long ` +
    `revocation takes to reach the whole installation`
  );
}

/**
 * The keys a fleet trusts, as an operator reads them: the id, the TIER, and
 * — where a rotation left one — the key it replaced.
 *
 * The tier is a column of its own because it is what decides who may administer
 * whom: an operator looking at a refusal needs to see, in the same listing, that
 * their key is operator-tier and which keys are not.
 */
export function formatRemoteKeys(keys: RemoteKeys): string {
  const lines = [
    `scafo: "${keys.remote}" trusts ${String(keys.trusted.length)} operator ` +
      `key${keys.trusted.length === 1 ? "" : "s"}`,
  ];
  const width = Math.max(...keys.trusted.map((key) => key.id.length), 0);

  for (const key of keys.trusted) {
    const notes = [
      ...(key.supersedes === undefined ? [] : [`replaces ${key.supersedes}`]),
      ...(key.id === keys.own ? ["this home signs with it"] : []),
    ];
    const suffix = notes.length === 0 ? "" : `  (${notes.join(", ")})`;
    lines.push(`  ${key.id.padEnd(width)}  ${key.role}${suffix}`);
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------ who I am */

/** This operator's public half, and where it was resolved from. */
export interface ShownOperator {
  /** The document itself: the artifact that travels to whoever can admit it. */
  document: string;
  public: PublicOperator;
  /** The remote whose key this is, when a remote decided it. */
  remote?: string;
  /** What is said ABOUT the document — which never goes where the document goes. */
  notice: string;
}

/**
 * This operator's PUBLIC half, for the remote one invocation resolves to, or for
 * the key `--key` names outright.
 *
 * TWO VALUES BECAUSE THEY GO TO TWO PLACES. `scafo operator show > me.json` has
 * to produce a file an admin can enrol as it stands, so the document goes to
 * stdout ALONE and everything a human wants to read about it goes to stderr. A
 * greeting line on stdout would corrupt every redirect of this command.
 *
 * The private half is READ — it is in the same file — and never leaves:
 * {@link publicOperator} builds the document out of the two fields that may
 * travel rather than stripping the ones that may not.
 */
export async function showOperator(opts: ResolveOperatorOptions): Promise<ShownOperator> {
  const resolved = await resolveOperator(opts);
  const pub = publicOperator(await resolved.readKey());
  const whose = resolved.remote === undefined ? "" : `, which speaks for "${resolved.remote}"`;

  return {
    document: formatPublicOperator(pub),
    public: pub,
    ...(resolved.remote === undefined ? {} : { remote: resolved.remote }),
    notice:
      `scafo: operator "${pub.id}"${whose}. What follows is the PUBLIC half alone — send it ` +
      `to an admin of the fleet, who admits it with "scafo operator enroll"`,
  };
}

/* ---------------------------------------------------------- letting one in */

/** Which of the two ways an enrollment reaches the fleet. */
export type EnrollPath = "wire" | "bucket";

/**
 * Which path an enrollment takes, REFUSED rather than guessed at.
 *
 * The two are not alternatives to be picked by convenience; they differ in what
 * they prove. The WIRE path is authorized by an admin key the fleet already
 * trusts, and a node applies the tier rules to it. The BUCKET path is authorized
 * by the bucket credential, bypasses every one of those rules, and exists for
 * the two moments no trusted key can be produced: seeding a new installation,
 * and recovering one that has locked every operator out.
 *
 * So a default would be wrong in both directions — silently reaching for the
 * bucket is a privilege escalation nobody asked for, and silently reaching for a
 * node is a failure at the exact moment recovery is what was wanted.
 *
 * Throws `ScafoError("invalid-input")` for both, and for neither.
 */
export function enrollPath(given: { remote?: string; bucket?: boolean }): EnrollPath {
  const wire = given.remote !== undefined && given.remote !== "";
  const bucket = given.bucket === true;

  if (wire && bucket) {
    throw new ScafoError("invalid-input", "Two enrollment paths chosen", {
      detail:
        `--remote "${given.remote as string}" asks a node of that remote to admit the key, ` +
        `and the bucket flags ask the bucket directly; they are authorized by different ` +
        `credentials and only one of them can be what this invocation meant`,
    });
  }
  if (wire) return "wire";
  if (bucket) return "bucket";

  throw new ScafoError("invalid-input", "No enrollment path chosen", {
    detail:
      `a key is admitted one of two ways and this named neither: over the WIRE with ` +
      `--remote <name>, where a node admits it on the authority of your own admin-tier key ` +
      `— the ordinary way; or through the BUCKET with the bucket flags or --config, which ` +
      `needs no trusted key at all and is how an installation is seeded and how one that has ` +
      `locked every operator out is recovered`,
  });
}

/** An enrollment as it happened. */
export interface EnrolledOperator {
  id: string;
  role: OperatorRole;
  path: EnrollPath;
  /** How it was done, as the command's own output names it. */
  via: string;
}

/**
 * Admits a key over the wire: a node records it, having checked that the key
 * this call is signed with is entitled to ask.
 *
 * The TIER is the node's to decide and is read back off its answer rather than
 * assumed — an operator-tier caller asking for an admin is refused there, and
 * reporting what was asked for instead of what happened would hide that.
 */
export async function enrollOnWire(
  home: string,
  remote: string,
  pub: PublicOperator,
  opts: RemoteKeyOptions & { role?: OperatorRole } = {},
): Promise<EnrolledOperator> {
  const api = await reachRemote(home, remote, opts);
  const trusted = await api.trust({
    id: pub.id,
    /* Built field by field rather than passed through, for the same reason the
       document is: the two fields named here are the only ones that may go. */
    publicKey: { kty: "OKP", crv: "Ed25519", x: pub.publicKey.x },
    ...(opts.role === undefined ? {} : { role: opts.role }),
  });

  return { id: trusted.id, role: trusted.role, path: "wire", via: api.via };
}

/**
 * Admits a key through the bucket: the ceremony, for an installation that has no
 * admin to ask.
 *
 * {@link registerOperatorKey}'s own rule stands — the FIRST key of an
 * installation is always an admin, and an explicit operator-tier first key is
 * refused — so a fleet cannot be seeded into a state with nobody able to
 * administer it.
 */
export async function enrollInBucket(
  registry: RegistryContext,
  pub: PublicOperator,
  opts: { role?: OperatorRole } = {},
): Promise<EnrolledOperator> {
  const role = await registerOperatorKey(
    registry,
    pub,
    opts.role === undefined ? {} : { role: opts.role },
  );
  return { id: pub.id, role, path: "bucket", via: "the bucket" };
}

/** How an enrollment reads on the terminal, including what it did NOT hand over. */
export function describeEnrollment(enrolled: EnrolledOperator): string {
  const lines = [
    `scafo: "${enrolled.id}" is trusted as ${enrolled.role}-tier, through ${enrolled.via}; ` +
      `tokens it signs are now accepted by every node`,
  ];

  if (enrolled.path === "bucket") {
    /* Said because the ceremony is the one path with no node in it, and an
       operator who reached for it deserves to read that it was the heavy way. */
    lines.push(
      `scafo: that was the bucket ceremony — it needed no key this fleet trusts, so it is ` +
        `for seeding and for recovery; ordinary enrollments go through a node with ` +
        `"scafo operator enroll <pubkey> --remote <name>"`,
    );
  }
  return lines.join("\n");
}

/**
 * The tier `--role` names, refused here rather than at the bucket: a misspelled
 * one would otherwise be dropped and the key filed at whatever the default is,
 * which is the kind of mistake an operator finds out about from a refusal months
 * later.
 *
 * Absent stays absent, so the registration surface keeps its own defaults.
 */
export function operatorRole(value: unknown): { role?: OperatorRole } {
  const wanted = typeof value === "string" ? value.trim() : "";
  if (wanted === "") return {};
  if (wanted === "admin" || wanted === "operator") return { role: wanted };

  throw new ScafoError("invalid-input", "Unknown operator role", {
    detail: `--role takes "admin" or "operator"; "${wanted}" is neither`,
  });
}

/* ---------------------------------------------------------------- internals */

/** One call, one fresh token — a spent one is refused as a replay — read as JSON. */
async function nodeRequestJson(
  url: string,
  opts: NodeOptions,
  init: NodeCallOptions,
): Promise<unknown> {
  const answer = await nodeRequest(url, await opts.authorize(), init);
  return answer.json();
}
