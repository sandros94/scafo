/*
 * How much of a local wait is left, on a clock that cannot step.
 *
 * A BUDGET IS A DURATION AND A STAMP IS AN INSTANT, and they need different
 * clocks. The wall clock is what records are stamped from, because it is the
 * only one two nodes share — but it is also the one that JUMPS: an NTP
 * correction, a resumed virtual machine, an operator setting the date. A wait
 * that sleeps on timers, which measure elapsed time, while budgeting against the
 * wall clock silently spends its budget on a forward jump and gives up on work
 * that had not run out of time; a backward one makes it wait however far back
 * the clock went.
 *
 * So: anything asking "how long may this go on for" measures here, and anything
 * written into a record for another node to compare against stays on the
 * registry's wall clock.
 */

/**
 * Starts a wait budget of `ms` and answers how much of it is left; zero or less
 * once it has run out, so `<= 0` is the test for expiry.
 *
 * The result is only ever compared against itself, and says nothing about what
 * time it is — a caller that needs to record WHEN something happened wants
 * `nowIso` and the registry's clock instead.
 */
export function startBudget(ms: number): () => number {
  const deadline = performance.now() + Math.max(0, ms);
  return (): number => deadline - performance.now();
}
