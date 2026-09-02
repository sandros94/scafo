import { describe, expect, it } from "vitest";
import { deprecatedAlias } from "../src/cli/_utils.ts";
import { keygenAlias, operator } from "../src/cli/commands/operator.ts";
import { sail, up } from "../src/cli/commands/sail.ts";

describe("what a deprecated alias is", () => {
  it("keeps the flags and the behaviour of what it aliases, wholesale", async () => {
    let ran: unknown;
    const target = {
      meta: { name: "sail", description: "the real one" },
      args: { listen: { type: "string" as const } },
      run: (context: { args: unknown }): void => {
        ran = context.args;
      },
    };

    const alias = deprecatedAlias({ name: "up", replacedBy: "scafo sail", command: target, warn });

    expect(alias.args).toBe(target.args);
    alias.run?.({ args: { listen: "0.0.0.0:7400" } } as never);
    expect(ran).toEqual({ listen: "0.0.0.0:7400" });
  });

  it("is hidden, so help teaches the new name and never the old one", () => {
    const alias = deprecatedAlias({
      name: "up",
      replacedBy: "scafo sail",
      command: { meta: { name: "sail" } },
      warn,
    });

    expect((alias.meta as { hidden?: boolean }).hidden).toBe(true);
    expect((alias.meta as { name?: string }).name).toBe("up");
  });

  it("says the new name once, before it does the work", async () => {
    const said: string[] = [];
    const alias = deprecatedAlias({
      name: "up",
      replacedBy: "scafo sail",
      command: { meta: { name: "sail" } },
      warn: (line) => said.push(line),
    });

    await alias.setup?.({ args: {}, cmd: alias, rawArgs: [] } as never);

    expect(said).toHaveLength(1);
    expect(said[0]).toContain("up");
    expect(said[0]).toContain("scafo sail");
  });

  it("still runs whatever setup the aliased command had of its own", async () => {
    const order: string[] = [];
    const alias = deprecatedAlias({
      name: "up",
      replacedBy: "scafo sail",
      command: {
        meta: { name: "sail" },
        setup: (): void => {
          order.push("setup");
        },
      },
      warn: () => order.push("warn"),
    });

    await alias.setup?.({ args: {}, cmd: alias, rawArgs: [] } as never);

    expect(order).toEqual(["warn", "setup"]);
  });
});

describe("the two aliases this wave ships", () => {
  it("keeps `up` working as `sail`, hidden and pointing at the new name", () => {
    expect((up.meta as { hidden?: boolean }).hidden).toBe(true);
    expect((up.meta as { description?: string }).description).toContain("scafo sail");
    /* The same flags, because it IS `sail` — an alias that could drift from what
       it aliases would be a second command with an old name. */
    expect(up.args).toBe(sail.args);
    expect(up.run).toBe(sail.run);
  });

  it("keeps `keygen` working as `operator keygen`, hidden and pointing at the new name", () => {
    const keygen = (operator.subCommands as Record<string, { args?: unknown; run?: unknown }>)
      .keygen;

    expect((keygenAlias.meta as { hidden?: boolean }).hidden).toBe(true);
    expect((keygenAlias.meta as { description?: string }).description).toContain(
      "scafo operator keygen",
    );
    expect(keygenAlias.args).toBe(keygen.args);
    expect(keygenAlias.run).toBe(keygen.run);
  });
});

function warn(): void {
  /* Swallowed: what the notice says has its own case above. */
}
