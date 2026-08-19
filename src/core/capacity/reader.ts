/* The seam between the pure formulas and whatever can actually read a host. */

import type { CapacityInputs, CapacityOverrides, CapacityPlan } from "./compute.ts";
import { computeCapacity } from "./compute.ts";

/**
 * Source of raw capacity inputs. Core never picks one: a caller passes the
 * reader for its runtime (`scalo/drivers/host/node`) so core stays free of
 * runtime imports.
 */
export interface HostReader {
  capacityInputs(): Promise<CapacityInputs>;
}

/** Reads the host through `reader`, then applies the capacity formulas to it. */
export async function probeCapacity(
  reader: HostReader,
  opts?: CapacityOverrides & { now?: () => Date },
): Promise<CapacityPlan> {
  return computeCapacity(await reader.capacityInputs(), opts);
}
