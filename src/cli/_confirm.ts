/*
 * The one question the CLI puts before it destroys something.
 *
 * A destructive command asks at the terminal and acts on the answer; the same
 * command in a script has nobody to ask, so it refuses rather than guessing that
 * silence meant yes. `--yes` is how a script answers ahead of the question, and
 * the refusal names it.
 *
 * Deliberately not consola's confirm widget: the answer is one typed line, so
 * the question reads the same whether it is answered by hand, by a pipe, or by a
 * test that hands one over.
 */

import { createInterface } from "node:readline/promises";
import { ScafoError } from "../core/error.ts";

export interface ConfirmOptions {
  /** The command that is about to destroy something, as an operator types it. */
  command: string;
  /** Whether there is somebody to ask. Defaults to what stdin says. */
  isTTY?: boolean;
  /** How the question is put and the answer read. Defaults to one line from the terminal. */
  ask?: (question: string) => Promise<string>;
}

/**
 * Puts `question` and reads the answer. True for `y` or `yes` in any casing and
 * nothing else: an answer nobody typed, or one that was typed at something else,
 * is not consent.
 *
 * Throws `ScafoError("invalid-input")` when there is no terminal to ask at and
 * nothing answered ahead of time.
 */
export async function confirm(question: string, opts: ConfirmOptions): Promise<boolean> {
  if (!(opts.isTTY ?? process.stdin.isTTY === true)) {
    throw new ScafoError("invalid-input", "Nothing to answer with", {
      detail:
        `"${opts.command}" deletes, and its input is not a terminal, so there is nobody to ` +
        `ask: pass --yes to answer on the command line`,
    });
  }

  const answer = await (opts.ask ?? askTerminal)(question);
  const said = answer.trim().toLowerCase();
  return said === "y" || said === "yes";
}

/** One line read from the terminal, with the question left on it. */
async function askTerminal(question: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question(question);
  } finally {
    terminal.close();
  }
}
