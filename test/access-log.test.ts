/*
 * Reading one line of an ingress's access log: which format it is, what comes
 * out of it, and what a line nothing can read costs.
 *
 * The fixtures are shaped from the two documented schemas and checked against
 * lines a Caddy 2.11.4 and a Traefik 3.7.11 actually wrote — including the two
 * `as written` cases below, which are verbatim output of those two servers.
 * Every field either format carries is present, because a parser that only ever
 * sees the fields it reads is not being asked the question.
 */

import { describe, expect, it } from "vitest";
import {
  type AccessLogFormat,
  detectAccessLogFormat,
  parseAccessLogLine,
} from "../src/core/utils/access-log.ts";

/* A line Caddy 2.11.4 wrote, copied out of its access log unaltered. */
const CADDY_AS_WRITTEN =
  '{"level":"info","ts":1787402601.4455624,"logger":"http.log.access.scafo",' +
  '"msg":"handled request","request":{"remote_ip":"127.0.0.1","remote_port":"52910",' +
  '"client_ip":"127.0.0.1","proto":"HTTP/1.1","method":"GET",' +
  '"host":"shop--preview.scafo.test","uri":"/","headers":{"User-Agent":["Wget"],' +
  '"Accept":["*/*"],"Connection":["close"]}},"bytes_read":0,"user_id":"",' +
  '"duration":0.000084058,"size":16,"status":200,"resp_headers":{"Server":["Caddy"],' +
  '"Content-Type":["text/plain; charset=utf-8"]}}';

/* A line Traefik 3.7.11 wrote with `--accesslog.format=json`, likewise unaltered. */
const TRAEFIK_AS_WRITTEN =
  '{"ClientAddr":"127.0.0.1:45082","ClientHost":"127.0.0.1","ClientPort":"45082",' +
  '"ClientUsername":"-","DownstreamContentSize":11,"DownstreamStatus":502,' +
  '"Duration":1792424,"OriginContentSize":11,"OriginDuration":1084840,"OriginStatus":502,' +
  '"Overhead":707584,"RequestAddr":"shop--preview.scafo.test","RequestContentSize":0,' +
  '"RequestCount":1,"RequestHost":"shop--preview.scafo.test","RequestMethod":"GET",' +
  '"RequestPath":"/","RequestPort":"-","RequestProtocol":"HTTP/1.1","RequestScheme":"http",' +
  '"RetryAttempts":0,"RouterName":"r1@file","ServiceAddr":"127.0.0.1:9999",' +
  '"ServiceName":"s1@file","ServiceURL":"http://127.0.0.1:9999",' +
  '"StartLocal":"2026-08-22T12:43:45.465200759Z","StartUTC":"2026-08-22T12:43:45.465200759Z",' +
  '"entryPointName":"web","level":"info","msg":"","time":"2026-08-22T12:43:45Z"}';

describe("what each format is read as", () => {
  it("reads Caddy's own line: host, method, status, size, and seconds as milliseconds", () => {
    expect(parseAccessLogLine(CADDY_AS_WRITTEN)).toEqual({
      format: "caddy",
      host: "shop--preview.scafo.test",
      method: "GET",
      status: 200,
      bytes: 16,
      /* `duration` is SECONDS as a float, which is the one unit conversion that
         separates the two formats from each other. */
      durationMs: 0.084058,
    });
  });

  it("reads Traefik's own line: RequestHost, DownstreamStatus, and nanoseconds as milliseconds", () => {
    expect(parseAccessLogLine(TRAEFIK_AS_WRITTEN)).toEqual({
      format: "traefik",
      host: "shop--preview.scafo.test",
      method: "GET",
      status: 502,
      bytes: 11,
      durationMs: 1.792424,
    });
  });

  it("takes the DOWNSTREAM status and size from Traefik, never the origin's", () => {
    /* What the client got is what a platform's users experienced; a middleware
       chain that turned a 500 into a 503 is the answer that was served. */
    const line = traefikLine({
      RequestHost: "shop.apps.test",
      OriginStatus: 500,
      OriginContentSize: 90,
      DownstreamStatus: 503,
      DownstreamContentSize: 12,
    });

    expect(parseAccessLogLine(line)).toMatchObject({ status: 503, bytes: 12 });
  });

  it("agrees on the same request through either ingress", () => {
    const caddy = parseAccessLogLine(
      caddyLine({ host: "shop--preview.apps.test", status: 204, size: 0, duration: 0.0125 }),
    );
    const traefik = parseAccessLogLine(
      traefikLine({
        RequestHost: "shop--preview.apps.test",
        DownstreamStatus: 204,
        DownstreamContentSize: 0,
        Duration: 12_500_000,
      }),
    );

    expect({ ...caddy, format: undefined }).toEqual({ ...traefik, format: undefined });
    expect([caddy?.format, traefik?.format]).toEqual(["caddy", "traefik"]);
  });
});

describe("detection", () => {
  it("names each format from keys only the other never carries", () => {
    const cases: Array<[Record<string, unknown>, AccessLogFormat | null]> = [
      [JSON.parse(CADDY_AS_WRITTEN) as Record<string, unknown>, "caddy"],
      [JSON.parse(TRAEFIK_AS_WRITTEN) as Record<string, unknown>, "traefik"],
      /* Caddy's own runtime log carries no `request`, which is what a node
         pointed at the wrong file is reading. */
      [{ level: "info", logger: "tls", msg: "cleaning storage unit" }, null],
      [{ hello: "world" }, null],
    ];

    for (const [entry, expected] of cases) {
      expect(detectAccessLogFormat(entry), JSON.stringify(entry).slice(0, 60)).toBe(expected);
    }
  });

  it("decides PER LINE, so a rotated or concatenated file cannot wedge it", () => {
    /* One format follows the other with nothing in between, which is what a file
       an operator rolled over onto a different ingress looks like. */
    const read = [CADDY_AS_WRITTEN, TRAEFIK_AS_WRITTEN, CADDY_AS_WRITTEN].map((line) =>
      parseAccessLogLine(line),
    );

    expect(read.map((entry) => entry?.format)).toEqual(["caddy", "traefik", "caddy"]);
  });
});

describe("the host, as the two ingresses write it", () => {
  it("strips the port Caddy leaves on it and lowercases what it is given", () => {
    /* Caddy logs `r.Host` verbatim, so a client that sent a port is recorded
       with it; Traefik's RequestHost is already the name alone. Both have to
       come out as the name a routing can be asked about. */
    const cases: Array<[string, string | undefined]> = [
      ["shop.scafo.test:8080", "shop.scafo.test"],
      ["SHOP--Preview.Apps.Test", "shop--preview.apps.test"],
      ["[::1]:7400", "::1"],
      ["[2001:db8::1]", "2001:db8::1"],
      ["127.0.0.1:80", "127.0.0.1"],
      /* Not a name scafo minted, but a name a request really carried: parsing
         says what it saw and attribution decides it belongs to nobody. */
      ["not a host", "not a host"],
      ["   ", undefined],
      [":8080", undefined],
    ];

    for (const [written, expected] of cases) {
      expect(parseAccessLogLine(caddyLine({ host: written }))?.host, written).toBe(expected);
    }
  });
});

describe("a line that cannot be read", () => {
  it("is null rather than a throw, whatever is wrong with it", () => {
    const lines = [
      "",
      "   ",
      "not json at all",
      "{",
      '{"unterminated": ',
      "[1, 2, 3]",
      "null",
      '"a string"',
      /* JSON, an object, and of no format this knows. */
      '{"level":"info","msg":"started"}',
      /* Caddy-shaped but carrying no host. */
      '{"request":{"method":"GET"},"status":200}',
      /* Traefik-shaped but carrying no status. */
      '{"RequestHost":"shop.apps.test","RequestMethod":"GET"}',
      /* A status that is not a number at all. */
      '{"RequestHost":"shop.apps.test","DownstreamStatus":"gone"}',
    ];

    for (const line of lines) {
      expect(parseAccessLogLine(line), JSON.stringify(line)).toBeNull();
    }
  });

  it("keeps a request whose size or duration is missing, because those are optional", () => {
    /* A host and a status are what make a line a request. A field the ingress
       chose not to write is a zero, not a broken record — dropping the line
       would lose the request itself over a number nobody logged. */
    const line = '{"request":{"host":"shop.apps.test","method":"get"},"status":301}';

    expect(parseAccessLogLine(line)).toEqual({
      format: "caddy",
      host: "shop.apps.test",
      method: "GET",
      status: 301,
      bytes: 0,
      durationMs: 0,
    });
  });

  it("reads a quoted number, and refuses a negative one as no number at all", () => {
    expect(
      parseAccessLogLine(
        '{"RequestHost":"shop.apps.test","DownstreamStatus":"404",' +
          '"DownstreamContentSize":"512","Duration":"2000000"}',
      ),
    ).toMatchObject({ status: 404, bytes: 512, durationMs: 2 });

    /* A negative size or duration is not a measurement; it must not subtract
       from a counter it lands in. */
    expect(
      parseAccessLogLine(
        '{"RequestHost":"shop.apps.test","DownstreamStatus":200,' +
          '"DownstreamContentSize":-5,"Duration":-1}',
      ),
    ).toMatchObject({ bytes: 0, durationMs: 0 });
  });
});

/* ------------------------------------------------------------------ helpers */

/**
 * A Caddy access-log line, carrying every field the documented `json` encoder
 * writes for a handled request. Overrides land on the request object where the
 * field lives there (`host`, `method`, `uri`) and at the top level otherwise.
 */
function caddyLine(over: Record<string, unknown> = {}): string {
  const request: Record<string, unknown> = {
    remote_ip: "203.0.113.7",
    remote_port: "41342",
    client_ip: "203.0.113.7",
    proto: "HTTP/2.0",
    method: "GET",
    host: "shop.apps.test",
    uri: "/",
    headers: { "User-Agent": ["curl/8.19.0"], "Accept": ["*/*"] },
    tls: {
      resumed: false,
      version: 772,
      cipher_suite: 4865,
      proto: "h2",
      server_name: "apps.test",
    },
  };
  const entry: Record<string, unknown> = {
    level: "info",
    ts: 1_787_402_601.4455624,
    logger: "http.log.access.scafo",
    msg: "handled request",
    request,
    bytes_read: 0,
    user_id: "",
    duration: 0.000_929_675,
    size: 10_900,
    status: 200,
    resp_headers: { "Server": ["Caddy"], "Content-Type": ["text/html; charset=utf-8"] },
  };

  for (const [key, value] of Object.entries(over)) {
    if (key in request) request[key] = value;
    else entry[key] = value;
  }
  return JSON.stringify(entry);
}

/** A Traefik access-log line, carrying every field its documented json format writes. */
function traefikLine(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ClientAddr: "203.0.113.7:45082",
    ClientHost: "203.0.113.7",
    ClientPort: "45082",
    ClientUsername: "-",
    DownstreamContentSize: 1234,
    DownstreamStatus: 200,
    Duration: 45_678_900,
    GzipRatio: 0,
    OriginContentSize: 1234,
    OriginDuration: 44_000_000,
    OriginStatus: 200,
    Overhead: 1_678_900,
    RequestAddr: "shop.apps.test",
    RequestContentSize: 0,
    RequestCount: 12,
    RequestHost: "shop.apps.test",
    RequestMethod: "GET",
    RequestPath: "/",
    RequestPort: "-",
    RequestProtocol: "HTTP/1.1",
    RequestScheme: "https",
    RetryAttempts: 0,
    RouterName: "scafo-shop@http",
    ServiceAddr: "127.0.0.1:9101",
    ServiceName: "scafo-shop@http",
    ServiceURL: "http://127.0.0.1:9101",
    StartLocal: "2026-08-22T12:43:45.465200759Z",
    StartUTC: "2026-08-22T12:43:45.465200759Z",
    TLSCipher: "TLS_AES_128_GCM_SHA256",
    TLSVersion: "1.3",
    entryPointName: "websecure",
    level: "info",
    msg: "",
    time: "2026-08-22T12:43:45Z",
    ...over,
  });
}
