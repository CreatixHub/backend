# Contributing to the Karkaii backend

Short version: **branch off `main`, keep it short-lived, open a PR, merge it within a day or two.**
No more `Stage` branch — that's what was causing most of our merge conflicts (weeks of parallel work
landing on both sides at once). Small, frequent merges almost never conflict.

## The workflow

```bash
# 1. Always start from the latest main
git checkout main
git pull origin main

# 2. Create your branch for ONE task/issue - name it so others know what it's for
git checkout -b feature/short-description      # new work
git checkout -b fix/short-description          # bug fix

# 3. Work, commit normally
git add <files>
git commit -m "..."

# 4. Before opening (or updating) your PR, pull main into your branch so YOU resolve
#    any conflict while the change is still fresh in your head - not someone else, weeks later.
git fetch origin
git merge origin/main
# fix anything that conflicts, then:
npm run typecheck && npm test
git add <resolved files>
git commit   # finishes the merge commit
git push

# 5. Open the PR on GitHub: base = main, compare = your branch.
#    (This is what "PR to main" means - you can't open a PR without a branch, there's no shortcut
#    that skips having one. The branch itself should just not live long.)
```

## Where to actually do this on GitHub

1. Push your branch (`git push origin your-branch-name`). GitHub prints a direct link to open
   the PR right there in the terminal output - click it, or:
2. Go to **github.com/CreatixHub/backend** → you'll see a yellow banner *"your-branch-name had
   recent pushes"* with a **"Compare & pull request"** button. Click it.
   (No banner? Go to the **Pull requests** tab → **New pull request** → pick your branch as
   "compare" and `main` as "base".)
3. Fill in a title/description, click **Create pull request**.
4. On the PR page, scroll down - you'll see a **Checks** section. That's CI running
   (`.github/workflows/ci.yml`, shows as "Backend tests"). Wait for the green check; a red ❌
   means something failed - click **Details** next to it to see the actual error log.
5. Ask a teammate to review (top-right **Reviewers** box, or just ping them). Once you have
   1 approval and the check is green, the **Merge pull request** button turns active - click it.
   If either is missing, the button stays disabled/greyed out - that's the branch protection
   working as intended, not a bug.
6. All of this - every PR, every check run, every review - is also visible any time at
   **github.com/CreatixHub/backend/pulls** (open PRs) and
   **github.com/CreatixHub/backend/actions** (every CI run, past and present).

## What's required before a PR can merge

`main` is protected. A PR cannot merge until:

- **CI passes** - `.github/workflows/ci.yml` runs `npm run typecheck` and `npm test` on every PR.
  A red check blocks the merge button.
- **At least one approval** from someone else.
- **Signed commits** and **linear history** (no merge commits that aren't a fast-forward - use
  `git merge origin/main` into your branch as shown above, not the other way around).

## Rules of thumb that avoid most conflicts

- **One task per branch.** Don't pile three unrelated changes into one branch - review gets harder
  and conflicts get wider.
- **Small PRs, merged fast.** A branch open for two weeks has had two weeks to drift from `main`.
  A branch open for a day almost never conflicts.
- **Pull `main` into your branch daily** if your PR is taking more than a day, not just once at the
  end. Conflicts caught in small pieces, right when you made the change, are trivial. Conflicts
  caught after two weeks, across 50 files, are how we end up with unresolved `<<<<<<<` markers
  accidentally committed (this has happened - see git history on `admissions.service.ts`).
- **Never commit a file with `<<<<<<<` / `=======` / `>>>>>>>` left in it.** If you see those
  markers after a merge, the merge isn't done - resolve them, then run `npm run typecheck && npm
  test` before committing. If you're not sure which side is right, ask, don't guess.
- **Talk to each other before touching the same file.** If you know someone else is deep in
  `admissions.service.ts` or `staff.service.ts`, say so in standup/Slack before you start editing
  it too - cheaper than resolving it after the fact.

## If your PR changes the database schema

Everyone - CI, every developer's local backend, and production - points at the **same shared
Supabase database**. CI does **not** auto-apply migrations (on purpose: that would let any pushed
branch alter the live schema before anyone's reviewed it). This means:

- `npm run db:generate` (drizzle-kit) creates a migration file, but it does nothing by itself -
  your CI run, and everyone else's `npm run dev`, still see the OLD schema until someone actually
  applies it.
- **If you don't apply your own migration, CI will fail in a confusing way**: not on the column
  you added, but on *unrelated* existing tests, because Drizzle's generated SQL always references
  every column in the TypeScript schema - a missing column breaks every query that touches that
  table, not just the new one. (This happened with PR #49's photo-upload column.)
- So: once you're confident in your migration (and ideally once the PR has at least a first look),
  run it yourself against the shared DB:
  ```bash
  npm run db:migrate
  ```
  Migrations are additive-only and safe to run more than once. Do this *before* pushing / re-running
  CI, not after - otherwise CI will fail for everyone until you do.

## Local checks before you push

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run - runs against the real Supabase DB, see README for the connection
npm run lint         # not a merge gate yet, but keep new code clean
```

## Deploying

Deploys are automatic: merging to `main` triggers `.github/workflows/deploy.yml`, which ships to the
droplet, runs migrations + the permission/demo seed, and rolls back automatically if the health
check fails. You don't deploy manually.
