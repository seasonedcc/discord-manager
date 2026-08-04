---
name: subagents
description: Spawn subagents and dynamic workflows well — size each task to the context window (~33% of 1M target) and pick the right model tier. Use whenever delegating work to subagents, launching a Workflow, or deciding how to split a task across agents.
---

# Subagents and Dynamic Workflows

Everything here documents the repository as it is on `main`. If `main` disagrees with this file, `main` wins: follow it and flag the drift.

The orchestrator delegates execution and keeps its own context lean. The two decisions that make delegation work are **how big to make each subagent's task** and **which model runs it**. Getting the size right matters more than anything else: it is the difference between coherent, trustworthy work and hallucinated, low-quality work.

This skill is **self-improving**. When a better sizing heuristic or a new calibration point emerges, update it.

## The context budget: aim for ~33% of the 1M window

- Fable, Opus, and Sonnet all have **1,000,000-token** context windows. So **~33% ≈ 330k tokens**.
- These models begin **degrading around 25–33%** window fill. Past ~33%, distrust the output — that is where hallucinations, silently-dropped requirements, and quality regressions appear. Do not trust results from a context much fuller than a third.
- **Design each task to LAND near 33% by the time it finishes** — not to blow past it. The target is the end state of a healthy task, not a ceiling to race toward.
- **Soft rule, not hard:** if an agent is genuinely near the end of its task when it crosses 33%, let it finish — interrupting or compacting mid-task is worse than mild degradation at the finish line. What must be avoided is an agent still doing substantive work at 50%+.

## Sizing: the tradeoff to balance

- **Too small** → over-parallelization. Many agents each holding a partial view produce fragmented, less coherent work with integration seams, duplicated context loading, and coordination overhead.
- **Too big** → the context overflows past ~33%, performance degrades, and either the quality drops (hallucinations, missed requirements) or the agent dies mid-task with its work wasted.
- **Right-sized** = one coherent deliverable an agent can hold entirely in a healthy (<~33%) context, including all the reading and gate-iteration the task requires.

## Estimate a task's token cost BEFORE spawning

Add up the big consumers:

- **Startup**: the agent's system prompt + the task prompt + any skills it loads. A rich task prompt plus 3–4 skills is easily **20–60k tokens before it does any work**.
- **Reading**: each file ≈ characters/4 tokens. Design docs, research digests, and broad source-tree reading add up fast — a large design doc plus a digest can be **30–60k** on its own.
- **Iteration** (usually the silent killer): every tool result accumulates and is replayed into context on later turns. Gate runs (`pnpm run lint`, `pnpm run tsc`, `pnpm run test:unit`, `pnpm run test:e2e`), `git diff`, and test logs each land in full. A build-until-green loop can add **100k+**.
- **Output**: cumulative generated tokens (code + reasoning) count too, though the input side normally dominates.

If the honest sum lands well past ~330k, the task is too big — split it or scope it down before spawning.

## Empirical calibration

Calibration entries accumulate per repo as real tasks are measured. Record each measured task here with its shape and its landing occupancy, and use the accumulated entries to size the next comparable task.

General shape that holds across repos: prefer **design (1 agent) → build coherent sub-slices (parallel, one module or layer each) → exhaustive review (fan-out)** over "one agent builds the entire feature." A full feature built from scratch in a single agent — migration plus business layer plus MCP tools plus tests plus gate-until-green — reliably overruns the budget while still mid-build.

Measured in this repo (issues #19/#20, 2026-07, opus/xhigh lanes):

- **Full-feature build lane, one agent** (business function + MCP tool + migration + 13 unit tests + E2E spec + docs, gates until green): landed at 22% (215k). Same shape for a 500-line framework module + 18 tests + CLI proofs + docs: 18%. At this repo's single-feature size one agent per feature is comfortably inside budget; see the #28/#29 entries for where that stops holding.
- **Remediation lane on an existing branch** (a query redesign with spec rewrite, or a three-defect fix with 9 new tests): landed 15–19%; a small docs+guard fix lane: 9%.
- **Review fan-out** (3 finder lenses over a ~700-line diff, one adversarial verifier per finding): peak agent 10–15%, 9–20 agents per audit.

Measured in this repo (issues #28/#29, 2026-07/08, opus/xhigh build and remediation lanes, sonnet/xhigh verifiers):

- **Full-feature build lane, one agent**, three measured on one effort: an ingest-capture slice (two sibling event tables, capture seams, three readers, tests, docs — +1383/−51 over 29 files) landed at **29%**; a new business domain with its own telemetry family and MCP tool (+1890/−48 over 22 files) at **27%**; a reactions slice spanning the gateway, the backfill and all three readers (+3129/−168 over 34 files) at **35%** — the first lane here to finish past the line. The shape says why: a build that touches the daemon *and* the backfill *and* every reader is two slices wearing one charter. Above roughly 2k added lines, or at the second subsystem, split it.
- **Remediation lane on an existing branch** scales with the number of fixes, not the size of the branch: 7 fixes landed at **18%**, 8 at **24%**, 11 — including a gateway-handler redesign — at **34%**. Past ten fixes, split the remediation the way you would split a build. A test-only flake fix: **8%**.
- **Review fan-out** (3 finder lenses over a lane diff, one adversarial verifier per finding), three of them: 18–23 agents each, finders **11–16%**, verifiers **3–8%**. Fan-out cost is flat in the diff size — the finders read the same diff whatever it contains.
- **Release audit** over the merged mainline (3 read-only auditors with distinct lenses, then a verifier per finding): 16 agents, auditors **20–23%**, verifiers **4–7%**. An auditor reading a whole release costs about what a finder reading one lane costs, plus the mainline.
- **Read-only design scout** answering a fixed question list across the tree: **7–11%**.

Measured in this repo (issue #59, 2026-08, opus/xhigh lanes, sonnet/xhigh verifiers):

- **Full-feature build lane, one agent** (a migration + gateway identity capture, widening a shared derivation in two business files, tool copy, 18 unit tests, an E2E seed story and spec, dev seed, a live MCP stdio proof, and draft-PR authorship — +941/−77 over 24 files): landed at **30%** (302k). Confirms the single-subsystem guidance; note the live proof and PR authorship are part of the load, not free.
- **Remediation lane on the same branch**, 4 fixes with mutation proofs plus a redone live proof and a PR-body rewrite: **21%** — higher per-fix than the 7-fix/18% entry above because the proof redo and body rewrite ride along; when a remediation must redo the live proof, size it as roughly two extra fixes.
- **Review fan-out** (3 finder lenses over the ~1k-line lane diff, one adversarial verifier per finding): 13 agents, finders **11–14%**, verifiers **5–6%** — inside the standing ranges.

Measured in this repo (issues #62/#63/#64, 2026-08, opus/xhigh build/fix lanes, sonnet/xhigh reviews):

- **Full-feature build lane, one agent**: a new business domain with its own telemetry family and MCP tool, plus a shared REST-client extraction, three E2E specs with new test-double routes, docs, and a live MCP-session proof (+1655/−33 over 19 files) landed at **31%** — consistent with the 27–29% band above for this shape, with the live proof and double work accounting for the extra.
- **Remediation lane on an existing branch**: 5 rulings — including an unmerged-migration constraint edit, a new failure kind end to end, a test-double lever, an E2E spec, and a PR-body rewrite — landed at **22%**, on the fixes-not-branch-size curve above.
- **TDD single-defect fix lane** (red test → guard → E2E spec → copy sweep → live proof, own PR): **13%**. A single-E2E-spec lane with a mutation proof: **8%** — the floor for anything that runs the full gate set even once.
- **Review fan-out, 3 finders + 8 verifiers** over a ~1.7k-line feature diff: finders **13–20%**, verifiers **5–8%**. A 2-finder review of a 140-line fix still costs **10–11%** per finder — finder cost has a floor set by reading the skills and the surrounding code, so below ~200 diff lines the fan-out's overhead approaches the build's.

## Measure a live or finished agent's context

Transcripts record per-turn token usage. Extract just the numbers — never read the JSONL wholesale (it overflows the reader's own window). The last turn's `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` is that agent's current context occupancy:

```bash
python3 - <<'PY'
import json, os
WINDOW = 1_000_000
FILES = {"<agent-id>": "<label>"}  # fill in ids → labels
for aid, label in FILES.items():
    f = f"/path/to/tasks/{aid}.output"
    if not os.path.exists(f): print(f"{label}: no transcript"); continue
    last = peak = out = turns = 0
    for line in open(f):
        try: o = json.loads(line)
        except: continue
        m = o.get("message"); u = m.get("usage") if isinstance(m, dict) else None
        u = u or (o.get("usage") if isinstance(o.get("usage"), dict) else None)
        if not u: continue
        ctx = u.get("input_tokens",0)+u.get("cache_creation_input_tokens",0)+u.get("cache_read_input_tokens",0)
        if ctx: last, peak, turns = ctx, max(peak,ctx), turns+1
        out += u.get("output_tokens",0)
    print(f"{label}: turns={turns} last={last:,} ({100*last/WINDOW:.0f}%) peak={peak:,} out={out:,}")
PY
```

Use it to watch a long-running agent's trajectory. If one is approaching ~33% while still far from done, decide deliberately: let it finish (if nearly there) or have it checkpoint its state to disk and hand off to a fresh agent.

## Shrink a task's footprint

- Point the agent at **specific docs and sections**, not "read everything."
- Have agents **return distilled conclusions**, not raw file contents — the summary is the deliverable, not the transcript.
- **Split along natural seams** (by module, by layer, by review dimension) — but not so finely that coherence breaks. Cohesive or dependent work stays in one agent.
- Use `pipeline()`/`parallel()` for genuinely independent units; keep dependent work sequential in one agent.
- **Resume interrupted work with a fresh agent + a summary and the on-disk state**, not by replaying a giant transcript.
- Keep the **orchestrator's own context lean**: delegate, store durable state in the scratchpad ledger, and never read what a subagent can read instead.

## Dynamic workflows

- **Inline task data into the script body — never pass it through `args`.** A Workflow launched with an `args` object can silently arrive as `undefined` inside the script, failing instantly with a missing-args error. Write charters, file lists, and other per-task data as template-literal constants in the script itself.
- **Launch independently-completing units as separate Workflow invocations, not one `parallel()` barrier.** A barrier notifies only when every agent in it finishes, so a downstream slice that depends on just the fastest lane still waits for the slowest. When lanes finish at different times and feed different dependents, give each its own invocation.
- **Consume a finished workflow's own returned result object; never re-pair its findings with verdicts by journal-line order.** Agents complete in a different order than they were submitted, so zipping a journal's lines against a separate verdict list misaligns them — a REFUTED finding reads as confirmed. Read the `{confirmed, refuted}` (or equivalent) object the workflow returns, where each finding already carries its own verdict.

## Model selection

Match the tier to the work. Model names here are family names, never pinned versions: spawns pass Claude Code's model aliases (`fable`, `opus`, `sonnet`), which resolve to each family's current model, so the skill tracks every release without edits — keep it that way.

- **Fable** — reserved for the highest-judgment work only: the main orchestrator session, architecture, product and API surface design, the hardest coding tasks and problems, and **final QA** — the last pre-merge audit of a lane, judging with real discernment whether the work truly meets the quality bar. Work is never merged on a lower tier's word alone.
- **Opus** — the default workhorse for everything below that bar: regular feature builds and implementation, fix passes, design-doc drafting within a settled architecture, code review with ≤5 subagents, and end-to-end manual testing through a real MCP client session.
- **Sonnet** — code review with ≥5 subagents (multi-dimension adversarial reviews) and similar wide fan-out work.

When a tier is unavailable (a weekly or rate limit), substitute the nearest capable tier and record the substitution in the ledger. (Standing example: when Fable's weekly limit is reached, Fable-tier work runs on Opus at `xhigh` until tokens return.)

## Reasoning effort

Pair every model with a fixed reasoning effort — always:

- **Opus → `xhigh`.**
- **Sonnet → `xhigh`.**
- **Fable → `high`.**

(When a tier is substituted for another, the effort follows the model actually running: Opus standing in for Fable still runs at `xhigh`.)

How to set it:

- **Dynamic workflows** (`agent()`): pass `effort` on *every* call alongside `model` — e.g. `agent(prompt, { model: 'sonnet', effort: 'xhigh', schema, ... })`. Omitting `effort` inherits the session effort, which is **not** guaranteed to match this rule, so always set it explicitly.
- **The `Agent` tool**: it has **no** per-call effort parameter — a directly-spawned subagent inherits the current session's reasoning effort. A single Agent-tool spawn cannot be raised to `xhigh` in isolation. To guarantee a required effort, either launch that agent from a workflow (where `effort` is settable) or run the whole session at the target effort. Call out this limitation whenever it bites.
