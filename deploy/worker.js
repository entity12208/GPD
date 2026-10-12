/**
 * Cloudflare Worker entry for the GPD web client.
 *
 * The game backend is hosted Supabase (REST + Realtime), so the Worker has no
 * game API of its own: it answers a health probe and serves the prebuilt Vite
 * bundle from the assets binding, letting the SPA fall back to index.html for
 * client-side routes.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/__health') {
      return Response.json({ ok: true, service: 'gpd-web', build: GPD_BUILD });
    }
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    headers.set('X-GPD-Worker', '1');
    return new Response(response.body, { status: response.status, headers });
  },
};

const GPD_BUILD = '1.0.0';
