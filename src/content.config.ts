import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    summary: z.string().optional(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
    type: z.union([
      z.array(z.enum(['tech', 'astrophotography', 'sound'])),
      z.enum(['tech', 'astrophotography', 'sound']).transform((v) => [v]),
    ]).default(['tech']),
    instagramLink: z.string().url().optional(),
    image: z.string().optional(),
  }),
});

export const collections = { blog };
