# scripts/

Node scripts for site tooling. Run via `npm run <script>` from the repo root.

## gsc-analytics — Google Search Console

Queries the Search Console API and prints JSON to stdout. Auth uses a service account key stored outside the repo.

### Setup (one-time)

1. Create or select a Google Cloud project at [console.cloud.google.com](https://console.cloud.google.com).
2. Enable the **Google Search Console API** for that project.
3. Create a **service account**, generate a JSON key, and download it.
4. Move the key outside the repo, e.g.:
   ```
   mkdir -p ~/.config/kom
   mv ~/Downloads/<key>.json ~/.config/kom/google-service-account.json
   ```
5. Set `GOOGLE_SERVICE_ACCOUNT_FILE` in `.env` to that absolute path, e.g.:
   ```
   GOOGLE_SERVICE_ACCOUNT_FILE=/Users/you/.config/kom/google-service-account.json
   ```
6. In Search Console → Settings → Users and permissions, add the service account's `client_email` as a **Restricted** user on the `kaiwalya.com` domain property.

The key lives entirely outside the repo, so no `.gitignore` changes are needed.

The script derives the GSC property from `SITE_URL` — `https://kaiwalya.com` becomes `sc-domain:kaiwalya.com`. This assumes the property is registered as a Domain property in GSC (not URL-prefix).

### Usage

```bash
# Top 5 queries from the last 28 days
npm run gsc -- --report queries --limit 5

# All five dimensions bundled into one JSON object
npm run gsc -- --report all

# Specific date range
npm run gsc -- --report pages --start-date 2026-01-01 --end-date 2026-04-01
```

Available `--report` values: `queries`, `pages`, `query-page`, `device`, `country`, `diagnostics`, `all`.

`diagnostics` returns sitemap status and homepage index inspection (no date range). `all` runs diagnostics plus all five analytics reports — recommended for weekly health checks.

`--limit` defaults to 100. `--start-date` / `--end-date` default to the last 28 days ending yesterday.

Output is JSON on stdout — pipe it, redirect it, or read it inline in a Claude chat session.

### Note on the env var name

`GOOGLE_SERVICE_ACCOUNT_FILE` is intentionally generic. The same service account key can be reused for other Google APIs (Analytics, Drive, etc.) by pointing new scripts at this same variable.
