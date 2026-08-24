/*
 * The playground application. Two routes, and each one exists to make something
 * about scafo visible from a `curl`.
 *
 * `/` answers with the build's own version and with the URL it saw. The version
 * is what makes a flip observable — deploy a second build with a different one
 * and the answer changes the moment the alias moves. The URL is the host header
 * the ingress forwarded, which is every routing decision scafo made, echoed back.
 *
 * `/count` answers from a durable object instead. One name means one cell, and
 * one cell has exactly one owner however many nodes serve the environment: the
 * numbers keep rising whichever node the request arrives at. On one node that is
 * merely true; on two it is the whole point, and the multi-node playground is
 * where it is worth watching.
 */

export class Counter {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const n = ((await this.state.storage.get("n")) ?? 0) + 1;
    await this.state.storage.put("n", n);

    return new Response(JSON.stringify({ n, url: request.url }), {
      headers: { "content-type": "application/json" },
    });
  }
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/count") {
      /* One name, so every request lands on the same cell wherever it arrived. */
      const id = env.COUNTER.idFromName("playground");
      return env.COUNTER.get(id).fetch(request);
    }

    return new Response(JSON.stringify({ version: env.APP_VERSION, url: request.url }), {
      headers: { "content-type": "application/json" },
    });
  },
};
