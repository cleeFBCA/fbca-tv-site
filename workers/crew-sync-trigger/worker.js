// Starts the "Sync crew signups" GitHub workflow every 5 minutes.
//
// GitHub's own schedule for that workflow is best effort and in practice runs
// every few hours, so new signups were slow to reach fbca.tv/duties. Cloudflare's
// cron triggers run on time. The workflow keeps its GitHub schedule as a backup.
//
// Needs one secret, GITHUB_TOKEN: a fine-grained GitHub token with access to only
// the fbca-tv-site repository and the "Actions: Read and write" permission.
// See README.md in this folder.

const WORKFLOW = 'https://api.github.com/repos/cleeFBCA/fbca-tv-site/actions/workflows/crew-sync.yml/dispatches';

export default {
  async scheduled(event, env) {
    const res = await fetch(WORKFLOW, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'eota-crew-sync-trigger',
      },
      body: JSON.stringify({ ref: 'main' }),
    });
    // 204 means GitHub queued the run. Anything else shows as an error in the Worker's logs.
    if (res.status !== 204) throw new Error(`GitHub said ${res.status}: ${await res.text()}`);
  },
};
