/* What a CLI warning looks like, and the one switch that silences every one of them. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { warn, warnUnstable } from "../src/cli/_warn.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("warn", () => {
  it("prints one prefixed line, on the stream a warning belongs on", () => {
    const said = capture();

    warn("the fleet is running two celld versions");

    expect(said()).toEqual(["scafo: warning: the fleet is running two celld versions"]);
  });

  it("says nothing once the operator has opted out of warnings", () => {
    vi.stubEnv("SCAFO_SILENCE_WARNINGS", "1");
    const said = capture();

    warn("the fleet is running two celld versions");

    expect(said()).toEqual([]);
  });

  it("reads the switch at every call, so turning it off turns warnings back on", () => {
    const said = capture();

    vi.stubEnv("SCAFO_SILENCE_WARNINGS", "1");
    warn("silenced");
    vi.stubEnv("SCAFO_SILENCE_WARNINGS", "0");
    warn("heard");

    expect(said()).toEqual(["scafo: warning: heard"]);
  });
});

describe("warnUnstable", () => {
  it("names the command, says it may change, and says why", () => {
    const said = capture();

    warnUnstable("scafo build prune", "upstream may replace it");

    expect(said()).toEqual([
      `scafo: warning: "scafo build prune" is subject to change: upstream may replace it`,
    ]);
  });

  it("is silenced by the same switch as every other warning", () => {
    vi.stubEnv("SCAFO_SILENCE_WARNINGS", "1");
    const said = capture();

    warnUnstable("scafo build prune", "upstream may replace it");

    expect(said()).toEqual([]);
  });
});

/** Everything written to the warning stream, in the order it was written. */
function capture(): () => string[] {
  const lines: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return () => lines;
}
