// Stat sheet relay: lets the soccer graphics page on fbca.tv read a stat sheet
// shared from FBCA's OneDrive. SharePoint won't serve the file to a web page
// directly (no CORS), and its "anyone with the link" download needs the sign-in
// cookie from the first redirect, so this Worker does both steps and hands back
// the .xlsx with a CORS header.
//
// Only Excel share links on FBCA's SharePoint are fetched, and only fbca.tv may
// call it, so it can't be used as a general proxy.

const SHAREPOINT_HOST = 'fortbendchristian-my.sharepoint.com';
const ALLOWED_ORIGINS = ['https://fbca.tv', 'https://www.fbca.tv', 'http://localhost:8765'];

const corsHeaders = origin => ({
  'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : 'https://fbca.tv',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Vary': 'Origin'
});

const fail = (status, message, origin) =>
  new Response(message, { status, headers: { 'Content-Type': 'text/plain', ...corsHeaders(origin) } });

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(origin) });
    if (request.method !== 'GET') return fail(405, 'GET only', origin);
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return fail(403, 'Not allowed from this site', origin);

    let share;
    try { share = new URL(new URL(request.url).searchParams.get('url') || ''); }
    catch { return fail(400, 'Add ?url= with the stat sheet share link', origin); }
    if (share.protocol !== 'https:' || share.hostname !== SHAREPOINT_HOST || !share.pathname.startsWith('/:x:/')) {
      return fail(400, 'That is not an FBCA OneDrive Excel share link', origin);
    }
    share.searchParams.set('download', '1');

    // Step 1: the share link answers with a redirect and a FedAuth cookie.
    const first = await fetch(share.toString(), { redirect: 'manual' });
    let file = first;
    if (first.status >= 300 && first.status < 400) {
      const location = first.headers.get('Location');
      const cookies = (first.headers.getSetCookie?.() || [first.headers.get('Set-Cookie') || ''])
        .map(c => c.split(';')[0]).filter(Boolean).join('; ');
      // Step 2: follow the redirect with that cookie to get the file itself.
      file = await fetch(new URL(location, share).toString(), { headers: { Cookie: cookies } });
    }

    const type = file.headers.get('Content-Type') || '';
    if (!file.ok || !type.includes('spreadsheetml')) {
      return fail(502, file.status === 401 || file.status === 403
        ? 'OneDrive refused the link. In Excel, use Share → "Anyone with the link can view".'
        : `OneDrive answered ${file.status}`, origin);
    }
    return new Response(file.body, {
      headers: {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        ...corsHeaders(origin)
      }
    });
  }
};
