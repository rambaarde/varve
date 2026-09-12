---
name: nacre-publish
description: >
  Write this session's log into the shared company context store and publish it
  in one gated motion — compose, strip private blocks, scan for secrets, show
  the result, push. Use at the end of a working session, and when the user says
  "nacre publish", "nac publish", "/nacre-publish", "log this", "publish the
  session", or asks to record what was decided for the rest of the team.
---

# nacre-publish

One motion:

```
compose → strip private → secret scan → show → push
```

## 1. Resolve scope

Walk up from the working directory for `.nacre.yml` (`project`, `memory`).
`--project` overrides. **No binding → stop and say so.** Never guess the project,
never fall back to a default store.

Resolve the store path as `nacre-load` does. Pull before writing:

```bash
git -C <store> pull --ff-only
```

Conflict or dirty tree → **report and stop.** Never auto-resolve; never force.

## 2. Decide whether to write at all

**No-op is valid.** A session that opened a file and quit produces nothing. Say
so in one line and stop.

Write a log when the session produced any of: a decision, a rejected option, a
constraint discovered, something verified, something that broke, or a handoff
the next person needs. *"Files changed"* alone is not a reason — git already
records that.

## 3. Compose

**This is the single LLM call in the system.** It happens here, before the human
sees anything, and never on a read path. `--no-compose` writes a skeleton for the
user to fill in, with zero inference.

Path — **one file per session**, never per day:

```
{store}/{project}/{team}/{person}/{project}-{YYYY-MM-DD}_{HH-MM-SS}.md
```

Local date and time from this machine. A cross-timezone team needs no shared
clock, because no two people ever write the same file.

**`{person}` and the `who:` field are the same slug, and it is not a free
choice.** It is `git config user.name`, lowercased, with every run of
non-alphanumeric characters replaced by a hyphen — `Dana Reyes` → `dana-reyes`.
Run `nacre` to see the one this machine will use.

Inventing a shorter one splits a person in two: their profile stays in
`_team/_dana-reyes/` while their logs file under `dana`, so their own page never
shows their profile and the roster disagrees with the record. Nothing errors —
it just quietly becomes two people.

```markdown
---
project: atlas
who: alice
started: 2026-08-04T16:22:07
repos: [atlas-api, atlas-web]
---

# Session Outcome

* **High-Level Summary:** Renamed the rate-limit headers in atlas-api and
  verified them in production.
* **Important Decisions:** Header rename ships in the API first; the web app
  follows in a separate deploy.
* **Decided Against:** Raising the shared cache eviction limit — same instance
  as beacon, and raising it starves their workers under load.
* **Constraints / Blockers:** atlas-web still reads the old header name.
* **Next Step:** Remove the old header path in atlas-web, with bob.
* **Notes for Future AI:** The deploy order is a contract, not a convention.

<!-- private -->
Took three days because of a workaround around another dev's refactor.
<!-- /private -->
```

This is the shape that has been running for over a hundred days, kept
deliberately rather than improved on. **Bullets, not headings** — one
`# Session Outcome` and a labelled line each — because that is what a person
actually fills in without it turning into an essay.

One label is added to it: **Decided Against**. The original leaves rejected
options to a guideline, and a guideline is the first thing dropped on a tired
Friday. It is the content class this store exists for, so it gets a line of its
own.

`## Heading` form is read too, so a log written either way parses.

### The auto block

Below the human's notes, append what git already knows. Same shape the source
vault has used for a hundred days — it is not an invention, and it is not worth
redesigning:

```markdown
## Auto Session Log
_Auto-generated 2026-08-04 22:36:21._

* **Repos:** atlas-api, atlas-web
* **Branch:** main
* **Commits this session:**
- b057180 feat(api): rename the rate-limit headers
- 9006bfe test(api): cover the old header path
* **Uncommitted at publish:**
- M src/limits.ts
```

Collect it with one call per touched repo:

```bash
git -C <repo> log --since="<session start>" --format="%h %s"
git -C <repo> status --short
```

**Three rules, and the third is the one that matters:**

1. **Short SHAs and subjects only.** The prose above already says what happened;
   these are pointers, not a second copy of it. Never paste a diff.
2. **Timeout it, and treat failure as empty.** A repo on a slow mount or with a
   pathological history must not stall a publish. No commits recorded is a
   missing line; a hung publish is a person who stops publishing.
3. **This block is machine output and stays below the human's notes.** It is
   never the summary, never a substitute for saying what was decided, and a
   session with commits but nothing worth writing is still a no-op.

Cost, measured: ~10–30 ms per repo, 68 ms for three, against a 200 ms write
budget. It is on the write path, once per session — no read gets slower, because
no read touches git.

**`repos:` is derived from the paths this session actually touched** — the git
roots of the files you read and edited, deduplicated. **Never from the working
directory.** A single `repo_root` scalar makes cross-repo sessions invisible in
frontmatter, and cross-repo sessions are the reason this product exists. If the
schema cannot express it, it will not be measured.

### Before you compose: what did this session contradict?

**Run this every time, not when it occurs to you.** Supersession was documented
and never triggered — a step someone had to remember, which is the 6pm problem
this whole skill exists to delete, sitting at the one place correctness depends
on it. A constraint nobody retires is one the store keeps asserting after it
stopped being true, and a memory that confidently states a stale fact is worse
than one that says nothing.

```bash
npx -y nacre-cli brief          # or: npx -y nacre-cli brief <project>
```

The bare form reads the `.nacre.yml` binding resolved in step 1, so it is already
the right project. Name one only when publishing somewhere other than here.

Read the **Decided against** and **Open risks** it prints, and ask one question:
*did this session do, or prove, something one of those lines says not to?*

- **A rejected option was taken** — the tradeoff changed, or it was wrong.
- **A risk was closed** — it shipped, it was fixed, it turned out not to be real.
- **A constraint stopped holding** — the shared instance was split, the limit was
  raised, the other team moved off it.

Any of those means the new log carries `supersedes: <id of the log that said it>`.
If none do, say nothing — most sessions supersede nothing, and inventing a
correction to look thorough is worse than leaving the record alone.

**Corrections are new files, never edits.** To correct an earlier log, write a
new one carrying `supersedes: atlas-2026-07-28_09-14-03`. Both remain. The record
of having been wrong is often the most useful content in the store, and editing
in place destroys it.

**`supersedes:` retires the whole log, not the one line you meant.** A log is one
session's account, and half an account is worse than none — so the file you name
stops contributing every decided-against and every open risk it carried, not just
the one that went stale. **Restate, in the new log, anything from it that is still
true.** A brief that drops a constraint because it rode along in a superseded log
is the same silent loss as a window that ages one out; `nacre brief` reports the
count so the absence is at least visible, but only the log you are writing now can
carry the fact forward.

The `<!-- private -->` block matters more than it looks. Without somewhere to
write the unshareable part, people write nothing at all — the honest log and the
shareable log must be allowed to differ, or logging fails for reasons that look
like laziness but are actually discretion.

## 4. Record a cross-project lesson — only if one exists

Most sessions produce none. A **lesson** is failure→fix knowledge that will be
true in a **different** project — a mistake and its fix a teammate on another
repo would hit too. Project-specific detail stays in the log above; the lesson
is the portable residue. The bar is the boundary, not the size: *"the GUI build
needs an rpath to the Swift runtime"* is a lesson; *"renamed the rate-limit
header"* is a log entry.

Decide against what already exists — the same ADD / UPDATE / NOOP choice:

1. **Search first.** Grep `{store}/_lessons/` for the symptom. Recall already
   ranks lessons above logs, so a match usually surfaced earlier this session.
2. **UPDATE** if one covers it: append a new dated `## <date> · <project>` entry
   (**Problem** / **Solution**) to that same file. Correcting a wrong lesson is
   worth more than adding a right one.
3. **ADD** only when the trigger and the fix are both new:
   `{store}/_lessons/<kebab-slug>.md`, frontmatter `type: nacre-lesson`,
   `topic: <slug>`, then one `## <date> · <project>` entry.
4. **NOOP** otherwise, and say so in one line. Most sessions are NOOP.

Write the **Problem** as the symptom you would search for next time, not the
diagnosis you ended with. A lesson is a new file or an append — never a rewrite
of someone else's lesson body. It rides the same gate below.

## 5. The gate — every time, in order

**1. Strip** every `<!-- private -->` … `<!-- /private -->` block. Report the count.

**2. Scan** for secrets — **both scanners, and take the union.** Neither is a
superset of the other; this was measured, not assumed.

```bash
gitleaks detect --no-git --source <file>          # if installed
grep -nE 'AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9-]{20,}|xox[baprs]-|-----BEGIN|password=|Bearer ey|://[^:/]+:[^@]+@' <file>
```

Against five planted secrets, gitleaks caught the AWS key, the private key and
the Slack token but **missed a `postgres://user:pass@host` connection string and
an `sk-proj-` key**. The patterns caught those two and missed the Slack token.
Running only one of them publishes a live credential.

If gitleaks is not installed, say plainly that the scan is patterns-only and
therefore weaker — but do not skip the patterns when it *is* installed, which is
the mistake this rule used to invite.

Note that `AKIAIOSFODNN7EXAMPLE` is AWS's documented example key and gitleaks
allowlists it deliberately. Testing the gate with it proves nothing.

**3. Show** the exact final content. Not a summary of it. The reviewed surface
must stay small enough that review is genuine rather than ceremonial; if a log is
too long to read, that is a bug in composing it, not a reason to wave it through.

**4. Push** only on explicit confirmation:

```bash
git -C <store> add <path> && git -C <store> commit -m "log(atlas): rate-limit headers verified in prod" && \
  { git -C <store> push || { git -C <store> pull --rebase --autostash && git -C <store> push; }; }
```

**The retry is not optional.** The pull in step 1 happened before composing and
before a person read the draft — minutes ago. A teammate who published inside that
window makes this push non-fast-forward, and a bare `push` fails at the exact
moment two people were both doing the thing this store exists for.

Rebasing is safe here *because* the store is append-only: a session writes one new
file, so there is nothing for two logs to conflict over. If a rebase reports a
conflict anyway, **stop and show it** — that means something edited an existing
file, which is not what publishing does. Never force-push to recover; that is the
one operation that can silently drop a teammate's commits.

A scan finding blocks the push. Overriding is per-finding and explicit — never
"proceed anyway" for the whole file.

**There is no undo.** Once pushed, it is in history on every clone. If a secret
gets through, **rotate the secret** — do not rewrite history, because that needs
a force-push, which is the one operation that can silently drop other people's
commits.

## 6. Announce, if the team asked for it

**Only after the push succeeded**, and only if `NACRE_NOTIFY_URL` is set:

```bash
nacre notify
```

It posts one line to the team's channel. Say whether it went, in a single word —
and **never fail the publish because of it.** The log is already pushed and safe
by this point; a red result here sends someone hunting a problem in their memory
that does not exist.

If the variable is not set, skip this silently. It is opt-in, and a team that has
not configured it does not need to be told about it every session.

## 7. Report

```text
ok: published · atlas/devs/alice/atlas-2026-08-04_16-22-07.md
private: 1 block stripped · scan: 0 findings (gitleaks) · repos[2]: atlas-api, atlas-web
announced: #eng-atlas
help[]: nacre-load (next session)
```

Drop the `announced:` line when no webhook is configured.

Never claim the log was published if the push failed.

## Memory quality

Inherited from the skill this one descends from, and load-bearing rather than
stylistic:

- Record **rejected options and why** when the tradeoff matters. This is the
  content class a gardened wiki destroys and the one nothing else preserves.
- Record explicit **decisions not to act.**
- State what was **not** verified.
- Correct earlier wrong notes — as a new layer, never by editing.
- Sort open items by urgency, not chronology.
