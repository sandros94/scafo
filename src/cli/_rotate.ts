/* Expand-contract remote key rotation: write pending key, trust it, confirm its
   signature, flip local reference, then revoke old key. */

import { rm } from "node:fs/promises";
import { ScafoError } from "../core/error.ts";
import { LEGACY_OPERATOR_ROLE, type OperatorRole } from "../core/registry/operators.ts";
import { SLUG_MAX_LENGTH } from "../core/utils/slug.ts";
import { operatorSigner } from "./_node.ts";
import {
  type RemoteEntry,
  type RemoteKeyRef,
  remotesReferencing,
  getRemote,
  readRemoteKey,
  readRemotes,
  writeRemotes,
} from "./_remotes.ts";
import {
  assertKeyName,
  homeKeyPath,
  homeKeyRefPath,
  homeKeysDir,
  resolveHomePath,
} from "./_home.ts";
import {
  generateOperatorKey,
  type OperatorKeyFile,
  readOperatorDocument,
} from "./_operator-key.ts";
import { type RemoteKeyOptions, remoteConnection, operatorApi } from "./_operators.ts";
import { readTextFile, writeSecretFile } from "./_utils.ts";

export interface RotateOptions extends RemoteKeyOptions {
  /** Stops after the flip, leaving the old key trusted for an explicit removal later. */
  keepOld?: boolean;
  /** Deletes the old key FILE once the fleet no longer trusts it. */
  purgeOld?: boolean;
}

/** A rotation as it happened. */
export interface RotatedKey {
  remote: string;
  /** Key the remote signed with before this run. */
  oldKeyId: string;
  /** Absolute path of the file that key is in. */
  oldKeyPath: string;
  newKeyId: string;
  /** Absolute path of the file the new key was written to. */
  newKeyPath: string;
  /** Tier both keys are at: a rotation replaces a key, it never re-tiers one. */
  role: OperatorRole;
  /**
   * Projects both keys reach — `["*"]` for every one, and absent for an ADMIN,
   * which carries no scope. Read back off the fleet for the same reason the
   * tier is: a rotation replaces a key, and it never widens or narrows what
   * that key could name.
   */
  projects?: string[];
  /** Whether the new key was taken over from an interrupted run rather than minted. */
  resumed: boolean;
  /** Whether the old key was deregistered from the fleet. */
  contracted: boolean;
  /** Whether the old key FILE was deleted. */
  purged: boolean;
  /** Remotes in this home still signing with the old key file, which is why it stayed. */
  sharedWith: string[];
  /** Ids the fleet trusts besides this rotation's two, in id order. */
  alsoTrusted: string[];
}

/**
 * Replaces the key a remote signs with, in the order documented at the top of
 * this file.
 *
 * `keepOld` stops after the flip: both keys stay trusted, and the old one is
 * removed later with {@link revokeRemoteKey}. `purgeOld` deletes the old key FILE
 * once the fleet no longer trusts it, and is refused together with `keepOld` —
 * they ask for opposite things, and what the pair would produce is a way into
 * the fleet whose private half nobody holds.
 *
 * OTHER REMOTES IN THIS HOME ARE NEVER TOUCHED. One key can speak for several,
 * and repointing the rest at a key they were not rotated onto would rotate
 * installations the operator never named — so a shared key file is left where it
 * is, and the remotes sharing it are reported.
 */
export async function rotateRemoteKey(
  home: string,
  name: string,
  opts: RotateOptions = {},
): Promise<RotatedKey> {
  if (opts.keepOld === true && opts.purgeOld === true) {
    throw new ScafoError("invalid-input", "Conflicting arguments", {
      detail:
        `--keep-old leaves the old key trusted and --purge-old destroys the only copy of its ` +
        `private half; together they would leave a way into the fleet that nobody holds`,
    });
  }

  const entry = await getRemote(home, name);
  const oldKey = await readRemoteKey(home, entry);
  const oldKeyPath = resolveHomePath(home, entry.key.path);

  /* 1. MINT, or take over what an interrupted run already minted. */
  const pending = await pendingKey(home, name, entry);
  const { key: newKey, ref: newRef } = pending ?? (await mintPending(home, name));
  const newKeyPath = resolveHomePath(home, newRef.path);

  const connection = remoteConnection(entry, name, opts);
  const asOld = operatorApi({ ...connection, authorize: operatorSigner(oldKey) });
  const asNew = operatorApi({ ...connection, authorize: operatorSigner(newKey) });

  /* 2. EXPAND, under the old key — the only credential this operator has — and
     superseding it, which is what will authorize step 5 and what settles the new
     key's tier as the old key's own. */
  await asOld.trust({
    id: newKey.id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: newKey.publicKey.x },
    supersedes: oldKey.id,
  });

  /*
   * 3. CONFIRM, under the NEW key: the fleet accepts what it signs.
   *
   * Below the admin tier a node answers this with the caller's own LINEAGE —
   * the new key, and the old key it supersedes — rather than with every key the
   * fleet trusts. That is exactly the pair this step reads: the new key's tier
   * and scope come out of the first, and the second is what step 5 revokes. So
   * the confirm is unchanged in substance, and `alsoTrusted` below simply has
   * nothing to report for an operator-tier rotation, which is the truth about
   * what that key was shown.
   */
  const trusted = (await asNew.list()).operators;
  /* What the fleet says the new key is, rather than what this end assumed. It is
     always there — the call above was made with that very key — and a fleet that
     somehow does not name it is reported at the tier a role-less record reads
     as, which is what every other reader of one does. */
  const registered = trusted.find((key) => key.id === newKey.id);
  const role = registered?.role ?? LEGACY_OPERATOR_ROLE;
  /* And the SCOPE the same way. The expand step above named none, so whatever
     is here is what the node inherited from the old key — which is the whole
     guarantee: a rotation cannot widen a scope, because the widening would have
     to be asked for and this never asks. */
  const projects = registered?.projects;

  /* 4. FLIP. Everything above is repeatable; this is what stops being repeated. */
  await updateEntry(home, name, (current) => {
    const flipped: RemoteEntry = { ...current, key: newRef };
    delete flipped.rotating;
    return flipped;
  });

  /* 5. CONTRACT, under the new key, and only now. */
  let contracted = false;
  if (opts.keepOld !== true) {
    await asNew.revoke(oldKey.id);
    contracted = true;
  }

  /* Read afresh: the flip has just rewritten the file this is asked of. */
  const sharedWith = remotesReferencing(await readRemotes(home), name, [entry.key.path]);
  let purged = false;
  if (opts.purgeOld === true && sharedWith.length === 0) {
    await rm(oldKeyPath, { force: true });
    purged = true;
  }

  return {
    remote: name,
    oldKeyId: oldKey.id,
    oldKeyPath,
    newKeyId: newKey.id,
    newKeyPath,
    role,
    ...(projects === undefined ? {} : { projects }),
    resumed: pending !== null,
    contracted,
    purged,
    sharedWith,
    alsoTrusted: trusted.map((key) => key.id).filter((id) => id !== newKey.id && id !== oldKey.id),
  };
}

/**
 * How a rotation reads on the terminal: what changed, what was deliberately left
 * alone, and what is still outstanding.
 *
 * Every line that is not about the happy path is CONDITIONAL, so a plain
 * rotation says three things and a complicated one says why it was complicated.
 */
export function describeRotation(rotated: RotatedKey): string {
  const lines = [
    `scafo: remote "${rotated.remote}" now signs with "${rotated.newKeyId}", kept in ` +
      `${rotated.newKeyPath}`,
    /* Stated rather than assumed: a rotation is a replacement, and an operator
       who half-expected it to be a way up or down — or a way wider — should read
       that it was not. */
    `scafo: it is ${rotated.role}-tier` +
      `${rotated.projects === undefined ? "" : `, scoped to ${rotated.projects.join(", ")}`}, ` +
      `exactly as "${rotated.oldKeyId}" was`,
  ];

  if (rotated.resumed) {
    lines.push(
      `scafo: took over the key an earlier, interrupted rotation had already minted, rather ` +
        `than leaving it trusted by the fleet and pointed at by nothing`,
    );
  }

  lines.push(
    rotated.contracted
      ? `scafo: "${rotated.oldKeyId}" is no longer trusted; a node that has already read it ` +
          `goes on accepting it for up to a minute, which is how long revocation takes to ` +
          `reach the whole installation`
      : `scafo: "${rotated.oldKeyId}" is STILL trusted, as --keep-old asked; remove it with ` +
          `"scafo operator revoke --remote ${rotated.remote} --id ${rotated.oldKeyId}" once ` +
          `everything using it has been moved over`,
  );

  lines.push(
    rotated.purged
      ? `scafo: deleted ${rotated.oldKeyPath}`
      : `scafo: ${rotated.oldKeyPath} was kept — a private key is not scafo's to destroy ` +
          `unasked; pass --purge-old to delete it`,
  );

  if (rotated.sharedWith.length > 0) {
    /* Repointing them would rotate installations the operator never named, and
       silently is the one way this must not happen. */
    lines.push(
      `scafo: ${rotated.sharedWith.join(", ")} also sign${rotated.sharedWith.length === 1 ? "s" : ""} ` +
        `with ${rotated.oldKeyPath} and ${rotated.sharedWith.length === 1 ? "was" : "were"} NOT ` +
        `repointed; if any of them reach this same installation, rotate them too — it no ` +
        `longer trusts that key`,
    );
  }

  if (rotated.alsoTrusted.length > 0) {
    lines.push(
      `scafo: this fleet also trusts ${rotated.alsoTrusted.join(", ")}; "scafo operator list ` +
        `--remote ${rotated.remote}" lists them and "scafo operator revoke" removes one`,
    );
  }
  return lines.join("\n");
}

/* ---------------------------------------------------------------- internals */

/**
 * The key an interrupted rotation left pending, or null when there is none.
 *
 * Throws `ScafoError("not-found")` when the entry names one and the file is
 * gone: minting a replacement would be the silent way to strand whatever the
 * missing key had already been registered as, and an operator who deleted it can
 * see what the fleet trusts and clear it deliberately.
 */
async function pendingKey(
  home: string,
  name: string,
  entry: RemoteEntry,
): Promise<{ key: OperatorKeyFile; ref: RemoteKeyRef } | null> {
  const ref = entry.rotating;
  if (ref === undefined) return null;

  const path = resolveHomePath(home, ref.path);
  const stored = await readTextFile(path);
  if (stored === null) {
    throw new ScafoError("not-found", "Pending rotation key is missing", {
      detail:
        `"${name}" was left mid-rotation and the key it had minted, "${path}", is not there; ` +
        `"scafo operator list --remote ${name}" shows what the fleet trusts and ` +
        `"scafo operator revoke --remote ${name} --id <key-id>" removes what that run left ` +
        `behind`,
    });
  }
  return { key: readOperatorDocument(stored, path).key, ref };
}

/**
 * A fresh key, written to the home and recorded on the entry as pending.
 *
 * The FILE FIRST and the entry second: a mark pointing at a key that was never
 * written would fail every rerun, while a key written under no mark is an unused
 * file and nothing more.
 */
async function mintPending(
  home: string,
  name: string,
): Promise<{ key: OperatorKeyFile; ref: RemoteKeyRef }> {
  const key = await generateOperatorKey();
  const keyName = pendingKeyName(name, key.id);
  const ref: RemoteKeyRef = { kind: "file", path: homeKeyRefPath(keyName) };

  await writeSecretFile(
    homeKeysDir(home),
    homeKeyPath(home, keyName),
    `${JSON.stringify(key, null, 2)}\n`,
  );
  await updateEntry(home, name, (current) => ({ ...current, rotating: ref }));
  return { key, ref };
}

/**
 * What a rotation calls the file it mints: the remote and the key's own id, which
 * can collide with nothing and says which rotation produced it. A remote named
 * too long for the pair keeps the id alone rather than being refused.
 */
function pendingKeyName(remote: string, id: string): string {
  const paired = `${remote}-${id}`;
  const name = paired.length <= SLUG_MAX_LENGTH ? paired : id;
  assertKeyName(name);
  return name;
}

/** Read-modify-write of one entry, so a concurrent edit elsewhere is not clobbered. */
async function updateEntry(
  home: string,
  name: string,
  change: (entry: RemoteEntry) => RemoteEntry,
): Promise<void> {
  const file = await readRemotes(home);
  const entry = file.remotes[name];
  if (entry === undefined) {
    throw new ScafoError("not-found", "Remote is not registered", {
      detail: `"${name}" left this operator's home while it was being rotated`,
    });
  }
  await writeRemotes(home, { ...file, remotes: { ...file.remotes, [name]: change(entry) } });
}
