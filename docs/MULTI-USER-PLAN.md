# atlas — Evolution Plan

> Drafted: 2026-05-10
> Status: active roadmap, replaces the earlier "lockdown / invite / SaaS-fork" draft.
> See [VISION.md](./VISION.md) for product positioning.

## Direction

Atlas evolves **in place** from a single-tenant personal corpus into a multi-repo, multi-user learning platform. **No fork. No separate `codeAtlas` repo.** One codebase, one deployment, one data model — but the data model is generalized from day one so we never have to migrate later.

**Headline shape:**

- **One atlas-per-repo.** A repo is the unit of a library. The `nauroLabs` atlas is the first one.
- **Private by default**, with explicit invite. Optional `visibility: unlisted | public` for sharable read-only links.
- **GitHub OAuth as the primary auth provider.** Drop Google for new flows; drop the idea of Microsoft Entra primary. Identity-as-developer = GitHub handle.
- **Invite by GitHub username**, not email.
- **BYOK (bring-your-own-key) is an abstraction we build now and a feature we ship when needed.**

## Phased roadmap

| Phase | Effort | Outcome |
|---|---|---|
| **P1 — Generalize schema + lockdown** | ~3–4h | atlas is private to `samoletovs`. Schema supports multiple repos. Repo switcher in header (just "nauroLabs" for now). Auth switched to GitHub. |
| **P2 — Invite mode** | 1–2 days | Invite people by GitHub handle. Each invitee has private read-state on the same lesson library. New `/admin` page. |
| **P3 — Add-your-own-repo** | 2–3 days | Self-service: a signed-in user can paste a GitHub URL, atlas ingests, generates lessons under their own repo namespace. Strict per-user generation cap on Sam's subscription. |
| **P4 — BYOK** | ~1 day | User can configure their own Azure OpenAI endpoint + key in settings. Lifts their generation cap. Encrypted at rest with a master key in App Settings (Key Vault if/when we move to SWA Standard). |
| **P5 — Public visibility (opt-in)** | ~1 day | A repo owner can flip a repo to `unlisted` (anyone with link) or `public` (listed at `/u/<handle>`). No social UI yet. Just sharable URLs and a profile page. |
| **P6 — Community surfaces (only if traffic justifies)** | TBD | Explore feed, lesson stars, cross-atlas topic graph, fork-a-lesson. **Don't build until ~50 active users.** |

P1 is the hard structural change. Everything after it is incremental on the same schema.

---

## P1 — Generalize schema + lockdown (~3–4h)

### Goal
- Switch primary auth to GitHub.
- Lock atlas down so only `samoletovs` can sign in.
- Refactor data so every lesson belongs to a `(ownerId, repoId)` pair.
- Migrate the existing 40 lessons to `ownerId='samoletovs', repoId='samoletovs__nauroLabs'`.
- Add a repo switcher in the header (with one entry: `nauroLabs`).

### Auth swap

`staticwebapp.config.json`:
```jsonc
{
  "auth": {
    "rolesSource": "/api/getRoles",
    "identityProviders": {
      "github": {
        "registration": {
          "clientIdSettingName": "GITHUB_CLIENT_ID",
          "clientSecretSettingName": "GITHUB_CLIENT_SECRET"
        }
      }
    }
  },
  "routes": [
    { "route": "/login",     "allowedRoles": ["anonymous", "authenticated"] },
    { "route": "/forbidden", "allowedRoles": ["anonymous", "authenticated"] },
    { "route": "/api/*",     "allowedRoles": ["owner", "member"] },
    { "route": "/*",         "allowedRoles": ["owner", "member"] }
  ],
  "responseOverrides": {
    "401": { "redirect": "/login", "statusCode": 302 },
    "403": { "redirect": "/forbidden", "statusCode": 302 }
  }
}
```

`api/src/functions/getRoles.ts` (P1 version, hardcoded):
```ts
export async function getRoles(req: HttpRequest) {
  const body = await req.json() as { userDetails: string };
  const login = body.userDetails?.toLowerCase();
  if (login === "samoletovs") return { jsonBody: { roles: ["owner"] } };
  return { jsonBody: { roles: [] } };
}
```

In P2 this function reads from Cosmos `repoShares` instead of the hardcoded check.

> **Note on the swap**: atlas is currently configured for Microsoft Entra ID (`aad`) as the primary provider. Swapping to GitHub is straightforward — both are SWA-Free-tier-built-in providers, no upgrade required. We just need to register a GitHub OAuth App for `atlas.naurolabs.com` and put the client id/secret in App Settings. `rolesSource` is also Free-tier-safe.

### Cosmos schema (final shape, used from P1 onward)

| Container | Partition key | Doc shape | Notes |
|---|---|---|---|
| `repos` | `/ownerId` | `{repoId, ownerId, githubUrl, name, visibility, createdAt}` | One per (owner, repo). `visibility` reserved for P5; default `private`. |
| `lessons` | `/repoId` | `{lessonId, repoId, ownerId, slug, lang, body, topic, suggested_next, ...}` | Same content fields as today, just re-keyed. |
| `lessonProgress` | `/userId` | `{userId, repoId, lessonId, status, readAt}` | Per-reader. Decouples read state from the lesson doc. |
| `repoShares` | `/repoId` | `{repoId, githubLogin, role: 'member', invitedBy, createdAt}` | Drives `getRoles` lookups in P2+. |
| `users` | `/userId` | `{userId, githubLogin, createdAt, byok?: {endpoint, deployment, keyCipher}}` | One per signed-in user. `byok` populated in P4. |

`userId` = GitHub `node_id` or numeric id (stable). `githubLogin` is the human-readable handle (can change if user renames; we always re-resolve at sign-in).

`repoId` is the canonical string `<ownerLogin>__<repoName>` (e.g. `samoletovs__nauroLabs`). The `__` separator is used because Cosmos document IDs cannot contain `/`. The pretty URL form is `/r/<ownerLogin>/<repoName>/...`, reconstructed by the route handler from two path segments — we never expose the underscored form in URLs.

### Migration script

A one-shot Python script `atlas/scripts/migrate_to_repo_schema.py` that:

1. Reads all docs from current `lessons` container (partitioned by `/userId`).
2. Writes them to the new `lessons` container (partitioned by `/repoId`) with `ownerId='samoletovs'`, `repoId='samoletovs__nauroLabs'`.
3. For any doc with a `read: true` field, writes a corresponding `lessonProgress` row.
4. Inserts a `repos` doc: `{id: 'samoletovs__nauroLabs', repoId: 'samoletovs__nauroLabs', ownerId: 'samoletovs', githubUrl: 'https://github.com/samoletovs/nauroLabs-github', name: 'nauroLabs', visibility: 'private'}`.
5. Inserts a `users` doc for `samoletovs`.
6. Old container kept for 30 days as backup, then dropped.

Cost: ~41 docs to migrate. RU usage trivial.

### UI changes (minimal)

- Header gains a tiny repo switcher dropdown showing the current repo. P1 has only `nauroLabs` in the list — no behavior change for Sam.
- New `/forbidden` page (rendered when rolesSource returns no role).

### Done when

- Sam signs in with GitHub, lands on the same UI as before.
- A different GitHub account hits `/forbidden`.
- All 40 lessons render correctly under the new schema.
- A second-repo entry can be added by hand (Cosmos data explorer) and the switcher shows it. **No "add repo" UI yet.**

---

## P2 — Invite mode (1–2 days)

### Goal
Sam invites people by GitHub handle. They sign in with GitHub, see the `nauroLabs` library, mark lessons read independently. They cannot edit, generate, or invite.

### Changes

- `getRoles` upgraded: reads `repoShares` from Cosmos. If the signed-in `githubLogin` matches a row, return `['member']`. Owner check (Sam) stays as-is.
- New `/admin` page (owner-only): list shares per repo, invite/revoke by GitHub handle.
- `getLessons` joins `lessons` (by `repoId`) with `lessonProgress` (filtered to current `userId`).
- `markLessonRead` writes `lessonProgress`, not the lesson doc.
- "Generate" / "Add lesson" buttons hidden if role !== `'owner'`.

### Validation

- Invite a friend by their GitHub handle. They sign in. They see only the repo(s) shared with them.
- They mark a lesson as read. Sam's progress is unchanged.

---

## P3 — Add-your-own-repo (2–3 days)

### Goal
Any signed-in user (no role required for this) can paste a GitHub URL, atlas ingests it, generates a starter set of lessons in a new repo namespace owned by them.

### Mechanics

- New `POST /api/repos` endpoint: input `{githubUrl}`. Creates `repos` row owned by current user. Triggers initial lesson generation (queued — generation is slow).
- For private repos: requires the user has granted GitHub OAuth `repo` scope (we ask for it on sign-in for users who hit "add repo"). Atlas reads README, top-level structure, recent commits.
- New "Add repo" button visible to all signed-in users.
- Per-user generation cap (default: **5 lessons/day** on Sam's subscription) — enforced in the generate endpoint by counting today's lessons in `lessons` for that `ownerId`.

### Limits as a feature, not a wall

- Generation cap displayed in user settings: "5/day on free. [Add your own AI key →]"
- Reading is uncapped (cheap).
- This is the feature that gets people to BYOK.

---

## P4 — BYOK (~1 day)

### Goal
A user adds their own Azure OpenAI endpoint + deployment + key. Their generations use their key, not Sam's. Their cap goes from 5/day to unlimited.

### Storage

- `users.byok = {endpoint, deployment, keyCipher, addedAt}`.
- `keyCipher` = AES-256-GCM ciphertext of the raw key, encrypted with a master key stored in SWA App Settings (P5+ → migrate to Key Vault).
- Plaintext key never logged, never returned in API responses. UI shows "configured" / "not configured" only.

### Client abstraction (build this in P1, use it in P4)

```ts
// api/src/lib/openaiClient.ts
export async function getOpenAIClientForUser(userId: string): Promise<AzureOpenAI> {
  const user = await users.read(userId);
  if (user.byok) {
    const key = await decrypt(user.byok.keyCipher);
    return new AzureOpenAI({ endpoint: user.byok.endpoint, deployment: user.byok.deployment, apiKey: key });
  }
  return getDefaultClient(); // Sam's SP-authenticated Foundry client
}
```

P1 builds this with only the default branch. P4 fills in the BYOK branch and adds the settings UI + encrypt/decrypt helpers.

### Validation flow

When a user saves a BYOK config: send a 1-token completion request to validate the credentials before persisting. Reject with a clear error if it fails.

---

## P5 — Public visibility (~1 day)

### Goal
A repo owner can flip `visibility` to `unlisted` (sharable URL works without auth) or `public` (listed on a profile page).

### Surfaces

- Repo settings → visibility dropdown.
- `/u/<githubLogin>` profile page lists that user's `public` repos. No comments, no follows, no feed. Just a list.
- Unlisted repos: `/r/<ownerLogin>/<repoName>` works for anyone, indexable by search engines unless we set `noindex` (we will, by default).
- Reader role for anonymous viewers of public/unlisted repos: read-only, no progress tracking unless they sign in.

### Done when

- Sam can flip `nauroLabs` to public.
- An anonymous viewer can read `atlas.naurolabs.com/r/samoletovs/nauroLabs/cosmos/partitions`.
- The `/u/samoletovs` page shows `nauroLabs` (because it's public) and hides any private repos.

---

## P6 — Community surfaces (deferred — only if ~50 active users)

Don't build until justified. Plumbing is cheap; UI is where time gets wasted on things nobody sees. When the time comes:

- **Explore feed** — recent public atlases, sorted by activity.
- **Lesson stars** — readers can star a specific lesson. Cheap signal, no comments to moderate.
- **Cross-atlas topic graph** — when reading `topic: managed-identity`, sidebar shows other public atlases with a lesson on the same topic.
- **Fork-a-lesson** — citation-based reuse, not copy. "This explanation in `@sam/era` is great" → saves a reference.

Network-effect quality is **medium**. Closer to dev.to + GitHub Stars than a true marketplace. Each individual atlas is valuable standalone, which is healthy at small scale.

---

## Cost model

Throughout P1–P5, hosting stays on **SWA Free + Cosmos serverless + Foundry on Sam's subscription**. Per-month cost target: stays under €5 even with a few dozen invitees.

Triggers to upgrade:
- **SWA Standard ($9/mo)** when we need Managed Identity to Cosmos, or Key Vault references in App Settings, or auth providers beyond what Free supports — likely P5 or later.
- **Cosmos provisioned-with-autoscale** when serverless RU bills exceed ~$5/mo — likely never on this scale.
- **Stripe** only if/when we charge for anything. Not in P1–P5.

BYOK (P4) is what makes this scale-safe: power users bring their own AI bill, casual users stay within Sam's caps.

---

## What we're explicitly NOT doing

- **No fork.** No `codeAtlas` repo. Atlas evolves in place.
- **No SaaS pricing in P1–P5.** No Stripe. No tiers. No paywalls. Free for everyone, capped for fairness.
- **No Microsoft Entra primary auth.** GitHub-only for new flows.
- **No social UI before traffic justifies it.** No follows, no comments, no Explore feed in P1–P5.
- **No GitLab / Bitbucket support** until someone asks.
- **No webhook-driven lesson generation** (the old SaaS plan had this). Generation stays manual / on-demand. Webhooks are a P6+ idea.
- **No source code persistence.** We read GitHub at generation time, send relevant context to the model, store only the lesson. Same as today.

---

## Concrete next step

Start P1. The tightest first slice is the schema + migration — auth swap follows once data is in the new shape. Suggested commit sequence:

1. Add Cosmos containers (`repos`, `lessonProgress`, `repoShares`, `users`) — Bicep change + deploy.
2. Write `atlas/scripts/migrate_to_repo_schema.py`. Run it. Verify in data explorer.
3. Update `getLessons` / `markLessonRead` / generate endpoints to read/write the new shape.
4. Add the `getOpenAIClientForUser` abstraction (default branch only).
5. Switch SWA auth to GitHub. Add `getRoles` with hardcoded `samoletovs` allowlist.
6. Add minimal repo switcher + `/forbidden` page.
7. Smoke test with a second GitHub account → confirms 403.
8. Ship.

Each of these is a clean commit. We can review after step 2 (data is migrated, app still works on old schema via compatibility shim) before going further.
