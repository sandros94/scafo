/*
 * The end-to-end fixture application.
 *
 * Every request to `/` answers with the deployment's own version, so a response
 * says which deployment served it, with the two variables a `--var` deploy is
 * judged by, and with the URL it saw, so the host header the ingress forwarded
 * is visible to the assertions.
 *
 * `/count` answers from a single durable object instead. Whichever node takes
 * the request, it is routed to the one cell that owns the counter, so the
 * numbers a client sees keep rising no matter which node it asks — which is the
 * one thing a fleet spread over several nodes must get right.
 *
 * `/peek` answers with the same counter and WRITES NOTHING, so a test may wait
 * for the cell to be answering again without changing the number it is about to
 * assert on.
 */

export class Counter {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const stored = (await this.state.storage.get("n")) ?? 0;
    if (new URL(request.url).pathname === "/peek") {
      return new Response(JSON.stringify({ n: stored, url: request.url }), {
        headers: { "content-type": "application/json" },
      });
    }

    const n = stored + 1;
    await this.state.storage.put("n", n);

    return new Response(JSON.stringify({ n, url: request.url }), {
      headers: { "content-type": "application/json" },
    });
  }
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/count" || url.pathname === "/peek") {
      /* One name, so every request lands on the same cell wherever it arrived. */
      const id = env.COUNTER.idFromName("harness");
      return env.COUNTER.get(id).fetch(request);
    }

    return new Response(
      JSON.stringify({
        version: env.APP_VERSION,
        greeting: env.GREETING,
        kept: env.KEPT,
        url: request.url,
      }),
      { headers: { "content-type": "application/json" } },
    );
  },
};
