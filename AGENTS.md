# Agent Guide — kaiwalya.com

This is the personal website of Kaiwalya Kher. It is an Astro 6 static site deployed to GitHub Pages.

## Architecture

- **No fallbacks.** Environment variables are required and the build errors if they are missing.
- **Config vs constants.** Environment-dependent values go in `.env` (validated in `astro.config.mjs`). Everything else is hardcoded in `src/consts.ts`.
- **Images are not in the repo.** They are hosted on S3 (`assets.kaiwalya.com` bucket, `us-west-2`). Reference them via the `ASSETS_URL` env var.
- **Blog drafts** use `draft: true` in frontmatter. Visible in `npm run dev`, excluded from `npm run build`.

## Key files

| File | Purpose |
|---|---|
| `astro.config.mjs` | Astro config. Reads and validates env vars from `.env`. |
| `src/consts.ts` | Site name, author info, social links, nav items. Single source of truth for hardcoded values. |
| `src/content.config.ts` | Blog collection schema (Zod). Defines frontmatter shape. |
| `src/data/resume.json` | Structured resume data. Rendered by `pages/resume.astro`. |
| `src/data/projects/registry.json` | Blog pipeline registry. Tracked repos and pipeline state. |
| `src/data/projects/AGENTS.md` | Blog pipeline documentation. |
| `.github/workflows/deploy.yml` | CI/CD. Builds with Astro, deploys to GitHub Pages on push to `main`. Env vars are set here too. |

## Styling

- Vanilla CSS with custom properties defined in `src/styles/global.css`.
- Component-scoped styles use Astro's `<style>` blocks.
- Dark mode is handled via `[data-theme='dark']` selector and `@media (prefers-color-scheme: dark)` for auto mode.

## Infrastructure

- **Hosting**: GitHub Pages (static, auto-deploy on push to `main`)
- **DNS**: AWS Route 53 — `kaiwalya.com` A records point to GitHub Pages IPs (185.199.108-111.153)
- **SSL**: Auto-provisioned by GitHub Pages via Let's Encrypt
- **Assets**: S3 bucket `assets.kaiwalya.com` in `us-west-2`, public read

## Common tasks

**Local dev**: `cp .env.example .env && npm install && npm run dev`

**Add a blog post**: Create `src/content/blog/<slug>.md` with title, date, summary, draft fields.

**Add an astrophotography image**: Upload JPEG to `s3://assets.kaiwalya.com/astrophotography/`, then add a markdown file in `src/content/blog/` with `type: astrophotography` frontmatter.

**Add an inline image to a blog post body**:

- **SVG**: drop it in `public/blog/<slug>/<file>.svg` and reference it as `/blog/<slug>/<file>.svg`. Lives in the repo.
- **Raster (PNG, JPEG, etc.)**: upload to S3 *first*, then paste the absolute URL into the markdown. Raster images do not live in the repo. Upload command:

  ```
  aws s3 cp <local-file> s3://assets.kaiwalya.com/blog/<slug>/<file>.png \
    --content-type image/png \
    --cache-control "public, max-age=300"
  ```

  Then reference it as `<img src="https://s3.us-west-2.amazonaws.com/assets.kaiwalya.com/blog/<slug>/<file>.png" ... />`. The path-style URL (`s3.us-west-2.amazonaws.com/assets.kaiwalya.com/...`) is load-bearing — `assets.kaiwalya.com` is a bucket name, not a CNAME, so `https://assets.kaiwalya.com/...` would 404. Don't "clean it up." `--cache-control max-age=300` keeps re-uploads from getting stuck behind stale browser caches during editing.

  Source of truth for the original PNG/JPEG should be the project that produced it (e.g. the KiCad project for a schematic). S3 is CDN, not backup.

**Run the blog update pipeline**: See `src/data/projects/AGENTS.md` for full docs.

**Deploy**: Push to `main`. GitHub Actions handles the rest.

**Update env vars for CI**: Edit both `.env.example` and `.github/workflows/deploy.yml`.
