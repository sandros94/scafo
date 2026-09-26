/* A self-contained Worker entry: no bare imports, so nothing has to bundle it. */

export default {
  fetch(request, env) {
    return new Response(JSON.stringify({ version: env.APP_VERSION, url: request.url }), {
      headers: { "content-type": "application/json" },
    });
  },
};
