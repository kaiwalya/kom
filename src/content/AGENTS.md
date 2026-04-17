# Blog Writing Style

Guidance for writing and editing content under `src/content/blog/`.

## Voice

- Write like a person, not a polished product description. Short sentences are fine. Sentence fragments are fine when they land.
- First person is allowed and encouraged for project posts. The reader should feel they are hearing from Kaiwalya, not a house style.
- Technical precision matters more than literary flourish. If a sentence does not add information or intuition, cut it.

## Punctuation

- **No em-dashes (`—`).** They read as AI-generated. Use commas, colons, parentheses, or just end the sentence and start a new one.
- No en-dashes (`–`) as sentence punctuation either. Hyphens in compound words are fine.
- Avoid "not just X — Y" style constructions; rewrite.
- Quotation marks: straight double quotes in prose, backticks for code tokens.

## Structure

- Lead with the concrete problem or observation. The reader should know within the first paragraph what the post is about and why they might care.
- For debugging / gotcha posts: describe the symptom in plain words *before* introducing formalism. "My sweep ran twice as fast" lands before "phase is the integral of frequency."
- Prefer analogies grounded in everyday physical experience (cars, odometers, walking) over abstract restatement of the rule.

## Math

- Use `$...$` for inline math and `$$...$$` for display. KaTeX is wired up via `remark-math` + `rehype-katex` in `astro.config.mjs`.
- Introduce symbols on first appearance with their unit in parentheses: e.g. "speed for the car ($v$, in m/s)".
- Prefer $\theta$ over $\phi$ when the narrative frames the sine's argument as an angle around a circle.

## Visual patterns

- **Callouts** for framing a thesis or key idea. Keep blank lines inside the `<aside>` so markdown and KaTeX render:
  ```html
  <aside class="callout">

  <span class="callout-label">The key idea</span>

  Text here, with $math$ and **markdown**.

  </aside>
  ```
- **Parallel columns** for side-by-side analogies (e.g. linear vs radial):
  ```html
  <div class="parallel">
    <div class="col"><span class="col-label">Linear motion</span>...</div>
    <div class="col"><span class="col-label">Sine wave</span>...</div>
  </div>
  ```
  Columns stack on narrow viewports.
- **Plots**: generate SVGs via scripts under `scripts/plots/<post-id>.py`, write outputs to `public/blog/<post-id>/`, embed with a centered `<figure>`. Commit the script so the plots are reproducible.

## Drafts

- New posts start with `draft: true` in frontmatter. They render in `npm run dev` but are excluded from `npm run build`.
- Flip to `draft: false` only when the post is ready to ship.
