# kaiwalya.com

Personal website, blog, and astrophotography gallery for Kaiwalya Kher. Built with [Astro](https://astro.build), deployed to [GitHub Pages](https://pages.github.com/).

## Quick start

```bash
cp .env.example .env
npm install
npm run dev
```

## Environment variables

Defined in `.env` (gitignored). See `.env.example` for required values. The build will fail if any are missing.

| Variable | Purpose |
|---|---|
| `SITE_URL` | Canonical site URL. Used for SEO, RSS, sitemaps. |
| `ASSETS_URL` | Base URL for external assets (images). Points to S3. |

These are also set in `.github/workflows/deploy.yml` for CI.

## Project structure

```
src/
  consts.ts              # Site-wide constants (name, social links, nav)
  content.config.ts      # Blog collection schema (Zod validation)
  content/blog/          # Markdown blog posts. draft: true hides from prod.
  data/resume.json       # Structured resume data
  data/astrophotography.json  # Gallery entries (title, description, S3 image path)
  components/            # BaseHead, Header, Footer, ThemeToggle, FormattedDate
  layouts/               # BaseLayout, BlogPost
  pages/                 # File-based routing
  styles/global.css      # CSS custom properties, reset, typography
public/                  # Static files (favicon, CNAME, robots.txt)
```

## Pages

| Path | Source | Description |
|---|---|---|
| `/` | `pages/index.astro` | Blog listing (drafts visible in dev only) |
| `/blog/[slug]/` | `pages/blog/[...slug].astro` | Individual blog posts |
| `/astrophotography/` | `pages/astrophotography.astro` | Photo gallery, images from S3 |
| `/about/` | `pages/about.astro` | Bio and social links |
| `/resume/` | `pages/resume.astro` | Resume from `data/resume.json` |
| `/rss.xml` | `pages/rss.xml.ts` | RSS feed |
| `/404` | `pages/404.astro` | Not found page |

## Deployment

Push to `main` triggers GitHub Actions (`.github/workflows/deploy.yml`) which builds with Astro and deploys to GitHub Pages.

- **Site**: GitHub Pages at `kaiwalya.com`
- **DNS**: AWS Route 53 — A records point to GitHub Pages IPs
- **HTTPS**: Auto-provisioned by GitHub Pages (Let's Encrypt)
- **Images**: S3 bucket `assets.kaiwalya.com` in `us-west-2`

## Adding content

**New blog post**: Create `src/content/blog/my-post.md` with frontmatter:

```yaml
---
title: "Post title"
summary: "One line summary"
date: 2026-01-01
draft: false
---
```

**New astrophotography image**: Upload to S3, add entry to `src/data/astrophotography.json`.

**Inline images in blog posts**: SVGs go in `public/blog/<slug>/`; raster images (PNG, JPEG) go to S3 under `s3://assets.kaiwalya.com/blog/<slug>/` and are referenced by absolute URL. See `AGENTS.md` for the upload command and full convention.

## Theme

Three-state toggle: auto (follows system preference), light, dark. Persists to `localStorage`. Vanilla CSS with custom properties.
