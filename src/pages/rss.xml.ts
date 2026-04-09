import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { SITE_NAME, SITE_DESCRIPTION } from '../consts';
import type { APIContext } from 'astro';

export async function GET(context: APIContext) {
  const posts = (await getCollection('blog', ({ data }) => {
    return data.draft !== true && data.type === 'tech';
  })).sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());

  return rss({
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    site: context.site!,
    items: posts.map((post) => ({
      title: post.data.title,
      pubDate: post.data.date,
      description: post.data.summary ?? '',
      link: `/blog/${post.id}/`,
    })),
  });
}
