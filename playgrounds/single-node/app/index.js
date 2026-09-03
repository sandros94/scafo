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
      const id = env.COUNTER.idFromName("playground");
      return env.COUNTER.get(id).fetch(request);
    }

    return new Response(JSON.stringify({ version: env.APP_VERSION, url: request.url }), {
      headers: { "content-type": "application/json" },
    });
  },
};
