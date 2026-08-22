/*
 * Following the file an ingress writes its access log to: where it starts, what
 * a half-written line costs, and what happens when the file is rolled out from
 * under it.
 *
 * REAL FILES IN A REAL TEMPORARY DIRECTORY, because the whole of what this
 * driver does is filesystem behaviour — an inode changing under a path, a file
 * cut back to zero, a write landing between two polls. A fake would only be
 * asserting the fake.
 *
 * NO TIMER RUNS HERE. Every case steps the tailer with `poll()`, so nothing
 * waits and nothing is flaky; `start()` is only ever used for the one thing that
 * is its own — opening the file at its current end.
 */

import { appendFile, mkdtemp, rename, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AccessLogTailer, createAccessLogTailer } from "../src/drivers/observe/access-log.ts";

let directory: string;
let path: string;
let seen: string[];
let failures: unknown[];
let tailer: AccessLogTailer | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "scafo-tail-"));
  path = join(directory, "access.log");
  seen = [];
  failures = [];
  tailer = undefined;
});

afterEach(async () => {
  await tailer?.stop();
  await rm(directory, { recursive: true, force: true });
});

describe("where it starts", () => {
  it("starts at the file's CURRENT END, so a restart re-counts nothing", async () => {
    await writeFile(path, `${line("already.apps.test")}\n${line("served.apps.test")}\n`);

    await tail().start();
    await tail().poll();

    expect(seen).toEqual([]);

    await appendFile(path, `${line("after.apps.test")}\n`);
    await tail().poll();

    expect(hosts()).toEqual(["after.apps.test"]);
  });

  it("takes a file that appears later from its beginning, having no history to skip", async () => {
    /* Nothing is there when the node boots — the ingress has not served a
       request yet, or has not been started. */
    await tail().start();
    await tail().poll();

    await writeFile(path, `${line("first.apps.test")}\n${line("second.apps.test")}\n`);
    await tail().poll();

    expect(hosts()).toEqual(["first.apps.test", "second.apps.test"]);
  });

  it("is not an error to point at nothing, however long it stays nothing", async () => {
    await tail().start();
    for (let pass = 0; pass < 3; pass++) await tail().poll();

    expect(failures).toEqual([]);
    expect(seen).toEqual([]);
  });
});

describe("reading what is appended", () => {
  it("hands out complete lines in the order the file holds them", async () => {
    await writeFile(path, "");
    await tail().start();

    await appendFile(path, `${line("a.apps.test")}\n${line("b.apps.test")}\n`);
    await tail().poll();
    await appendFile(path, `${line("c.apps.test")}\n`);
    await tail().poll();

    expect(hosts()).toEqual(["a.apps.test", "b.apps.test", "c.apps.test"]);
  });

  it("HOLDS A PARTIAL LINE until its newline arrives, rather than handing out half a record", async () => {
    /* A poll can land in the middle of a write; half a JSON object would be
       counted as malformed and the other half lost. */
    await writeFile(path, "");
    await tail().start();

    const whole = line("split.apps.test");
    await appendFile(path, whole.slice(0, 20));
    await tail().poll();
    expect(seen).toEqual([]);

    await appendFile(path, whole.slice(20));
    await tail().poll();
    expect(seen).toEqual([]);

    await appendFile(path, "\n");
    await tail().poll();
    expect(seen).toEqual([whole]);
  });

  it("keeps a multi-byte character whole across a read boundary", async () => {
    await writeFile(path, "");
    /* Read in pieces small enough to cut the encoding of a single character in
       half, which is what a 64 KiB read does to a busy log eventually. */
    await tail({ maxLineBytes: 4096 }).start();

    const host = "shop--ünïcödé.apps.test";
    await appendFile(path, `${line(host)}\n`);
    await tail().poll();

    expect(JSON.parse(seen[0]).request.host).toBe(host);
  });

  it("skips blank lines and strips a carriage return, so a CRLF log reads the same", async () => {
    await writeFile(path, "");
    await tail().start();

    await appendFile(path, `${line("crlf.apps.test")}\r\n\n${line("plain.apps.test")}\n`);
    await tail().poll();

    expect(hosts()).toEqual(["crlf.apps.test", "plain.apps.test"]);
    expect(seen[0].endsWith("}")).toBe(true);
  });

  it("gives up a line past the bound rather than growing without one", async () => {
    /* A writer that never emits a newline must not be able to take the node's
       memory with it. What comes out is unreadable, which is exactly what it
       is, and it lands in the caller's malformed count. */
    await writeFile(path, "");
    await tail({ maxLineBytes: 64 }).start();

    await appendFile(path, "x".repeat(300));
    await tail().poll();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((held) => held.length <= 300)).toBe(true);
  });
});

describe("rotation", () => {
  it("follows a RENAME AND RECREATE, draining the file that was rolled away first", async () => {
    /* The shape every logrotate and Caddy's own roller uses: the open handle
       still points at the old inode, and the path now holds a new file. */
    await writeFile(path, "");
    await tail().start();

    await appendFile(path, `${line("before.apps.test")}\n`);
    /* Written after the last poll and before the roll: the lines a naive tailer
       loses, because it reopens the path and never reads the rest of the old
       file. */
    await appendFile(path, `${line("in-flight.apps.test")}\n`);

    await rename(path, `${path}.1`);
    await writeFile(path, `${line("after.apps.test")}\n`);
    await tail().poll();

    expect(hosts()).toEqual(["before.apps.test", "in-flight.apps.test", "after.apps.test"]);
  });

  it("follows a TRUNCATION IN PLACE, reading the new content and not re-reading the old", async () => {
    /* The `copytruncate` shape: the same inode, cut back to zero under us. */
    await writeFile(path, "");
    await tail().start();

    await appendFile(path, `${line("first.apps.test")}\n${line("second.apps.test")}\n`);
    await tail().poll();

    await truncate(path, 0);
    await appendFile(path, `${line("fresh.apps.test")}\n`);
    await tail().poll();

    expect(hosts()).toEqual(["first.apps.test", "second.apps.test", "fresh.apps.test"]);
  });

  it("waits out a path that is gone, and picks up whatever takes the name", async () => {
    await writeFile(path, "");
    await tail().start();

    await appendFile(path, `${line("before.apps.test")}\n`);
    await rm(path);
    await tail().poll();

    /* The file it was reading is still drained: it was still that file. */
    expect(hosts()).toEqual(["before.apps.test"]);
    expect(failures).toEqual([]);

    await writeFile(path, `${line("recreated.apps.test")}\n`);
    await tail().poll();

    expect(hosts()).toEqual(["before.apps.test", "recreated.apps.test"]);
  });

  it("does not re-read the lines it already had when a roll happens", async () => {
    await writeFile(path, "");
    await tail().start();

    await appendFile(path, `${line("one.apps.test")}\n`);
    await tail().poll();
    await rename(path, `${path}.1`);
    await writeFile(path, `${line("two.apps.test")}\n`);
    await tail().poll();
    await tail().poll();

    expect(hosts()).toEqual(["one.apps.test", "two.apps.test"]);
  });
});

describe("what it refuses to do", () => {
  it("never throws out of a poll, and reports one failure once", async () => {
    /* A path that is a directory is the shape of a mistyped setting; it fails
       the same way on every poll, and saying so every second is not more
       information than saying it once. */
    tailer = createAccessLogTailer({
      path: directory,
      onLine: (held) => seen.push(held),
      onError: (error) => failures.push(error),
    });

    await tailer.start();
    await tailer.poll();
    await tailer.poll();
    await tailer.poll();

    expect(failures).toHaveLength(1);
    expect(seen).toEqual([]);
  });

  it("carries on when a line the caller was handed throws", async () => {
    await writeFile(path, "");
    tailer = createAccessLogTailer({
      path,
      onLine: (held) => {
        seen.push(held);
        if (seen.length === 1) throw new Error("counter blew up");
      },
      onError: (error) => failures.push(error),
    });
    await tailer.start();

    await appendFile(path, `${line("one.apps.test")}\n${line("two.apps.test")}\n`);
    await tailer.poll();

    expect(hosts()).toEqual(["one.apps.test", "two.apps.test"]);
    expect(failures).toHaveLength(1);
  });

  it("reads to the end on stop, and stopping twice is the same as stopping once", async () => {
    await writeFile(path, "");
    await tail().start();

    await appendFile(path, `${line("last.apps.test")}\n`);
    /* Never polled: the request landed while the node was shutting down. */
    await tail().stop();
    await tail().stop();

    expect(hosts()).toEqual(["last.apps.test"]);
    tailer = undefined;
  });
});

/* ------------------------------------------------------------------ helpers */

/** The tailer this case is stepping, made on first use with the given options. */
function tail(opts: { maxLineBytes?: number } = {}): AccessLogTailer {
  tailer ??= createAccessLogTailer({
    path,
    onLine: (held) => seen.push(held),
    onError: (error) => failures.push(error),
    /* Long enough that the timer never fires: every case steps `poll()` itself. */
    intervalMs: 60_000,
    ...opts,
  });
  return tailer;
}

/** A Caddy-shaped access-log line for one host. */
function line(host: string): string {
  return JSON.stringify({
    level: "info",
    logger: "http.log.access.scafo",
    msg: "handled request",
    request: { method: "GET", host, uri: "/", proto: "HTTP/1.1" },
    duration: 0.001,
    size: 16,
    status: 200,
  });
}

/** The hosts of the lines handed out, in order. */
function hosts(): string[] {
  return seen.map((held) => (JSON.parse(held) as { request: { host: string } }).request.host);
}
