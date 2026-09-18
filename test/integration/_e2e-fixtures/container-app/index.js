/*
 * The end-to-end fixture application for container classes.
 *
 * `/` answers with the deployment's own version. `/sidecar` is the class the
 * config attaches a container to, and it drives the container itself through
 * the `ctx.container` primitive rather than through `@cloudflare/containers`:
 * an artifact with no dependency to install is one the runtime bundles as it
 * arrives.
 *
 * `start()` IS FIRE AND FORGET, so the port is not listening when it returns
 * and a failed start reports itself by the fetch that follows. The retry below
 * is the minimal form of the published class's start loop: retry while the
 * message says the port is not listening, and answer with whatever went wrong
 * otherwise, so a failure reaches the test as a body rather than a timeout.
 */

/** How long the start loop waits for the port in all, and between two tries. */
const DEADLINE_MS = 10_000;
const WAIT_MS = 250;
/**
 * What one try gets. BOUNDED, because an unreachable route does not refuse: a
 * node that cannot reach its container's bridge hangs on the connection instead
 * of failing, and a request that hangs says nothing to whoever is reading.
 */
const TRY_MS = 1_000;

export class Sidecar {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const container = this.state.container;
    if (container === undefined) {
      return answer(500, { error: "this class has no ctx.container surface" });
    }

    if (!container.running) container.start();

    let last = "the container was never asked";
    const giveUp = Date.now() + DEADLINE_MS;
    while (Date.now() < giveUp) {
      try {
        const served = await Promise.race([
          container.getTcpPort(8080).fetch("http://container/index.html"),
          rejectAfter(TRY_MS),
        ]);
        return new Response(await served.text(), {
          status: served.status,
          headers: { "content-type": "application/json" },
        });
      } catch (error) {
        last = error?.message ?? String(error);
        /* A port that is not up yet, or a route that answers nothing, is worth
           another try; anything else is the answer this request has. */
        if (!/not listening|no answer/i.test(last)) break;
        await new Promise((wake) => setTimeout(wake, WAIT_MS));
      }
    }

    return answer(503, { error: last, url: request.url });
  }
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/sidecar") {
      /* One name, so every request reaches the one cell that owns the
         container this deployment declared. */
      const id = env.SIDECAR.idFromName("harness");
      return env.SIDECAR.get(id).fetch(request);
    }

    return answer(200, { version: env.APP_VERSION, url: request.url });
  },
};

function rejectAfter(ms) {
  return new Promise((_, fail) => {
    setTimeout(() => fail(new Error(`no answer from the container port in ${ms}ms`)), ms);
  });
}

function answer(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
