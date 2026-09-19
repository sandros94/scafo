/*
 * The TCP delay proxy every node and every CLI of a `pnpm scale:real` run
 * reaches the bucket through.
 *
 * IT DELAYS AT THE TCP LEVEL, never at the HTTP one: each chunk travelling from
 * a client to the store is held `--delay-ms` before it is forwarded, and nothing
 * about the bytes is touched, so request signing is exactly what the client
 * produced. A run with no added latency still goes through here, so two cells of
 * one sweep differ in the delay alone.
 *
 * It also COUNTS what passes: the request line and the `Content-Length` of every
 * request are enough to say how many GET/PUT/LIST/DELETE the store was asked
 * for, and the key each one names says which keyspace it belongs to — Scafo's
 * registry, or the runtime's own. Both live behind one TCP connection from one
 * container, so the keyspace is the only thing that tells the two apart; the
 * report says so rather than claiming a per-process split.
 *
 * Plain Node, `node:net` and `node:http` only, run from the node image. Its
 * counters are served as JSON at `--stats`.
 */

import { createServer as createHttpServer } from "node:http";
import { createConnection, createServer } from "node:net";

const options = parseArgs(process.argv.slice(2));

/** Everything seen since the proxy started; a caller reports deltas of it. */
const totals = {
  connections: 0,
  openConnections: 0,
  bytesToStore: 0,
  bytesFromStore: 0,
  /** `"<METHOD> <keyspace>"` to how many times it was asked for. */
  requests: Object.create(null),
  /** Requests whose framing this parser could not follow, so were not counted. */
  unparsed: 0,
};

const server = createServer((client) => {
  totals.connections += 1;
  totals.openConnections += 1;

  const upstream = createConnection({ host: options.upstream.host, port: options.upstream.port });
  const reader = createRequestReader();
  /* One chain per connection, so a delay never reorders what a client wrote. */
  let tail = Promise.resolve();

  client.on("data", (chunk) => {
    totals.bytesToStore += chunk.length;
    reader.take(chunk);
    client.pause();
    tail = tail.then(async () => {
      if (options.delayMs > 0) await sleep(options.delayMs);
      upstream.write(chunk);
      client.resume();
    });
  });
  upstream.on("data", (chunk) => {
    totals.bytesFromStore += chunk.length;
    if (!client.write(chunk)) {
      upstream.pause();
      client.once("drain", () => upstream.resume());
    }
  });

  const close = () => {
    totals.openConnections -= 1;
    client.destroy();
    upstream.destroy();
  };
  client.on("end", () => tail.then(() => upstream.end()));
  upstream.on("end", () => client.end());
  client.on("error", close);
  upstream.on("error", close);
  client.on("close", close);
});

server.listen(options.listen.port, options.listen.host, () => {
  process.stdout.write(
    `delay-proxy: listening on ${options.listen.host}:${String(options.listen.port)}, ` +
      `upstream ${options.upstream.host}:${String(options.upstream.port)}, ` +
      `delay ${String(options.delayMs)}ms\n`,
  );
});

createHttpServer((request, response) => {
  if (request.url === "/stats") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(totals));
    return;
  }
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("only /stats\n");
}).listen(options.stats.port, options.stats.host);

/**
 * Follows one client's stream well enough to name each request it carries.
 *
 * A keep-alive connection carries request after request, so the body of one must
 * be skipped to find the line of the next: headers are read, `Content-Length`
 * says how many bytes to skip, and the parser goes back to reading headers. A
 * chunked request body has no such length, so the connection is abandoned for
 * counting from there on and what it still carried is reported as `unparsed`
 * rather than guessed at.
 */
function createRequestReader() {
  /** Headers this parser will read before it gives up on a connection. */
  const HEADER_LIMIT = 256 * 1024;

  let buffer = Buffer.alloc(0);
  let skipping = 0;
  let lost = false;

  return {
    take(chunk) {
      if (lost) return;
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);

      for (;;) {
        if (skipping > 0) {
          const dropped = Math.min(skipping, buffer.length);
          skipping -= dropped;
          buffer = buffer.subarray(dropped);
          if (skipping > 0) return;
        }
        const end = buffer.indexOf("\r\n\r\n");
        if (end === -1) {
          if (buffer.length > HEADER_LIMIT) {
            lost = true;
            totals.unparsed += 1;
          }
          return;
        }

        const head = buffer.subarray(0, end).toString("latin1");
        buffer = buffer.subarray(end + 4);
        const framing = readHead(head);
        if (framing === null) {
          lost = true;
          totals.unparsed += 1;
          return;
        }
        count(framing.method, framing.target);
        skipping = framing.bodyBytes;
      }
    },
  };
}

/**
 * The method, target and body length of one request head, or `null` when this
 * parser cannot say how long the body is.
 */
function readHead(head) {
  const lines = head.split("\r\n");
  const requestLine = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(lines[0] ?? "");
  if (requestLine === null) return null;

  let bodyBytes = 0;
  for (const line of lines.slice(1)) {
    const at = line.indexOf(":");
    if (at < 0) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (name === "transfer-encoding" && value.toLowerCase().includes("chunked")) return null;
    if (name === "content-length") {
      const length = Number.parseInt(value, 10);
      if (!Number.isSafeInteger(length) || length < 0) return null;
      bodyBytes = length;
    }
  }
  return { method: requestLine[1], target: requestLine[2], bodyBytes };
}

/** Records one request under the method it used and the keyspace it named. */
function count(method, target) {
  const decoded = decode(target);
  const listed = method === "GET" && /[?&](list-type|prefix|marker|delimiter)=/.test(decoded);
  const key = `${listed ? "LIST" : method} ${keyspaceOf(decoded)}`;
  totals.requests[key] = (totals.requests[key] ?? 0) + 1;
}

/**
 * Which keyspace a request target names.
 *
 * BY PREFIX, WHICH IS NOT BY PROCESS: a node and the runtime processes it
 * supervises share this connection's source, so nothing here says which of them
 * sent a request. What it does say is whose keyspace was touched — Scafo writes
 * `_scafo/`, and the runtime owns `fleets/`, `deploy/` and `deploy-blobs/`.
 */
function keyspaceOf(target) {
  if (target.includes("_scafo/")) return "scafo";
  if (target.includes("fleets/")) return "celld-fleets";
  if (target.includes("deploy-blobs/")) return "celld-blobs";
  if (target.includes("deploy/")) return "celld-deploy";
  return "other";
}

function decode(target) {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

function parseArgs(argv) {
  const named = new Map();
  for (let i = 0; i < argv.length; i += 2) named.set(argv[i], argv[i + 1]);
  const hostPort = (flag, fallback) => {
    const value = named.get(flag) ?? fallback;
    const at = value.lastIndexOf(":");
    return { host: value.slice(0, at), port: Number.parseInt(value.slice(at + 1), 10) };
  };
  return {
    listen: hostPort("--listen", "0.0.0.0:8333"),
    upstream: hostPort("--upstream", "127.0.0.1:8333"),
    stats: hostPort("--stats", "0.0.0.0:9099"),
    delayMs: Number.parseInt(named.get("--delay-ms") ?? "0", 10),
  };
}

function sleep(ms) {
  return new Promise((settle) => setTimeout(settle, ms));
}
