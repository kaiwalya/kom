# Blog Update Pipeline

Triggered by "run the blog update pipeline" or similar. Accepts optional date range.

## Registry

`src/data/projects/registry.json` — tracked repos, their state, and pipeline metadata.

## Invocation

- Default: checks from `lastRunAt` to today
- With dates: "run the pipeline from 2026-01 to 2026-03"
- First run: `lastRunAt` is null, fetches all history

## Phases

### 1. Load state

Read `src/data/projects/registry.json` and inventory `src/content/blog/*.md`.

### 2. Fetch changes

For each repo where tier is not `"skip"`:

- Get commits in date window: `gh api repos/{owner}/{name}/commits?since={start}&until={end}&per_page=50`
- If no commits in window → UNCHANGED, skip
- If commits found → fetch README, file tree, and diff from `lastCheckedCommit`

### 3. Propose

Present findings to user. For each repo:

- **NEW**: no blog post exists, propose creating one
- **CHANGED**: has new commits, summarize what changed, propose update if substantial
- **UNCHANGED**: no commits in window, skip silently

### 4. Execute (user approval required)

- Create/update blog posts in `src/content/blog/{id}.md`
- Always `draft: true`, `type: tech`, include `project` tag
- Never copy raw file contents — write prose descriptions only

### 5. Update state

Per-repo as each completes (not all at end):
- Set `lastCheckedCommit` to current HEAD SHA

After ALL repos are processed:
- Set `lastRunAt` to end of date window

## Rules

- Always create posts as drafts
- Process repos one at a time, update state after each (idempotent on interruption)
- Update `lastRunAt` only after ALL repos are processed
- If a repo 404s, mark it skip and warn the user
- If a post exists and repo is UNCHANGED, skip silently
- Cap at 50 commits per repo per run (`per_page=50`) to manage context
- Blog filename is `{id}.md` — if IDs ever collide across owners, use `{owner}-{name}`
