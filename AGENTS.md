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
| `src/data/astrophotography.json` | Gallery entries. Each has title, description, date, instagram link, and S3 image path. |
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

**Add an astrophotography image**: Upload JPEG to `s3://assets.kaiwalya.com/astrophotography/`, then add an entry to `src/data/astrophotography.json`.

**Deploy**: Push to `main`. GitHub Actions handles the rest.

**Update env vars for CI**: Edit both `.env.example` and `.github/workflows/deploy.yml`.
