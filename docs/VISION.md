# atlas — Product Vision

> Last updated: 2026-05-09
> Status: MVP — Phase 0–3 shipped

## Origin Story

This project started in the middle of an unrelated build session. We had just shipped `labMemoryAgent` in [foundryLab](../../foundryLab/) — a working Microsoft Foundry agent with grounded answers, evals, prompt optimization, and a 6,400-word learning guide written at the end. The build itself took about a focused day. Reading the guide on a phone, Sam realized two things:

1. **He hadn't actually internalized half of it.** Copilot did the typing. He understood the *result*, not the *decisions* — why temperature 0.2, why Sweden Central, why path-aware ingestion, why basic vs standard setup, when Foundry beats Copilot Studio.
2. **A 6,400-word document on a phone is not a learning tool.** It's a reference. Reading it cover-to-cover competes with all the other things competing for spare moments.

The conversation that followed reshaped the question. It's not "make the guide better"; the guide is fine. It's: *with AI accelerating what we build by 10×, how do we keep our understanding from falling 10× behind?*

That gap — between *what the agent shipped* and *what we understand about what shipped* — is what `atlas` exists to close.

## The Gap We're Targeting

For working professionals using AI tooling heavily — D365 consultants moving into agentic, full-stack devs using Copilot for hours every day, IT leaders shipping POCs from the weekend — the same pattern keeps showing up:

- **You build faster than you can absorb.** A weekend POC now covers what used to take a small team a quarter. The shipping pace outpaces the conceptual digestion.
- **70% of adult learning is on-the-job.** It's the well-known 70/20/10 model. But the on-the-job part is where most learning tools *don't* reach — they're books, courses, certs, all built around a fixed curriculum.
- **Existing tools fall short for this gap.**
  - Anki / Readwise — manual cards, no context from your actual work
  - Mintlify / DeepWiki — document a codebase you may or may not have written, but don't teach you what you didn't grasp during the build
  - Devin learn mode / Cursor explanations — short-lived, in-IDE, not persistent across projects or commutes
  - Microsoft Learn / Coursera — generic, not tied to what you just did
  - Notion / Obsidian — note dumps, no learning structure or repetition

The gap is specifically: **a personal teacher who watches what you actually build, identifies the foundational concepts you brushed past, fills them in on a phone-readable schedule, and never repeats itself.**

## The NauroLabs Experiment Angle

`atlas` is part of the NauroLabs lab and tests a question the lab cares about deeply.

**Can AI replace the foundational-knowledge tier of a consultant's career?**

A working professional traditionally builds foundation through: courses, certs, books, conferences, peer review, and trial-and-error on customer projects. Each is expensive in time or money. Each is increasingly out-of-date the moment it ships. And — crucially — none of them watch what you're actually doing.

If we can show that an agent observing your daily work can produce more durable, more relevant learning than any of those, the implication ripples:

- **For NauroLabs:** another data point on "where's the AI-human boundary?" Specifically, on whether AI can teach as well as it can build.
- **For consulting markets:** D365, Power Platform, and increasingly Azure consulting communities each number in the tens of thousands of EU professionals. They all face the same gap.
- **For NauroLabs revenue hypothesis:** if `atlas` works for Sam, it's productizable for any consultant whose primary career-development path is "ship a project, hope you understood it."

This connects to NauroLabs' broader vision questions:

- *"Where's the AI-human boundary?"* — `atlas` tests how much understanding can be transferred without human curation. Not a generic LLM "explain this code" — a personal teacher who knows your trajectory.
- *"What's worth selling?"* — if the answer is "AI-curated learning at consultant scale", `atlas` is the experiment that finds out.
- *"Multiple paradigms"* — `atlas` is neither a chat agent (agentMode), nor a zero-config app (era), nor a coach-from-book (tPlan). It's a fourth paradigm: *content generated from your activity, delivered as a guided learning surface*.

## Mission

**Turn your AI-accelerated building into AI-curated understanding — by watching what you do, generating phone-sized lessons grounded in both your work and authoritative external sources, and never teaching the same thing twice.**

## How It Works — The Activity-to-Lesson Pipeline

Every day at 06:00 UTC, the system:

1. **Collect** — A GitHub Action walks all `samoletovs/*` repos, captures recent commits (last 7 days), reads project READMEs, AGENTS.md, docs/, and `.github/reports/` outputs. A redactor strips obvious secrets and PII patterns.
2. **Manage taxonomy** — A Foundry agent reviews the activity and updates the knowledge taxonomy: merges redundant topics, splits overloaded ones, proposes new topics for activity that doesn't fit existing buckets. The taxonomy starts empty and grows from your work.
3. **Propose backlog items** — For each activity event, the same agent proposes 0–N "backlog items". On low-activity days the agent ALSO proposes items autonomously, drawing from: tech-stack inventory of your projects (Azure, Foundry, Cosmos, etc.), gaps in the taxonomy where prereqs are covered but next-level isn't, and adjacent foundational areas (governance, security, FinOps, delivery process, licensing) you haven't yet touched. The agent has a goal: keep your queue full of relevant material, even when you didn't commit anything.
4. **Dedupe and prioritize** — A nightly Functions job scores every queued backlog item:
   ```
   priority = 0.30 × recency_factor
            + 0.25 × topic_gap        (1 if not yet covered at this depth)
            + 0.20 × prereq_readiness (1 if all prereqs published)
            + 0.15 × topic_importance (static weight from taxonomy)
            + 0.10 × activity_intensity (touched this topic in last 7 days)
   ```
5. **Draft top 1–5 lessons** — The agent picks the highest-priority queued items and writes the full lesson body, grounded in the activity event (or, for autonomous lessons, in your project tech inventory + Microsoft Learn) plus web search. Length is self-regulating: 300–900 words. **Each lesson ends with 2–3 "what to learn next" suggestions** — related topics either at the same depth (sideways) or at the next depth (deeper), with one-line rationales.
6. **Publish** — Lessons land in a Cosmos DB container as `status=published`, ready to read in the PWA.

User actions then drive the loop forward:

- **Mark read** — locks the lesson, updates topic memory (depth covered), surfaces the lesson's "what next" suggestions, queues those that aren't already published
- **Ask more** — opens an inline chat with the same Foundry agent, scoped to the current lesson + topic. The conversation is saved as part of the lesson and informs future lessons on the same topic.
- **Save** — flags for re-reading later
- **(Implicit) read time tracking** — feeds activity_intensity for that topic

## Key Differentiators

### 1. Activity-Sourced AND Autonomously Driven
No other learning tool watches your actual work AND fills the gaps when you don't have new work. Anki needs you to write cards. Readwise needs you to highlight books. Microsoft Learn shows you the same module everyone gets. `atlas` starts from the diff that landed in your repo this morning, but on a quiet week it draws from the tech stack you depend on, the topics adjacent to what you've already learned, and the foundational areas you haven't yet touched (governance, security, FinOps, licensing, delivery process). It's a librarian who watches you read AND notices what's missing from your shelf.

### 2. AI-Managed Taxonomy
Most knowledge apps (Notion, Obsidian) require you to file your own notes into your own folders. Or they impose a fixed taxonomy (Coursera, Microsoft Learn). `atlas` builds and re-builds its taxonomy as your work evolves — the topic list reflects what *you* are actually working on.

### 3. Backlog, Not Daily Quota
Duolingo nudges you daily; Anki reminds you of due cards. `atlas` generates a prioritized queue and offers it. Quiet weeks produce zero new content; busy weeks fill the queue. There's no streak, no XP, no daily reminder. Open it when you have time.

### 4. Phone-First, Offline-Ready
Every lesson fits a 4-minute phone read. Service worker caches everything for plane / metro / spotty-coffee-shop reading. Dark-mode-first. Single-column. Big tap targets. No notifications.

### 5. Never Repeats
A topic memory layer tracks coverage at three depths (intro / intermediate / deep). When something gets touched in your work that's already covered at intro, the agent generates an *intermediate* lesson, not a duplicate. Same for moving to deep.

### 6. Foundry-Native, Lab-Reused
Reuses the foundryLab account we already provisioned. No new Azure costs beyond Cosmos DB and Static Web Apps (both effectively free at our scale). Idle: under €1/month. Active use: ~€2–3/month.

## Design Direction

**Calm. Phone-first. Print-quality typography.**

Think Pocket meets Readwise meets Things 3. Big serif for body text, large line-height, dark-by-default. Single column. No sidebars. No social. No streaks. The only chrome is "back to next up" and a thin progress dot indicator showing where you are in the lesson.

- Dark mode default; light mode opt-in
- Serif for lesson body, sans-serif for UI
- Generous line-height (1.7) and font-size (18–20px on phone)
- One lesson on screen at a time during reading
- 100% accessible: AA contrast, keyboard navigable, screen-reader friendly

## Business Model Hypothesis

**Phase 1 (now → 6 months):** single-user experiment, <€5/mo, revenue €0. Validating the core loop works for one person.

**Phase 2 (6–12 months):** productize for D365/Azure consultant peers. Free tier with quota cap. Plus tier €9–15/mo unlocks unlimited lessons, multiple "instances", team atlases.

**Phase 3 (12+ months):** team/company plans. Companies provide GitHub orgs; atlases generate per-team learning libraries. €5–10 per seat per month.

**Killer test:** does Sam open it on at least 4 days out of 7 in week 6? If no, kill. If yes, productize.

## Day-1 Seed Content

The agent's first run draws from existing foundryLab activity. The 5 seed lessons:

1. *What an agent actually is: model + instructions + tools + memory*
2. *Why temperature 0.2 was the biggest quality lever in our build*
3. *Why we picked Sweden Central over Northeurope*
4. *Foundry vs Copilot Studio vs custom Azure: a decision flowchart*
5. *What "idle Foundry costs €0" actually means*

## Success Criteria

By end of week 2 of use:
- [ ] At least 15 published lessons covering ≥6 different topics
- [ ] Sam reads ≥10 of them
- [ ] Zero duplicate-content lessons
- [ ] Total Azure cost < €5/month
- [ ] At least 1 "ask more" follow-up generated and read

By end of week 6 (the killer test):
- [ ] Sam opens the PWA on ≥4 days out of 7
- [ ] At least 1 lesson read per opened day
- [ ] Sam can articulate (without looking) ≥5 concepts that came from atlas lessons

## Non-Goals

- Not a generic "explain this code" tool
- Not a docs generator (Mintlify / DeepWiki do that)
- Not a chat / Q&A surface (agentMode + labMemoryAgent cover that)
- Not a notes app
- Not a quiz app
- Not a video / course platform

`atlas` is one specific thing: **a personal teacher that observes your work, writes the lessons you didn't know you needed, and never mentions them again unless you ask for more.**
