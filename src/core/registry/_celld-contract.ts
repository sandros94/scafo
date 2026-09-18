/*
 * The Celld bucket formats this build was VERIFIED against, and nothing else.
 * This implementation will be superseded once upstream provides a native approach.
 *    TRACKED IN: https://github.com/denoland/celld/issues/181
 *
 * `scafo deployment prune` is the one place scafo reads and deletes inside
 * Celld's own keyspace, and Celld is alpha: it changes these formats between
 * releases. Everything prune pins itself to lives here, each constant beside a
 * permalink to the upstream lines it mirrors, pinned to the commit of a tag so
 * the link says what the code said rather than what `main` says today.
 *
 * ADDING A RELEASE, in this order: run the end-to-end prune case against a
 * bucket that release wrote; re-check every permalinked site below and in
 * `prune.ts` and `paths.ts` against the new tag; then add the release here,
 * together with any marker value the new tag introduced, permalinked to it.
 * KEEP THE OLD VALUES AND THE OLD LINKS — an installation is upgraded one
 * machine at a time, and a fleet still on the older release is still writing
 * what that release wrote.
 *
 * THE LAYOUT these markers live in, as one `celld deploy` writes it:
 *   `deploy/<script>/<version>/`
 *     https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L575 (v0.5.0)
 *   `deploy/<script>/<version>/assets.json`
 *     https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L811-L818 (v0.5.0)
 *   `deploy/<script>/<version>/manifest.json`
 *     https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L819-L824 (v0.5.0)
 *   `deploy/<script>/current.json`
 *     https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L842-L847 (v0.5.0)
 *   `deploy/current.json`
 *     https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L848 (v0.5.0)
 *   `deploy-blobs/assets/sha256/<2 hex>/<digest>`
 *     https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L433-L448 (v0.5.0)
 *     https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L998-L1008 (v0.5.0)
 *   `deploy/images/<id>.tar`
 *     https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/container.rs#L67-L73 (v0.5.0)
 *   `deploy/queues/<queue>/consumer.json`
 *     https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L138-L141 (v0.5.0)
 *   `<version>` is the first sixteen hexadecimal characters of a sha256
 *     https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L467-L500 (v0.5.0)
 *     https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L570-L575 (v0.5.0)
 *
 * THE WRITE ORDER of that layout, which is what makes a version directory with
 * no `manifest.json` a deploy in flight rather than a format this cannot read:
 * the shared blobs, then the modules, then `assets.json`, then `manifest.json`,
 * then the queue attachments, then the named pointer, then the fleet-wide one.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L800-L848 (v0.5.0)
 *
 * `DeployPointer`, the two `current.json` objects prune reads to know what an
 * application serves; `script_name` is optional, and older named pointers omit it.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L450-L460 (v0.5.0)
 */

/**
 * The Celld releases prune has been run end to end against. An installation
 * answering on anything else refuses the whole plan: what it wrote is a format
 * nothing here has read.
 */
export const VERIFIED_CELLD_RELEASES: readonly string[] = ["0.5.0"];

/**
 * `Manifest.schema_version` values this build knows. `celld deploy` writes 2
 * for a deployment that references assets and 1 for one that does not.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L11-L17 (v0.5.0)
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L588-L589 (v0.5.0)
 */
export const MANIFEST_SCHEMA_VERSIONS: readonly number[] = [1, 2];

/**
 * What an absent `Manifest.schema_version` means: upstream defaults the field
 * rather than requiring it, so a manifest written before it existed reads as 1.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L57-L59 (v0.5.0)
 */
export const LEGACY_MANIFEST_SCHEMA_VERSION: number = 1;

/**
 * Every `Manifest.required_features` value this build knows, mirroring
 * upstream's `SUPPORTED_DEPLOYMENT_FEATURES` — the same list its own loader
 * gates on, for the same reason: a manifest naming anything else was written by
 * a Celld that models something this does not, so nothing here may read it.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L61-L76 (v0.5.0)
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L307-L319 (v0.5.0)
 *
 * Each value, in upstream's own order:
 *   `assets-v1`     https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L78 (v0.5.0)
 *   `containers-v1` https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L79-L82 (v0.5.0)
 *   `cron-v1`       https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L88-L91 (v0.5.0)
 *   `d1-v1`         https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L83-L87 (v0.5.0)
 *   `kv-v1`         https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L105-L111 (v0.5.0)
 *   `queues-v1`     https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L113-L115 (v0.5.0)
 *   `sqlite-vec-v1` https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L97 (v0.5.0)
 *   `r2-v1`         https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L92-L96 (v0.5.0)
 *   `wasm-v1`       https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L98 (v0.5.0)
 *   `workflows-v1`  https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L99-L103 (v0.5.0)
 */
export const DEPLOYMENT_FEATURES: readonly string[] = [
  "assets-v1",
  "containers-v1",
  "cron-v1",
  "d1-v1",
  "kv-v1",
  "queues-v1",
  "sqlite-vec-v1",
  "r2-v1",
  "wasm-v1",
  "workflows-v1",
];

/**
 * The one `AssetIndex.schema_version` this build knows. Upstream gives the
 * field no default, so an index that names none is not one `celld deploy`
 * wrote — and an index is the only thing that says which shared blobs a
 * deployment holds.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L382-L388 (v0.5.0)
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L2426-L2427 (v0.5.0)
 */
export const ASSET_INDEX_SCHEMA_VERSION: number = 1;

/** The verified releases as a refusal names them. */
export function verifiedReleaseList(): string {
  return VERIFIED_CELLD_RELEASES.join(", ");
}
