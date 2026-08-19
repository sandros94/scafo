/*
 * The end-to-end fixture application: it answers every request with the build's
 * own version, so a response says which build served it, and with the URL it saw,
 * so the host header the ingress forwarded is visible to the assertions.
 */

export default {
  fetch(request, env) {
    return new Response(JSON.stringify({ version: env.APP_VERSION, url: request.url }), {
      headers: { "content-type": "application/json" },
    });
  },
};
