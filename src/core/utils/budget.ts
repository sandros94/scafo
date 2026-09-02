/* Local elapsed-time budgets use a monotonic clock; persisted timestamps use
   the registry wall clock. */

/** Starts a monotonic wait budget; `<= 0` means expired. */
export function startBudget(ms: number): () => number {
  const deadline = performance.now() + Math.max(0, ms);
  return (): number => deadline - performance.now();
}
