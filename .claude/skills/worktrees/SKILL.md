---
name: worktrees
description: Run parallel tasks in isolated git worktrees, each with its own env file and its own SQLite store. Use when creating or removing a worktree, running parallel lanes or agents, running gates or a server for a specific worktree, or when the user mentions worktree, parallel lanes, or isolated environments.
---

# Worktrees

Everything here documents the repository as it is on `main`. If `main` disagrees with this file, `main` wins: follow it and flag the drift.

Each worktree is an isolated copy of Discord Manager: its own git checkout, its own gitignored `.env` when it needs one, and its own SQLite store. Parallel lanes never share state, so gates, seeded demo stores, and MCP sessions run concurrently across worktrees. The main checkout may be a live installation — a running daemon, a real bot token, a store with real data — so its files, its store, and its processes are never touched from a worktree.

## Lifecycle

Create from the main checkout:

```bash
git worktree add ../discord-manager-worktrees/<lane> -b <branch> origin/main
cd ../discord-manager-worktrees/<lane>
pnpm install
```

A fresh worktree has no `node_modules` and no `.env`. The four gates (`pnpm run lint`, `pnpm run tsc`, `pnpm run test:unit`, `pnpm run test:e2e`) need no `.env` — both test harnesses provision their own throwaway stores. Running the product from a worktree (`pnpm run mcp`, a seeded demo store for a real-client session) needs a worktree-local `.env` whose `DATABASE_PATH` points inside the worktree — never the main checkout's store, and never a store another lane owns. `.mcp.json` spawns `pnpm run mcp` from the project directory it lives in, so a real MCP client session opened from a worktree talks to that worktree's store, which is exactly what the Definition of Done's live proof wants.

Remove a worktree from the main checkout once its branch has merged:

```bash
git worktree remove ../discord-manager-worktrees/<lane>
```

Run removal from the main checkout, never from inside the worktree being removed — removal deletes the shell's working directory, so every later command in the same chain fails (git exits 128 on a vanished cwd). Never chain removal behind a prerequisite with `;` — it runs even when the prerequisite failed; confirm the merge actually landed, then remove as its own command.

## Guardrails and gotchas

- A worktree never runs `pnpm run ingest` with a live bot token or against a store it does not own. The schema's single-writer WAL divergence assumes one gateway writer per store, Discord allows one gateway session per token, and the live installation may be holding both.
- Never kill or restart a process to free a resource — the process may belong to the live installation or to a sibling lane. Kill only processes you started, by exact PID.
- NEVER run `git stash` inside a worktree. The stash is one stack shared by the main repo and every worktree, so a concurrent lane's push/pop can silently swap or drop another lane's uncommitted work. To shelve work, use `git diff > <file>.patch` (restore with `git apply`) or a WIP commit.
- The main checkout can lag `origin/main` between merges. Never answer repo-state questions from its working tree when currency matters — query the ref directly: `git fetch origin main`, then `git grep <pattern> origin/main -- <path>` and `git show origin/main:<file>`.
- Run post-merge routines (pull, `pnpm install`, migrate) only from the main checkout — inside a worktree, the branch tracks the lane ref and `db:migrate` hits the lane's own store. Always include `pnpm install`: a merged PR can add a dependency, and unit tests can stay green while tsc fails on the missing module.
- Push each successive slice of a lane under a fresh remote branch name instead of force-pushing over an already-merged tip.
- After moving a worktree's base (rebase, pull), diff `app/env.server.ts` and `app/framework/env.server.ts` against the lane's previous base — a newly-required env var must be mirrored into the worktree's gitignored `.env` or the server crashes at startup. The same staleness applies to `node_modules`: a base move can bring code that needs a dependency the worktree never installed, and the failure is misleading — unit tests owned by untouched sibling surfaces fail on runtime resolution while the same suite is green on CI. After any base move, run `pnpm install` before trusting any gate the worktree runs.
- A worktree's seeded demo store also goes stale after a base move, and the dev seed is single-shot — it refuses a populated store. To reseed, delete the worktree's store file, migrate, and seed again; never try to converge it.
- Several lanes running gates at once contend for the host. A suite that fails under parallel load but passes alone is host contention, not a defect in the branch — do not chase it; re-run alone or let the PR's CI, which has the machine to itself, be the arbiter.
- Never edit the main checkout's `.env` from a worktree task; each worktree owns its own copy.
