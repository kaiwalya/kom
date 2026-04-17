// @ts-check
import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';
import sitemap from '@astrojs/sitemap';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

const env = loadEnv(process.env.NODE_ENV ?? '', process.cwd(), '');

if (!env.SITE_URL) {
  throw new Error('SITE_URL is not defined. Copy .env.example to .env and fill it in.');
}
if (!env.ASSETS_URL) {
  throw new Error('ASSETS_URL is not defined. Copy .env.example to .env and fill it in.');
}

export default defineConfig({
  site: env.SITE_URL,
  output: 'static',
  integrations: [sitemap()],
  markdown: {
    remarkPlugins: [remarkMath],
    rehypePlugins: [rehypeKatex],
  },
});
