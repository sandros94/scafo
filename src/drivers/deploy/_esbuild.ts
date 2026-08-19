/*
 * Internal: finding the esbuild executable a build step is handed.
 *
 * esbuild ships its compiled binary in a per-platform optional package and
 * publishes no API that reports where that package landed. The resolution below
 * is the one esbuild performs for itself: pick the package for this platform,
 * then resolve it FROM the esbuild package rather than from here, because the
 * per-platform package is esbuild's dependency and not this one's — under a
 * strict node_modules layout it is not reachable by name from anywhere else.
 */

import { createRequire } from "node:module";
import { endianness } from "node:os";
import { ScaloError } from "../../core/error.ts";

/** Overrides the search entirely; the same variable esbuild itself honours. */
const BINARY_PATH_ENV = "ESBUILD_BINARY_PATH";

/** Per-platform package, keyed as `<platform> <arch> <endianness>`. */
const PACKAGES: Record<string, { pkg: string; subpath: string }> = {
  "aix ppc64 BE": { pkg: "@esbuild/aix-ppc64", subpath: "bin/esbuild" },
  "android arm LE": { pkg: "@esbuild/android-arm", subpath: "bin/esbuild" },
  "android arm64 LE": { pkg: "@esbuild/android-arm64", subpath: "bin/esbuild" },
  "android x64 LE": { pkg: "@esbuild/android-x64", subpath: "bin/esbuild" },
  "darwin arm64 LE": { pkg: "@esbuild/darwin-arm64", subpath: "bin/esbuild" },
  "darwin x64 LE": { pkg: "@esbuild/darwin-x64", subpath: "bin/esbuild" },
  "freebsd arm64 LE": { pkg: "@esbuild/freebsd-arm64", subpath: "bin/esbuild" },
  "freebsd x64 LE": { pkg: "@esbuild/freebsd-x64", subpath: "bin/esbuild" },
  "linux arm LE": { pkg: "@esbuild/linux-arm", subpath: "bin/esbuild" },
  "linux arm64 LE": { pkg: "@esbuild/linux-arm64", subpath: "bin/esbuild" },
  "linux ia32 LE": { pkg: "@esbuild/linux-ia32", subpath: "bin/esbuild" },
  "linux loong64 LE": { pkg: "@esbuild/linux-loong64", subpath: "bin/esbuild" },
  "linux mips64el LE": { pkg: "@esbuild/linux-mips64el", subpath: "bin/esbuild" },
  "linux ppc64 LE": { pkg: "@esbuild/linux-ppc64", subpath: "bin/esbuild" },
  "linux riscv64 LE": { pkg: "@esbuild/linux-riscv64", subpath: "bin/esbuild" },
  "linux s390x BE": { pkg: "@esbuild/linux-s390x", subpath: "bin/esbuild" },
  "linux x64 LE": { pkg: "@esbuild/linux-x64", subpath: "bin/esbuild" },
  "netbsd arm64 LE": { pkg: "@esbuild/netbsd-arm64", subpath: "bin/esbuild" },
  "netbsd x64 LE": { pkg: "@esbuild/netbsd-x64", subpath: "bin/esbuild" },
  "openbsd arm64 LE": { pkg: "@esbuild/openbsd-arm64", subpath: "bin/esbuild" },
  "openbsd x64 LE": { pkg: "@esbuild/openbsd-x64", subpath: "bin/esbuild" },
  "openharmony arm64 LE": { pkg: "@esbuild/openharmony-arm64", subpath: "bin/esbuild" },
  "sunos x64 LE": { pkg: "@esbuild/sunos-x64", subpath: "bin/esbuild" },
  "win32 arm64 LE": { pkg: "@esbuild/win32-arm64", subpath: "esbuild.exe" },
  "win32 ia32 LE": { pkg: "@esbuild/win32-ia32", subpath: "esbuild.exe" },
  "win32 x64 LE": { pkg: "@esbuild/win32-x64", subpath: "esbuild.exe" },
};

/**
 * Absolute path of the esbuild executable for the platform this node runs on.
 *
 * `ESBUILD_BINARY_PATH` wins when it is set, which is how an operator points a
 * node at a build of esbuild it installed itself. Throws
 * `ScaloError("capability-missing")` when there is nothing to point at.
 */
export function esbuildBinaryPath(env: Record<string, string | undefined> = {}): string {
  const configured = env[BINARY_PATH_ENV]?.trim();
  if (configured !== undefined && configured !== "") return configured;

  const platform = `${process.platform} ${process.arch} ${endianness()}`;
  const target = PACKAGES[platform];
  if (target === undefined) {
    throw missing(`esbuild publishes no binary for "${platform}"`);
  }

  try {
    const fromEsbuild = createRequire(createRequire(import.meta.url).resolve("esbuild"));
    return fromEsbuild.resolve(`${target.pkg}/${target.subpath}`);
  } catch (error) {
    throw missing(
      `"${target.pkg}" is not installed beside esbuild, so there is no executable to run; ` +
        `reinstall dependencies or set ${BINARY_PATH_ENV}`,
      error,
    );
  }
}

function missing(detail: string, cause?: unknown): ScaloError {
  return new ScaloError("capability-missing", "esbuild is not available", { detail, cause });
}
