/* Internal: exact ownership and teardown of one POSIX process group. */

import { ScafoError } from "../core/error.ts";

/** Poll interval while waiting for the kernel to report a process group gone. */
const GROUP_EXIT_POLL_MS = 10;

/** Refuses a runtime where exact descendant teardown is unavailable. */
export function assertProcessGroups(): void {
  if (process.platform !== "win32") return;
  throw new ScafoError("capability-missing", "POSIX process groups are required", {
    detail: "process descendants cannot be stopped and awaited exactly on this runtime",
  });
}

/** Process-group id of a spawned group leader. */
export function processGroupId(pid: number | undefined, subject: string): number {
  if (pid !== undefined) return pid;
  throw new ScafoError("capability-missing", "Process group was not created", {
    detail: `"${subject}" started without a process id, so its descendants cannot be managed`,
  });
}

/**
 * Stops every process in `groupId`, escalating after `graceMs` when one is
 * provided, and resolves only once the kernel reports the whole group gone.
 */
export async function stopProcessGroup(
  groupId: number,
  opts?: { graceMs?: number },
): Promise<void> {
  if (opts?.graceMs === undefined) {
    await signalAndConfirmExit(groupId, "SIGKILL");
    return;
  }

  let termError: unknown;
  let signalled = false;
  try {
    signalled = signalGroup(groupId, "SIGTERM");
  } catch (error) {
    termError = error;
  }
  if (!signalled && termError === undefined) return;

  const gone = waitForGroupExit(groupId);
  if (!(await settlesWithin(gone, opts.graceMs))) {
    await signalAndConfirmExit(groupId, "SIGKILL");
  }
  await gone;
  if (termError !== undefined) throw termError;
}

/** Waits until no process remains in the group. */
export async function waitForGroupExit(groupId: number): Promise<void> {
  while (groupExists(groupId)) await delay(GROUP_EXIT_POLL_MS);
}

/** Signals one process group, answering false only when it is already gone. */
function signalGroup(groupId: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-groupId, signal);
    return true;
  } catch (error) {
    if (errno(error) === "ESRCH") return false;
    throw new ScafoError("capability-missing", "Process group could not be stopped", {
      detail: `process group ${String(groupId)} could not receive ${signal}`,
      cause: error,
    });
  }
}

/** A signal failure never lets cleanup return before absence is confirmed. */
async function signalAndConfirmExit(groupId: number, signal: NodeJS.Signals): Promise<void> {
  let signalError: unknown;
  try {
    signalGroup(groupId, signal);
  } catch (error) {
    signalError = error;
  }
  await waitForGroupExit(groupId);
  if (signalError !== undefined) throw signalError;
}

/** Whether the kernel still knows any process in this group. */
function groupExists(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    const code = errno(error);
    if (code === "ESRCH") return false;
    /* EPERM still proves the group exists; every other answer is not a safe
       basis for declaring descendants gone. */
    if (code === "EPERM") return true;
    throw new ScafoError("capability-missing", "Process group could not be observed", {
      detail: `process group ${String(groupId)} could not be checked for exit`,
      cause: error,
    });
  }
}

/** True when `promise` settles before the grace elapses. */
function settlesWithin(promise: Promise<void>, graceMs: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(false), graceMs);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errno(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}
