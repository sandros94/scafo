/*
 * The Celld bucket formats this build was VERIFIED against, and nothing else.
 * This implementation will be superseded once upstream provides a native approach.
 *    TRACKED IN: https://github.com/denoland/celld/issues/181
 *
 * `scafo deployment prune` and `scafo app lease` are the two places scafo reads
 * and deletes inside Celld's own keyspace, and Celld is beta: it changes these
 * formats between releases. Everything they pin themselves to lives here, each
 * constant beside a permalink to the upstream lines it mirrors, pinned to the
 * commit of a tag so the link says what the code said rather than what `main`
 * says today. So does the one statement about formats the version-skew gate
 * needs: which releases upstream declared may serve one fleet together.
 *
 * ADDING A RELEASE, in this order: run the end-to-end prune case against a
 * bucket that release wrote; re-check every permalinked site below and in
 * `prune.ts`, `celld-lease.ts` and `paths.ts` against the new tag; then add the
 * release here, together with any marker value the new tag introduced,
 * permalinked to it. KEEP THE OLD VALUES AND THE OLD LINKS — an installation is
 * upgraded one machine at a time, and a fleet still on the older release is
 * still writing what that release wrote. Then read the new release's notes: it
 * joins a set in `ROLLING_CELLD_RELEASES` only when they say the step from a
 * listed release may be taken as a rolling update, quoted and linked beside the
 * set; otherwise it stands alone, and moving onto it stops every node first.
 *
 * THE LAYOUT these markers live in, as one `celld deploy` writes it:
 *   `deploy/<script>/<version>/`
 *     https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L575 (v0.5.0)
 *     https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/deploy.rs#L642 (v0.5.1)
 *     https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/deploy.rs#L642 (v0.6.0)
 *     https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/deploy.rs#L651 (v0.6.1)
 *   `deploy/<script>/<version>/assets.json`
 *     https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L811-L818 (v0.5.0)
 *     https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/deploy.rs#L878-L885 (v0.5.1)
 *     https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/deploy.rs#L878-L885 (v0.6.0)
 *     https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/deploy.rs#L891-L898 (v0.6.1)
 *   `deploy/<script>/<version>/manifest.json`
 *     https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L819-L824 (v0.5.0)
 *     https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/deploy.rs#L886-L891 (v0.5.1)
 *     https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/deploy.rs#L886-L891 (v0.6.0)
 *     https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/deploy.rs#L899-L904 (v0.6.1)
 *   `deploy/<script>/current.json`
 *     https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L842-L847 (v0.5.0)
 *     https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/deploy.rs#L909-L914 (v0.5.1)
 *     https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/deploy.rs#L909-L914 (v0.6.0)
 *     https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/deploy.rs#L922-L927 (v0.6.1)
 *   `deploy/current.json`
 *     https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L848 (v0.5.0)
 *     https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/deploy.rs#L915 (v0.5.1)
 *     https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/deploy.rs#L915 (v0.6.0)
 *     https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/deploy.rs#L928 (v0.6.1)
 *   `deploy-blobs/assets/sha256/<2 hex>/<digest>`
 *     https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L433-L448 (v0.5.0)
 *     https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/protocol.rs#L433-L448 (v0.5.1)
 *     https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/protocol.rs#L433-L448 (v0.6.0)
 *     https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/protocol.rs#L439-L454 (v0.6.1)
 *     https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L998-L1008 (v0.5.0)
 *     https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/deploy.rs#L1065-L1075 (v0.5.1)
 *     https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/deploy.rs#L1065-L1075 (v0.6.0)
 *     https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/deploy.rs#L1078-L1088 (v0.6.1)
 *   `deploy/images/<content key>.tar`, named `celld-image:<content key>` by a
 *   manifest's `containers[].image` and `fence_image`
 *     https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/container.rs#L60-L73 (v0.5.0)
 *     https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/container.rs#L60-L73 (v0.5.1)
 *     https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/container.rs#L60-L73 (v0.6.0)
 *     https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/container.rs#L60-L73 (v0.6.1)
 *     https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L40-L50 (v0.5.0)
 *     https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/protocol.rs#L40-L50 (v0.5.1)
 *     https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/protocol.rs#L40-L50 (v0.6.0)
 *     https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/protocol.rs#L40-L50 (v0.6.1)
 *   `deploy/queues/<queue>/consumer.json`
 *     https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L138-L141 (v0.5.0)
 *     https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/protocol.rs#L138-L141 (v0.5.1)
 *     https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/protocol.rs#L138-L141 (v0.6.0)
 *     https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/protocol.rs#L144-L147 (v0.6.1)
 *   `<version>` is the first sixteen hexadecimal characters of a sha256
 *     https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L467-L500 (v0.5.0)
 *     https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/protocol.rs#L467-L500 (v0.5.1)
 *     https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/protocol.rs#L467-L500 (v0.6.0)
 *     https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/protocol.rs#L473-L506 (v0.6.1)
 *     https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L570-L575 (v0.5.0)
 *     https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/deploy.rs#L637-L642 (v0.5.1)
 *     https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/deploy.rs#L637-L642 (v0.6.0)
 *     https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/deploy.rs#L646-L651 (v0.6.1)
 *
 * THE WRITE ORDER of that layout, which is what makes a version directory with
 * no `manifest.json` a deploy in flight rather than a format this cannot read:
 * the saved images, then the shared blobs, then the modules, then `assets.json`,
 * then `manifest.json`, then the queue attachments, then the named pointer, then
 * the fleet-wide one.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L789-L848 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/deploy.rs#L856-L915 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/deploy.rs#L856-L915 (v0.6.0)
 *   https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/deploy.rs#L869-L928 (v0.6.1)
 *
 * `DeployPointer`, the two `current.json` objects prune reads to know what an
 * application serves; `script_name` is optional, and older named pointers omit it.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L450-L460 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/protocol.rs#L450-L460 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/protocol.rs#L450-L460 (v0.6.0)
 *   https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/protocol.rs#L456-L466 (v0.6.1)
 */

/**
 * The Celld releases prune has been run end to end against. An installation
 * answering on anything else refuses the whole plan: what it wrote is a format
 * nothing here has read.
 */
export const VERIFIED_CELLD_RELEASES: readonly string[] = ["0.5.0", "0.5.1", "0.6.0", "0.6.1"];

/**
 * Sets of Celld releases UPSTREAM DECLARED may serve one fleet together while an
 * installation moves between them, one node at a time.
 *
 * A fleet takes one bucket format, and a binary that finds an older one upgrades
 * it as it starts; two releases may share a fleet only when they share that
 * format and each tolerates the other's peers, which is something only upstream
 * can say. So this is an allowlist of what its release notes said, never an
 * inference from version numbers: a patch release is not assumed to roll, and a
 * release named in no set shares a fleet with nothing but itself.
 */
export const ROLLING_CELLD_RELEASES: readonly (readonly string[])[] = [
  /* "Upgrading from v0.5.0 can use a rolling update. Stop one node, wait for its
     replacement to report healthy, then continue to the next node."
       https://github.com/denoland/celld/releases/tag/v0.5.1 */
  ["0.5.0", "0.5.1"],
  /* 0.6.0 joins no set with 0.5.x: upstream lets the step from 0.5.1 roll only
     under `bucket` durability, and scafo sets none, so Celld's default, `fleet`,
     applies.
       https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/main.rs#L4285 (v0.6.0)
     "Upgrading from v0.5.1 with fleet durability requires stopping the whole
     fleet first. A fleet with bucket durability can use a rolling update."
       https://github.com/denoland/celld/releases/tag/v0.6.0
       https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/docs/README.md#L876-L882 (v0.6.0) */
  /* "Upgrading from v0.6.0 can use a rolling update."
       https://github.com/denoland/celld/releases/tag/v0.6.1
       https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/docs/README.md#L904-L916 (v0.6.1)
     The release's caveat (a Python Worker, `CELLD_LTX_RETENTION_SECS`, or
     `CELLD_MAX_ASSET_FILE_BYTES` above 25 MiB only once every node runs 0.6.1)
     is the operator's to keep, with `scafo fleet freeze` while the roll is under
     way; scafo does not enforce it. */
  ["0.6.0", "0.6.1"],
];

/**
 * `Manifest.schema_version` values this build knows. `celld deploy` writes 2
 * for a deployment that references assets and 1 for one that does not.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L11-L17 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/protocol.rs#L11-L17 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/protocol.rs#L11-L17 (v0.6.0)
 *   https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/protocol.rs#L11-L17 (v0.6.1)
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L588-L589 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/deploy.rs#L655-L656 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/deploy.rs#L655-L656 (v0.6.0)
 *   https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/deploy.rs#L665-L666 (v0.6.1)
 */
export const MANIFEST_SCHEMA_VERSIONS: readonly number[] = [1, 2];

/**
 * What an absent `Manifest.schema_version` means: upstream defaults the field
 * rather than requiring it, so a manifest written before it existed reads as 1.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L57-L59 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/protocol.rs#L57-L59 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/protocol.rs#L57-L59 (v0.6.0)
 *   https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/protocol.rs#L57-L59 (v0.6.1)
 */
export const LEGACY_MANIFEST_SCHEMA_VERSION: number = 1;

/**
 * Every `Manifest.required_features` value this build knows, mirroring
 * upstream's `SUPPORTED_DEPLOYMENT_FEATURES` — the same list its own loader
 * gates on, for the same reason: a manifest naming anything else was written by
 * a Celld that models something this does not, so nothing here may read it.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L61-L76 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/protocol.rs#L61-L76 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/protocol.rs#L61-L76 (v0.6.0)
 *   https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/protocol.rs#L61-L77 (v0.6.1)
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L307-L319 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/protocol.rs#L307-L319 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/protocol.rs#L307-L319 (v0.6.0)
 *   https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/protocol.rs#L313-L325 (v0.6.1)
 *
 * Each value, in upstream's own order:
 *   `assets-v1`     https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L78 (v0.5.0)
 *                   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/protocol.rs#L78 (v0.5.1)
 *                   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/protocol.rs#L78 (v0.6.0)
 *                   https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/protocol.rs#L79 (v0.6.1)
 *   `containers-v1` https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L79-L82 (v0.5.0)
 *                   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/protocol.rs#L79-L82 (v0.5.1)
 *                   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/protocol.rs#L79-L82 (v0.6.0)
 *                   https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/protocol.rs#L80-L83 (v0.6.1)
 *   `cron-v1`       https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L88-L91 (v0.5.0)
 *                   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/protocol.rs#L88-L91 (v0.5.1)
 *                   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/protocol.rs#L88-L91 (v0.6.0)
 *                   https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/protocol.rs#L89-L92 (v0.6.1)
 *   `d1-v1`         https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L83-L87 (v0.5.0)
 *                   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/protocol.rs#L83-L87 (v0.5.1)
 *                   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/protocol.rs#L83-L87 (v0.6.0)
 *                   https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/protocol.rs#L84-L88 (v0.6.1)
 *   `kv-v1`         https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L105-L111 (v0.5.0)
 *                   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/protocol.rs#L105-L111 (v0.5.1)
 *                   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/protocol.rs#L105-L111 (v0.6.0)
 *                   https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/protocol.rs#L111-L117 (v0.6.1)
 *   `queues-v1`     https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L113-L115 (v0.5.0)
 *                   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/protocol.rs#L113-L115 (v0.5.1)
 *                   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/protocol.rs#L113-L115 (v0.6.0)
 *                   https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/protocol.rs#L119-L121 (v0.6.1)
 *   `sqlite-vec-v1` https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L97 (v0.5.0)
 *                   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/protocol.rs#L97 (v0.5.1)
 *                   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/protocol.rs#L97 (v0.6.0)
 *                   https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/protocol.rs#L98 (v0.6.1)
 *   `r2-v1`         https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L92-L96 (v0.5.0)
 *                   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/protocol.rs#L92-L96 (v0.5.1)
 *                   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/protocol.rs#L92-L96 (v0.6.0)
 *                   https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/protocol.rs#L93-L97 (v0.6.1)
 *   `wasm-v1`       https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L98 (v0.5.0)
 *                   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/protocol.rs#L98 (v0.5.1)
 *                   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/protocol.rs#L98 (v0.6.0)
 *                   https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/protocol.rs#L99 (v0.6.1)
 *   `workflows-v1`  https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L99-L103 (v0.5.0)
 *                   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/protocol.rs#L99-L103 (v0.5.1)
 *                   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/protocol.rs#L99-L103 (v0.6.0)
 *                   https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/protocol.rs#L105-L109 (v0.6.1)
 *   `python-workers-v1`
 *                   https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/protocol.rs#L100-L104 (v0.6.1)
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
  "python-workers-v1",
];

/**
 * The one `AssetIndex.schema_version` this build knows. Upstream gives the
 * field no default, so an index that names none is not one `celld deploy`
 * wrote — and an index is the only thing that says which shared blobs a
 * deployment holds.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L382-L388 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/protocol.rs#L382-L388 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/protocol.rs#L382-L388 (v0.6.0)
 *   https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/protocol.rs#L388-L394 (v0.6.1)
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L2426-L2427 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/deploy.rs#L2624-L2625 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/deploy.rs#L2624-L2625 (v0.6.0)
 *   https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/deploy.rs#L2646-L2647 (v0.6.1)
 */
export const ASSET_INDEX_SCHEMA_VERSION: number = 1;

/**
 * THE NODE LEASE, the one record a Celld process must be able to replace before
 * it has any authority at all: `fleets/<application>/nodes/<node>.json`, filed
 * under the node's own name, which for a scafo installation is the scafo node id
 * and is therefore the SAME KEY on every restart of that machine.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/ownership_store.rs#L932 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/ownership_store.rs#L926 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/ownership_store.rs#L932 (v0.6.0)
 *   https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/ownership_store.rs#L937 (v0.6.1)
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/node_log.rs#L496-L498 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/node_log.rs#L523-L525 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/node_log.rs#L523-L525 (v0.6.0)
 *   https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/node_log.rs#L523-L525 (v0.6.1)
 *
 * A process that can neither read nor create it never establishes authority and
 * exits, over and over, on the same key:
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/main.rs#L4561 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/main.rs#L4596 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/main.rs#L4645 (v0.6.0)
 *   https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/main.rs#L4536 (v0.6.1)
 *
 * THE MINIMAL SHAPE below is what upstream REQUIRES of that object's JSON —
 * `node` and `expires_ms`, every other field carrying a serde default — so it is
 * also the whole of what says whether a body found there is a node lease at all.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/ownership_store.rs#L32-L67 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/ownership_store.rs#L32-L61 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/ownership_store.rs#L32-L61 (v0.6.0)
 *   https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/ownership_store.rs#L33-L62 (v0.6.1)
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/ownership_store.rs#L179-L197 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/ownership_store.rs#L173-L191 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/ownership_store.rs#L173-L191 (v0.6.0)
 *   https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/ownership_store.rs#L174-L192 (v0.6.1)
 */
export interface CelldNodeLease {
  /**
   * The node the lease is held BY, which upstream's own reaper requires to equal
   * the node the key is filed UNDER before it will collect the record.
   *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/logic/dead_node_reconciliation.rs#L36-L44 (v0.5.0)
   *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/logic/dead_node_reconciliation.rs#L36-L44 (v0.5.1)
   *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/logic/dead_node_reconciliation.rs#L36-L44 (v0.6.0)
   *   https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/logic/dead_node_reconciliation.rs#L36-L44 (v0.6.1)
   */
  node: string;
  /**
   * When the lease runs out, in epoch milliseconds of wall time. The liveness
   * rule is `expires_ms > now_ms` and it is upstream's everywhere: membership,
   * rebalancing, draining and the dead-node reaper all read it that way.
   *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/logic/drain.rs#L34-L37 (v0.5.0)
   *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/logic/drain.rs#L34-L37 (v0.5.1)
   *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/logic/drain.rs#L34-L37 (v0.6.0)
   *   https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/logic/drain.rs#L34-L37 (v0.6.1)
   *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/logic/dead_node_reconciliation.rs#L36-L44 (v0.5.0)
   *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/logic/dead_node_reconciliation.rs#L36-L44 (v0.5.1)
   *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/logic/dead_node_reconciliation.rs#L36-L44 (v0.6.0)
   *   https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/logic/dead_node_reconciliation.rs#L36-L44 (v0.6.1)
   */
  expires_ms: number;
}

/**
 * A node name Celld admits, and so the only kind of name a lease key carries:
 * one to 128 bytes of ASCII alphanumerics, `_`, `-` and `.`, and never `.` or
 * `..`. WIDER THAN `NODE_ID_RE` in `paths.ts`, on purpose — scafo only ever writes its
 * own node ids here, but a lease left behind by a Celld that named itself is
 * still a lease an operator must be able to name and drop.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/logic/peer.rs#L14-L25 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/logic/peer.rs#L14-L25 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/logic/peer.rs#L14-L25 (v0.6.0)
 *   https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/logic/peer.rs#L14-L25 (v0.6.1)
 */
export const CELLD_NODE_NAME_RE: RegExp = /^(?!\.{1,2}$)[A-Za-z\d_.-]{1,128}$/;

/** The verified releases as a refusal names them. */
export function verifiedReleaseList(): string {
  return VERIFIED_CELLD_RELEASES.join(", ");
}

/**
 * Whether nodes reporting Celld `a` and `b` may serve one fleet at the same
 * time: the same release, or two members of one set in
 * {@link ROLLING_CELLD_RELEASES}. Symmetric. An unreported release (`undefined`)
 * shares a fleet with nothing, itself included — nothing in it says which
 * format it writes.
 */
export function celldReleasesMayShareFleet(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  if (a === b) return true;
  return ROLLING_CELLD_RELEASES.some((set) => set.includes(a) && set.includes(b));
}

/** The rolling sets as a refusal names them: `0.5.0↔0.5.1`, or `none`. */
export function rollingReleaseList(): string {
  if (ROLLING_CELLD_RELEASES.length === 0) return "none";
  return ROLLING_CELLD_RELEASES.map((set) => set.join("↔")).join(", ");
}
