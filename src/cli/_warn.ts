/*
 * Warnings the CLI prints beside its work.
 *
 * On STDERR, so a command whose output is piped somewhere keeps that output
 * clean, and behind ONE opt-out switch rather than a flag per command: an
 * operator who runs scafo from a script has one place to say they have read the
 * warnings, and every future warning is covered by the same decision.
 */

/** Environment variable that silences every warning below; set it to `1`. */
export const SILENCE_WARNINGS_ENV: string = "SCAFO_SILENCE_WARNINGS";

/** Prints `scafo: warning: <text>` on stderr, unless warnings are silenced. */
export function warn(text: string): void {
  /* Read at every call rather than at import: a long-lived process can be told
     to stop warning, and a test can toggle it between two calls. */
  if (process.env[SILENCE_WARNINGS_ENV] === "1") return;
  console.warn(`scafo: warning: ${text}`);
}

/**
 * Says that a command may change under the operator, and why.
 *
 * The WHY is the point. A command marked unstable with no reason is one an
 * operator either ignores or stops using; one that names what would replace it
 * tells them what to watch for.
 */
export function warnUnstable(command: string, why: string): void {
  warn(`"${command}" is subject to change: ${why}`);
}
