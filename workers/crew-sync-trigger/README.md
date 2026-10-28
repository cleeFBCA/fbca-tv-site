# Crew sync trigger (Cloudflare Worker)

Starts the **Sync crew signups** GitHub workflow every 10 minutes, because
GitHub's own schedule only runs it every few hours. Free on Cloudflare's
Workers free plan. It has no web address; it only runs on its schedule.

## Set up (once)

1. **GitHub token.** github.com → Settings → Developer settings → Personal access
   tokens → Fine-grained tokens → Generate new token.
   - Name: `EOTA crew sync trigger`
   - Expiration: the longest offered. Put the date on your calendar.
   - Repository access: **Only select repositories** → `fbca-tv-site`
   - Permissions → Repository permissions → **Actions: Read and write**
   - Generate, and copy the token.
2. In this folder, sign in to Cloudflare: `npx wrangler login`
3. Deploy: `npx wrangler deploy`
4. Save the token in Cloudflare (paste it when asked): `npx wrangler secret put GITHUB_TOKEN`

## Check it's working

- GitHub: fbca-tv-site → Actions → Sync crew signups. Runs marked
  "workflow_dispatch" should appear every 10 minutes.
- Cloudflare: Workers & Pages → eota-crew-sync-trigger → Logs. An error like
  `GitHub said 401` means the token expired or was deleted: make a new one
  (step 1) and save it again (step 3).
