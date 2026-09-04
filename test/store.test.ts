/**
 * Tests for store access and the three setup operations.
 *
 * Weighted toward the two bugs that shipped and had to be found by hand:
 * frontmatter that would not parse behind a leading comment, and a roster merge
 * that erased the repo it was supposed to be adding to. Both were invisible in
 * review and obvious the moment the thing was run, so they get regression tests
 * before anything else does.
 *
 * node:test only — the zero-dependency rule applies to the toolchain too.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, access, realpath } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";

/** The repo root, from the compiled test in dist/test/. */
const PKG_ROOT_FOR_TEST = fileURLToPath(new URL("../..", import.meta.url));
import { join } from "node:path";

import { frontmatter, setFrontmatterKey, repoName, resolveBinding, readRoster, addToRoster, listProjects, logStats, discoverStores, AGENTS } from "../src/store.js";
import { initStore, addProject, linkRepo, status } from "../src/operations.js";
import { parseLog } from "../src/portal.js";

/** Run a body with HOME pointed at a fresh directory, then clean up. */
async function withHome<T>(body: (home: string) => Promise<T>): Promise<T> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "nacre-test-")));
  const realHome = process.env.HOME as string;
  // os.homedir() reads USERPROFILE on Windows and HOME on POSIX. Setting only
  // HOME left every Windows run resolving against the runner's REAL home —
  // the suite silently escaped its own sandbox and wrote there.
  const realProfile = process.env.USERPROFILE;
  const realStore = process.env.NACRE_STORE;
  const cwd = process.cwd();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.NACRE_STORE;
  // Also move into the temp home. Binding resolution walks up from the working
  // directory by design, so a .nacre.yml anywhere above the repo would leak in
  // — and the repo of anyone who actually uses nacre has one.
  process.chdir(home);
  try {
    return await body(home);
  } finally {
    process.chdir(cwd);
    process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = realProfile;
    if (realStore) process.env.NACRE_STORE = realStore;
    // Windows holds handles briefly after close, and refuses to remove the
    // working directory — cwd is already restored above.
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

test("frontmatter parses a plain block", () => {
  const fm = frontmatter("---\nproject: atlas\nrepos: [a, b]\n---\nbody");
  assert.equal(fm.project, "atlas");
  assert.deepEqual(fm.repos, ["a", "b"]);
});

test("frontmatter survives a leading comment — the roster-erasure bug", () => {
  // Every template used to open with an HTML comment, so `^---` never matched,
  // every roster read returned empty, and linking a second repo wiped the first.
  const fm = frontmatter("<!-- why this file exists -->\n---\nproject: atlas\nrepos: [a]\n---\n");
  assert.equal(fm.project, "atlas", "a leading comment must not blank the block");
  assert.deepEqual(fm.repos, ["a"]);
});

test("frontmatter strips trailing comments from values", () => {
  assert.equal(frontmatter("---\nproject: atlas   # immutable\n---").project, "atlas");
});

test("frontmatter returns empty rather than throwing on junk", () => {
  assert.deepEqual(frontmatter("no frontmatter here"), {});
});

test("setFrontmatterKey replaces in place and leaves the rest verbatim", () => {
  const before = "---\nproject: atlas\nrepos: [a]\n---\n# Body\n\nkeep me\n";
  const after = setFrontmatterKey(before, "repos", ["a", "b"]);
  assert.match(after, /^repos: \[a, b\]$/m);
  assert.match(after, /keep me/);
  assert.match(after, /^project: atlas$/m);
});

test("repoName derives the store directory from any git URL form", () => {
  assert.equal(repoName("git@github.com:acme/acme-context.git"), "acme-context");
  assert.equal(repoName("https://github.com/atlas/atlas-context.git"), "atlas-context");
  assert.equal(repoName("git@gitlab.com:foo/bar-memory"), "bar-memory");
  assert.equal(repoName(undefined), null);
});

test("resolveBinding walks up, and returns null rather than guessing", async () => {
  await withHome(async (home: string) => {
    const deep = join(home, "repo", "src", "nested");
    await mkdir(deep, { recursive: true });
    assert.equal(await resolveBinding(deep), null, "no binding must not be a guess");

    await writeFile(join(home, "repo", ".nacre.yml"), "project: atlas\nstore: git@h:a/s.git\n");
    const found = await resolveBinding(deep);
    assert.ok(found);
    assert.equal(found.project, "atlas");
    assert.equal(found.store, "git@h:a/s.git");
  });
});

test("init → add wires both records", async () => {
  await withHome(async (home: string) => {
    const repo = join(home, "atlas-web");
    await mkdir(repo, { recursive: true });

    const store = await initStore({ store: "git@github.com:acme/acme-context.git", who: "alice" });
    assert.ok(store.created);
    assert.equal(store.dir, join(home, "acme-context"), "memory path comes from the repo name");

    await addProject({ project: "atlas", title: "Atlas", who: "alice" });
    assert.deepEqual(await listProjects(store.dir), ["atlas"]);

    const linked = await linkRepo({ repo, project: "atlas" });
    assert.ok(linked.wrote);

    // Record one: the repo's own binding.
    const binding = await readFile(join(repo, ".nacre.yml"), "utf8");
    assert.match(binding, /project: atlas/);
    assert.match(binding, /memory: git@github\.com:acme\/acme-context\.git/);

    // Record two: the project roster. Updating only one would leave the
    // company-level answer silently wrong.
    assert.deepEqual((await readRoster(store.dir, "atlas"))?.repos, ["atlas-web"]);
  });
});

test("linking a second repo keeps the first — the erasure regression", async () => {
  await withHome(async (home: string) => {
    for (const name of ["atlas-web", "atlas-api"]) await mkdir(join(home, name), { recursive: true });
    const store = await initStore({ store: "git@github.com:acme/acme-context.git", who: "alice" });
    await addProject({ project: "atlas", who: "alice" });

    await linkRepo({ repo: join(home, "atlas-web"), project: "atlas" });
    await linkRepo({ repo: join(home, "atlas-api"), project: "atlas" });

    assert.deepEqual(
      (await readRoster(store.dir, "atlas"))?.repos,
      ["atlas-api", "atlas-web"],
      "a roster merge must be a union, never a replacement",
    );
  });
});

test("linking the second repo needs no URL; it resolves", async () => {
  await withHome(async (home: string) => {
    await mkdir(join(home, "atlas-api"), { recursive: true });
    await initStore({ store: "git@github.com:acme/acme-context.git", who: "alice" });
    await addProject({ project: "atlas", who: "alice" });
    const linked = await linkRepo({ repo: join(home, "atlas-api"), project: "atlas" });
    assert.equal(linked.store, "git@github.com:acme/acme-context.git");
  });
});

test("rebinding a repo to a different project is refused", async () => {
  await withHome(async (home: string) => {
    const repo = join(home, "atlas-web");
    await mkdir(repo, { recursive: true });
    await initStore({ store: "git@github.com:acme/acme-context.git", who: "alice" });
    await addProject({ project: "atlas", who: "alice" });
    await addProject({ project: "beacon", who: "alice" });
    await linkRepo({ repo, project: "atlas" });

    await assert.rejects(
      () => linkRepo({ repo, project: "beacon" }),
      /already binds this repo to "atlas"/,
      "silently re-pointing a repo at other memory is the failure nobody notices",
    );
    assert.match(await readFile(join(repo, ".nacre.yml"), "utf8"), /project: atlas/);
  });
});

test("two companies on one machine get separate memories", async () => {
  await withHome(async (home: string) => {
    const a = await initStore({ store: "git@github.com:acme/acme-context.git", who: "alice" });
    const b = await initStore({ store: "git@github.com:beta/beta-memory.git", who: "alice" });
    assert.equal(a.dir, join(home, "acme-context"));
    assert.equal(b.dir, join(home, "beta-memory"));
    assert.deepEqual((await discoverStores()).sort(), [a.dir, b.dir].sort());
  });
});

test("an ambiguous memory is reported, never picked", async () => {
  await withHome(async (home: string) => {
    await initStore({ store: "git@github.com:acme/acme-context.git", who: "alice" });
    await initStore({ store: "git@github.com:beta/beta-memory.git", who: "alice" });
    const unbound = join(home, "elsewhere");
    await mkdir(unbound, { recursive: true });
    process.chdir(unbound);
    await assert.rejects(() => status(), /several memories found/);
  });
});

test("status reports each stage without a store or binding", async () => {
  await withHome(async (home: string) => {
    const loose = join(home, "loose");
    await mkdir(loose, { recursive: true });
    process.chdir(loose);
    assert.equal((await status()).state, "no-store");

    await initStore({ store: "git@github.com:acme/acme-context.git", who: "alice" });
    assert.equal((await status()).state, "no-binding");

    await addProject({ project: "atlas", who: "alice" });
    await linkRepo({ repo: loose, project: "atlas" });
    const ready = await status();
    assert.equal(ready.state, "ready");
    assert.equal(ready.binding.project, "atlas");
    assert.equal(ready.logs.count, 0, "a fresh project has an explicit empty state");
  });
});

test("logStats counts sessions across teams and people", async () => {
  await withHome(async (home: string) => {
    const store = await initStore({ store: "git@github.com:acme/acme-context.git", who: "alice" });
    await addProject({ project: "atlas", who: "alice" });
    const dir = join(store.dir, "atlas");
    await mkdir(join(dir, "devs", "bob"), { recursive: true });
    await writeFile(join(dir, "devs", "alice", "atlas-2026-08-01_09-00-00.md"), "x");
    await writeFile(join(dir, "devs", "bob", "atlas-2026-08-04_16-00-00.md"), "x");

    const stats = await logStats(store.dir, "atlas");
    assert.equal(stats.count, 2);
    assert.equal(stats.who, "bob", "newest wins, and it is filename-sortable by design");
  });
});

test("addToRoster on a missing project says how to fix it", async () => {
  await withHome(async () => {
    const store = await initStore({ store: "git@github.com:acme/acme-context.git", who: "alice" });
    await assert.rejects(() => addToRoster(store.dir, "nope", ["r"]), /nacre add nope/);
  });
});

test("the npm test script builds first and resolves to files", async () => {
  // Shipped broken once: `node --test test/` resolved the directory as a module
  // and exited before running anything. With a build step there is a second way
  // to be green and wrong — running a stale dist — so the script must compile
  // before it runs.
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts.test, /build/, "test must rebuild, or it can pass against stale output");
  assert.match(pkg.scripts.test, /\.test\.js/, "and resolve to files, not a bare directory");
});

test("add inherits the memory it resolved, even with two on the machine", async () => {
  // The link step used to re-derive the memory from the repo being linked — but
  // a repo being linked for the first time has no binding, so the answer `add`
  // already had was discarded and resolution failed outright.
  await withHome(async (home: string) => {
    const bound = join(home, "atlas-web");
    const fresh = join(home, "acme-billing");
    for (const d of [bound, fresh]) await mkdir(d, { recursive: true });

    await initStore({ store: "git@github.com:acme/acme-context.git", who: "alice" });
    await initStore({ store: "git@github.com:beta/beta-memory.git", who: "alice" });
    await addProject({ project: "atlas", repos: [bound], who: "alice",
      storePath: join(home, "acme-context") });

    process.chdir(bound);
    const r = await addProject({ project: "billing", repos: [fresh], who: "alice" });
    assert.equal(r.dir, join(home, "acme-context"), "resolved from the repo you are standing in");
    assert.deepEqual(r.roster.repos, ["acme-billing"]);
  });
});

test("--memory accepts a name, not only a path", async () => {
  await withHome(async (home: string) => {
    await initStore({ store: "git@github.com:acme/acme-context.git", who: "alice" });
    await initStore({ store: "git@github.com:beta/beta-memory.git", who: "alice" });
    const loose = join(home, "loose");
    await mkdir(loose, { recursive: true });
    process.chdir(loose);
    // A bare name resolved against cwd used to produce a nonexistent directory.
    const r = await addProject({ project: "ops", storePath: "beta-memory", who: "alice" });
    assert.equal(r.dir, join(home, "beta-memory"));
  });
});

test("piped output carries no escape codes", async () => {
  // The agent contract: stdout read by a program must stay plain and stable.
  // Tests run without a TTY, so this exercises the real piped path.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const bin = fileURLToPath(new URL("../bin/nacre.js", import.meta.url));
  const { stdout } = await run(process.execPath, [bin, "--help"]);
  const ESC = String.fromCharCode(27);
  assert.ok(!stdout.includes(ESC), "styling must never reach a pipe");
});

test("a public memory is refused, and the override is explicit", async () => {
  // Offline-safe: a non-https remote cannot be probed, so the check returns
  // null and init proceeds. That is the important default — "unknown" must
  // never read as "public", or the guard fires on people it should not.
  await withHome(async (home: string) => {
    const local = await initStore({ store: "file:///tmp/nowhere.git", who: "alice" });
    assert.ok(local.created, "an unprobeable remote must not block init");
  });

  // And the override reaches the operation rather than being swallowed.
  await withHome(async () => {
    const forced = await initStore({
      store: "https://github.com/rambaarde/acme-context.git",
      who: "alice",
      allowPublic: true,
    });
    assert.ok(forced.created, "--i-know-its-public must skip the probe entirely");
  });
});

test("a bound repo fetches its memory instead of asking for init", async () => {
  // The onboarding promise: clone one code repo, run nothing, start warm.
  // This was claimed verified once and never actually exercised — the CLI told
  // a teammate to run `init`, which creates a *second* memory rather than
  // joining theirs. A local bare repo stands in for the remote so the test
  // stays offline.
  await withHome(async (home: string) => {
    const origin = join(home, "origin.git");
    const seed = join(home, "seed");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const git = promisify(execFile);

    await mkdir(seed, { recursive: true });
    await writeFile(join(seed, "_company.md"), "---\ntype: nacre-company\n---\n\nfacts\n");
    await git("git", ["init", "-q", seed]);
    await git("git", ["-C", seed, "config", "user.email", "a@b.c"]);
    await git("git", ["-C", seed, "config", "user.name", "alice"]);
    await git("git", ["-C", seed, "add", "-A"]);
    await git("git", ["-C", seed, "commit", "-qm", "seed"]);
    await git("git", ["clone", "-q", "--bare", seed, origin]);

    // A repo bound to that memory, with nothing cloned locally yet.
    const repo = join(home, "acme-fe");
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, ".nacre.yml"), `project: acme\nmemory: ${origin}\n`);

    const { ensureMemory, resolveStoreDir, resolveBinding } = await import("../src/store.js");
    const binding = await resolveBinding(repo);
    const dir = await resolveStoreDir(undefined, binding?.store);
    const first = await ensureMemory(dir, binding?.store);

    assert.deepEqual(first, { ok: true, cloned: true }, "it must fetch, not instruct");
    await access(join(dir, "_company.md"));

    const again = await ensureMemory(dir, binding?.store);
    assert.deepEqual(again, { ok: true, cloned: false }, "and not re-clone once present");
  });
});

test("init joins an existing memory instead of starting a second one", async () => {
  // Found by running the published package: `init` only checked whether a
  // memory existed LOCALLY, so the second person to point it at the company URL
  // got an empty scaffold and a history sharing no commit with their team's.
  // Both would then claim the same remote.
  await withHome(async (home: string) => {
    const origin = join(home, "origin.git");
    const seed = join(home, "seed");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const git = promisify(execFile);

    await mkdir(join(seed, "atlas"), { recursive: true });
    await writeFile(join(seed, "_company.md"), "---\ntype: nacre-company\n---\n\nfacts\n");
    await writeFile(join(seed, "atlas", "_project.md"), "---\nproject: atlas\nrepos: []\n---\n");
    await git("git", ["init", "-q", seed]);
    await git("git", ["-C", seed, "config", "user.email", "a@b.c"]);
    await git("git", ["-C", seed, "config", "user.name", "alice"]);
    await git("git", ["-C", seed, "add", "-A"]);
    await git("git", ["-C", seed, "commit", "-qm", "the team's memory"]);
    await git("git", ["clone", "-q", "--bare", seed, origin]);

    const joined = await initStore({ store: origin, storePath: join(home, "mem"), who: "bob" });

    assert.equal(joined.created, false, "must not create a second memory");
    assert.equal("cloned" in joined && joined.cloned, true, "must fetch the one that exists");
    assert.deepEqual(joined.projects, ["atlas"], "and arrive holding the team's projects");

    // The decisive check: one shared history, not two unrelated roots.
    const { stdout } = await git("git", ["-C", joined.dir, "log", "--format=%s"]);
    assert.match(stdout, /the team's memory/, "history must be the team's, not a fresh root");
  });
});

test("an unreachable memory explains itself rather than hanging", async () => {
  await withHome(async (home: string) => {
    const { ensureMemory } = await import("../src/store.js");
    const result = await ensureMemory(join(home, "nope"), join(home, "does-not-exist.git"));
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /could not clone/);
  });
});

test("a scaffolded profile is filled from git, not left as a form", async () => {
  // "[INSERT NAME]" reads as a form nobody filled in, and a form nobody filled
  // in stays that way. Everything git knows gets written; everything it cannot
  // know stays a prompt, because that is the part worth a human.
  await withHome(async (home: string) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const git = promisify(execFile);
    await git("git", ["config", "--global", "user.name", "Ada Lovelace"]);
    await git("git", ["config", "--global", "user.email", "ada@example.com"]);

    const store = await initStore({ store: "file:///tmp/none.git", who: "ada" });
    const text = await readFile(join(store.dir, "_team", "_ada", "_profile.md"), "utf8");

    assert.match(text, /^name: Ada Lovelace$/m);
    assert.match(text, /^email: ada@example\.com$/m);
    assert.match(text, /^who: ada$/m);
    assert.match(text, /^# Ada Lovelace$/m);
    assert.doesNotMatch(text, /\[Insert Name\]/, "no placeholder git could have filled");

    // What git cannot know stays a prompt — that is the point of the file.
    assert.match(text, /\*\*Timezone:\*\* \[Insert\]/);
    assert.match(text, /\*\*Ask me before:\*\*/);
    assert.match(text, /^github:\s*$/m, "left blank rather than guessed from an API");
  });
});

test("the author slug is one value, so a person cannot become two", async () => {
  // init scaffolds _team/_<slug>/ from git config user.name; a log's `who:` is
  // written by the skill. If those two ever disagree the person's profile sits
  // in one folder while their logs file under another — their own page shows no
  // profile, and nothing errors. `nacre` therefore reports the slug it uses, so
  // the skill has one value to copy rather than a name to guess at.
  await withHome(async (home: string) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const git = promisify(execFile);
    await git("git", ["config", "--global", "user.name", "Dana Reyes"]);
    await git("git", ["config", "--global", "user.email", "dana@acme.test"]);

    const store = await initStore({ store: "file:///tmp/none.git", storePath: join(home, "mem") });
    const repo = join(home, "atlas-web");
    await mkdir(repo, { recursive: true });
    await addProject({ project: "atlas", repos: [repo], storePath: store.dir });

    // status() reads the binding from cwd, as it does for a real user.
    process.chdir(repo);
    const st = await status({ storePath: store.dir });
    assert.equal(st.state, "ready");
    const slug = st.state === "ready" ? st.you : "";
    assert.equal(slug, "dana-reyes", "slug is git user.name, slugified");
    await access(join(store.dir, "_team", `_${slug}`, "_profile.md"));
  });
});

test("--version and --help work from the PACKAGED layout, not just the repo", async () => {
  // `nacre --version` shipped broken: bin/nacre.ts computed its own PKG_ROOT by
  // going one directory up, which is the repo root from bin/ and dist/ from
  // dist/bin/. Every install got ENOENT on dist/package.json. store.ts had
  // already been fixed to walk up for package.json; the duplicate had not.
  //
  // The build output is what users run, so this asserts against dist/.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const bin = join(import.meta.dirname, "..", "bin", "nacre.js");

  const { stdout: version } = await run("node", [bin, "--version"]);
  assert.match(version.trim(), /^\d+\.\d+\.\d+$/, "--version prints a semver, not an error");

  const { stdout: help } = await run("node", [bin, "--help"]);
  assert.match(help, /nacre init <git-url>/, "--help prints usage");
});

test("a name the slugifier cannot spell must not erase the person", async () => {
  // The old rule was [^a-z0-9-] → "-", which is fine for "Dana Reyes" and
  // ruinous otherwise: 李明, Дмитрий and محمد each became "-", so colleagues
  // with non-Latin names collided into ONE identity — worse than splitting one
  // person in two, and directly against "no teammate left out".
  const { slugify } = await import("../src/store.js");

  assert.equal(slugify("Dana Reyes"), "dana-reyes");
  assert.equal(slugify("José Ñuñez"), "jose-nunez", "Latin diacritics fold");
  assert.equal(slugify("María López"), slugify("Maria Lopez"),
    "so María and Maria are one person, not two");

  // Every script keeps its letters — a directory name may be Unicode, and the
  // person's own name is the honest slug.
  for (const name of ["李明", "Дмитрий Иванов", "محمد علي", "Łukasz Nowak"]) {
    assert.notEqual(slugify(name), "you", `${name} must not fall back`);
    assert.notEqual(slugify(name), "-", `${name} must not collapse to a hyphen`);
  }

  const distinct = new Set(["李明", "王小明", "Дмитрий Иванов", "محمد علي"].map(slugify));
  assert.equal(distinct.size, 4, "four people must be four slugs");

  // Cyrillic и-with-breve is a letter, not an accent: folding it would merge
  // two different names.
  assert.notEqual(slugify("Дмитрий"), slugify("Дмитрии"));

  // And a name with nothing usable still yields something rather than "".
  assert.equal(slugify("   "), "you");
  assert.equal(slugify("!!!"), "you");
});

test("no apostrophe hides inside a single-quoted shell block in a workflow", async () => {
  // The CI guard broke because a code comment read "npm's envelope". Inside
  // `node -e '...'` that apostrophe closes the shell string, and the failure
  // surfaces as an exit code from a workflow rather than as anything resembling
  // a quoting mistake. Prose is where this hides, which is why a human review
  // will not catch it twice.
  const { readdir } = await import("node:fs/promises");
  const dir = join(import.meta.dirname, "..", "..", ".github", "workflows");
  const files = await readdir(dir);

  for (const name of files.filter((f) => f.endsWith(".yml"))) {
    const text = await readFile(join(dir, name), "utf8");
    for (const block of text.matchAll(/node -e '\n([\s\S]*?)\n\s*'/g)) {
      const offenders = (block[1] as string)
        .split("\n")
        .filter((line) => line.includes("'"));
      assert.deepEqual(offenders, [],
        `${name}: an apostrophe inside node -e '...' ends the shell string early`);
    }
  }
});

test("the README test badge matches reality", async () => {
  // The badge has been wrong three times in one day — 34, then 44, then 54 —
  // because it is a number maintained by hand in a file nobody edits when they
  // add a test. A README that overstates the suite is a small lie in the most
  // read file in the repo, so let it fail here instead of aging quietly.
  const { readdir } = await import("node:fs/promises");
  const testDir = join(import.meta.dirname, "..", "..", "test");
  const files = (await readdir(testDir)).filter((f) => f.endsWith(".test.ts"));

  let declared = 0;
  for (const f of files) {
    const src = await readFile(join(testDir, f), "utf8");
    declared += (src.match(/^test\(/gm) ?? []).length;
  }

  const readme = await readFile(join(import.meta.dirname, "..", "..", "README.md"), "utf8");
  const badge = readme.match(/tests-(\d+)%20passing/);
  assert.ok(badge, "the README must carry a test badge");
  assert.equal(
    Number(badge[1]),
    declared,
    `README says ${badge[1]} tests, ${declared} are declared — update the badge`,
  );
});

test("standing inside a memory is enough to find it", async () => {
  // `nacre serve` run from the root of a memory reported "no memory here, and
  // nothing says where it lives" — while standing in one — because discovery
  // only ever scanned directly under the home directory, and a memory kept
  // anywhere else was invisible. Being inside it is the plainest possible
  // statement of which memory you mean.
  await withHome(async (home: string) => {
    const buried = join(home, "Documents", "work", "acme-context");
    await mkdir(join(buried, "atlas"), { recursive: true });
    await writeFile(join(buried, "_company.md"), "---\ntype: nacre-company\n---\n\nfacts\n");

    const { resolveStoreDir } = await import("../src/store.js");
    const { realpath } = await import("node:fs/promises");
    // macOS puts the temp dir behind a /var -> /private/var symlink, and
    // process.cwd() reports the resolved path.
    const real = await realpath(buried);

    process.chdir(buried);
    assert.equal(await resolveStoreDir(), real, "the memory itself resolves");

    // And from a subdirectory of it, which is where a person actually stands.
    process.chdir(join(buried, "atlas"));
    assert.equal(await resolveStoreDir(), real, "a subdirectory resolves to its root");

    // An explicit flag still wins — being somewhere is weaker than saying so.
    const other = join(home, "other-context");
    await mkdir(other, { recursive: true });
    await writeFile(join(other, "_company.md"), "---\ntype: nacre-company\n---\n");
    assert.equal(await resolveStoreDir(other), other, "--memory overrides where you stand");

    // Outside any memory it must not invent one.
    process.chdir(home);
    const outside = await resolveStoreDir();
    assert.notEqual(outside, buried, "standing outside must not reach into a memory");
  });
});

test("frontmatter reads a folded block scalar, not the '>' marker", () => {
  // Every skill this project ships uses `description: >`. Reading only the
  // first line made the description the literal ">", which is the text Cursor
  // shows a user when deciding whether to run the command.
  const fm = frontmatter(`---\nname: nacre-load\ndescription: >\n  Read the store.\n  Report what the team decided.\nother: plain\n---\n`);
  assert.equal(fm.description, "Read the store. Report what the team decided.");
  assert.equal(fm.name, "nacre-load");
  assert.equal(fm.other, "plain");
});

test("frontmatter keeps line breaks in a literal block scalar", () => {
  const fm = frontmatter(`---\nbody: |\n  one\n  two\n---\n`);
  assert.equal(fm.body, "one\ntwo");
});

test("every known agent installs, in its own format", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "nacre-agents-")));
  for (const d of Object.values(AGENTS)) await mkdir(d.home.replace(homedir(), home), { recursive: true });
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    // AGENTS resolved its paths at import time against the real home, so drive
    // installSkills directly rather than trusting a re-read of the env.
    assert.ok(Object.keys(AGENTS).length >= 5, "the agent table lost rows");
    for (const [name, target] of Object.entries(AGENTS)) {
      assert.ok(target.label, `${name} needs a label`);
      assert.ok(["skill", "rule"].includes(target.layout), `${name} has an unknown layout`);
      assert.ok(target.dir.startsWith(target.home), `${name}: dir must sit under home`);
    }
  } finally {
    process.env.HOME = prev;
  }
});

test("linking a repo leaves a note any agent can find", async () => {
  // A skill only fires for an agent that already knows it exists, and MCP only
  // for a client someone configured. AGENTS.md is the file nearly every agent
  // reads on its own, so it is where the memory announces itself. Without this,
  // a new teammate's agent sits beside a full memory and never asks for it.
  await withHome(async (home: string) => {
    const repo = join(home, "atlas-web");
    await mkdir(repo, { recursive: true });
    await initStore({ store: "git@github.com:acme/acme-context.git", who: "alice" });
    await addProject({ project: "atlas", who: "alice" });
    const linked = await linkRepo({ repo, project: "atlas" });

    assert.ok(linked.noted);
    const note = await readFile(join(repo, "AGENTS.md"), "utf8");
    assert.match(note, /nacre brief/);
    assert.match(note, /atlas/);
  });
});

test("the note is replaced, never appended twice", async () => {
  // `nacre add` is meant to be re-run — adding a repo later is the same command
  // — and AGENTS.md is loaded into every session in the repo.
  await withHome(async (home: string) => {
    const repo = join(home, "atlas-web");
    await mkdir(repo, { recursive: true });
    await initStore({ store: "git@github.com:acme/acme-context.git", who: "alice" });
    await addProject({ project: "atlas", who: "alice" });

    await linkRepo({ repo, project: "atlas" });
    const second = await linkRepo({ repo, project: "atlas" });
    await linkRepo({ repo, project: "atlas" });

    const note = await readFile(join(repo, "AGENTS.md"), "utf8");
    assert.equal(note.match(/nacre:start/g)?.length, 1, note);
    assert.equal(second.noted, false, "an unchanged note should not report a write");
  });
});

test("an existing AGENTS.md keeps everything it already said", async () => {
  await withHome(async (home: string) => {
    const repo = join(home, "atlas-web");
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, "AGENTS.md"), "# my-service\n\nRun the tests with `make test`.\n");
    await initStore({ store: "git@github.com:acme/acme-context.git", who: "alice" });
    await addProject({ project: "atlas", who: "alice" });
    await linkRepo({ repo, project: "atlas" });

    const note = await readFile(join(repo, "AGENTS.md"), "utf8");
    assert.match(note, /make test/, "clobbered the repo's own instructions");
    assert.match(note, /nacre brief/);
  });
});

test("a Windows memory path yields a name, not a fall-through to discovery", () => {
  // Found by CI on windows-latest. repoName split on [/:] only, so a path like
  // C:\work\acme-context.git produced a "name" full of separators, isSafeName
  // rejected it, and resolution fell back to scanning the home directory —
  // which can return a DIFFERENT company's memory.
  assert.equal(repoName("C:\\work\\acme-context.git"), "acme-context");
  assert.equal(repoName("\\\\server\\share\\acme-context"), "acme-context");
  // and the forms that already worked must keep working
  assert.equal(repoName("git@github.com:acme/acme-context.git"), "acme-context");
  assert.equal(repoName("https://github.com/acme/acme-context.git"), "acme-context");
  assert.equal(repoName("/home/alice/acme-context"), "acme-context");
});

test("two people publishing in the same window both survive", async () => {
  // The pull in the publish skill happens before composing and before a human
  // reads the draft — minutes before the push. A teammate publishing inside
  // that window makes the push non-fast-forward. This is n=2, which is the
  // entire point of a shared memory, so it must not need a human to untangle.
  await withHome(async (home: string) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const git = promisify(execFile);
    const origin = join(home, "origin.git");
    await git("git", ["init", "-q", "--bare", "-b", "main", origin]);

    const clone = async (name: string) => {
      const dir = join(home, name);
      await git("git", ["clone", "-q", origin, dir]);
      await git("git", ["-C", dir, "config", "user.email", `${name}@acme.dev`]);
      await git("git", ["-C", dir, "config", "user.name", name]);
      return dir;
    };

    const alice = await clone("alice");
    await writeFile(join(alice, "_company.md"), "---\ntype: nacre-company\n---\n\nfacts\n");
    await git("git", ["-C", alice, "add", "-A"]);
    await git("git", ["-C", alice, "commit", "-qm", "seed"]);
    await git("git", ["-C", alice, "push", "-q"]);

    const bob = await clone("bob");

    // Both compose against the same base, as two real sessions would.
    for (const [dir, who] of [[alice, "alice"], [bob, "bob"]] as const) {
      await writeFile(join(dir, `atlas-${who}.md`), `---\nwho: ${who}\n---\n\nlog\n`);
      await git("git", ["-C", dir, "add", "-A"]);
      await git("git", ["-C", dir, "commit", "-qm", `log(atlas): ${who}`]);
    }

    await git("git", ["-C", alice, "push", "-q"]);

    // Bob loses the race.
    await assert.rejects(git("git", ["-C", bob, "push", "-q"]), "the race must actually happen");

    // The documented recovery, exactly as the skill writes it.
    await git("git", ["-C", bob, "pull", "--rebase", "--autostash", "-q"]);
    await git("git", ["-C", bob, "push", "-q"]);

    const check = join(home, "check");
    await git("git", ["clone", "-q", origin, check]);
    await access(join(check, "atlas-alice.md"));
    await access(join(check, "atlas-bob.md"));

    const { stdout } = await git("git", ["-C", check, "log", "--oneline"]);
    assert.equal(stdout.trim().split("\n").length, 3, "linear history, nothing lost");
  });
});

test("three people publishing in the same window all survive", async () => {
  // n=2 is the minimum that proves the race; a real team is larger, and the
  // failure that only appears at n>=3 is the second loser rebasing onto a base
  // the first loser already moved. Each of the two losers must recover with the
  // exact command the skill documents, in sequence, and all three logs must land
  // with nothing overwritten.
  await withHome(async (home: string) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const git = promisify(execFile);
    const origin = join(home, "origin.git");
    await git("git", ["init", "-q", "--bare", "-b", "main", origin]);

    const clone = async (name: string) => {
      const dir = join(home, name);
      await git("git", ["clone", "-q", origin, dir]);
      await git("git", ["-C", dir, "config", "user.email", `${name}@acme.dev`]);
      await git("git", ["-C", dir, "config", "user.name", name]);
      return dir;
    };

    const alice = await clone("alice");
    await writeFile(join(alice, "_company.md"), "---\ntype: nacre-company\n---\n\nfacts\n");
    await git("git", ["-C", alice, "add", "-A"]);
    await git("git", ["-C", alice, "commit", "-qm", "seed"]);
    await git("git", ["-C", alice, "push", "-q"]);

    // bob and carol both clone the seed, so all three compose against one base.
    const bob = await clone("bob");
    const carol = await clone("carol");

    for (const [dir, who] of [[alice, "alice"], [bob, "bob"], [carol, "carol"]] as const) {
      await writeFile(join(dir, `atlas-${who}.md`), `---\nwho: ${who}\n---\n\nlog\n`);
      await git("git", ["-C", dir, "add", "-A"]);
      await git("git", ["-C", dir, "commit", "-qm", `log(atlas): ${who}`]);
    }

    // Alice wins the race; bob and carol both lose against the same base.
    await git("git", ["-C", alice, "push", "-q"]);
    await assert.rejects(git("git", ["-C", bob, "push", "-q"]), "bob must lose to alice");
    await assert.rejects(git("git", ["-C", carol, "push", "-q"]), "carol must lose to alice");

    // bob recovers first and pushes. carol's base is now two commits stale — the
    // n>=3 case: her rebase lands on top of both alice's and bob's work.
    await git("git", ["-C", bob, "pull", "--rebase", "--autostash", "-q"]);
    await git("git", ["-C", bob, "push", "-q"]);
    await assert.rejects(git("git", ["-C", carol, "push", "-q"]), "carol still loses, now to bob");
    await git("git", ["-C", carol, "pull", "--rebase", "--autostash", "-q"]);
    await git("git", ["-C", carol, "push", "-q"]);

    const check = join(home, "check");
    await git("git", ["clone", "-q", origin, check]);
    await access(join(check, "atlas-alice.md"));
    await access(join(check, "atlas-bob.md"));
    await access(join(check, "atlas-carol.md"));

    const { stdout } = await git("git", ["-C", check, "log", "--oneline"]);
    assert.equal(stdout.trim().split("\n").length, 4, "seed plus three logs, linear, nothing lost");
  });
});

test("the publish skill still documents the retry", async () => {
  // Cheap guard on an expensive lesson: without this line a bare push fails
  // the first time two teammates publish within minutes of each other.
  const skill = await readFile(join(PKG_ROOT_FOR_TEST, "skills/nacre-publish/SKILL.md"), "utf8");
  assert.match(skill, /pull --rebase --autostash/);
  assert.match(skill, /Never force-push/i);
});

test("a GitHub memory yields a slug; anything else is left alone", async () => {
  const { githubSlug } = await import("../src/store.js");
  assert.equal(githubSlug("git@github.com:acme/acme-context.git"), "acme/acme-context");
  assert.equal(githubSlug("https://github.com/acme/acme-context"), "acme/acme-context");
  assert.equal(githubSlug("https://github.com/acme/acme-context.git"), "acme/acme-context");
  // Self-hosted memories are legitimate. Guessing a collaborator API for one
  // would fail in a way that reads as nacre being broken.
  assert.equal(githubSlug("git@gitlab.com:acme/x.git"), null);
  assert.equal(githubSlug("/tmp/local/memory"), null);
  assert.equal(githubSlug(null), null);
});

test("a non-GitHub remote points at the hosting instead of failing blankly", async () => {
  const { invite } = await import("../src/store.js");
  const r = await invite("git@gitlab.com:acme/x.git", "dana");
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /not a GitHub remote/);
});

test("brief fetches the memory rather than telling a teammate to init", async () => {
  // Running `init` on a bound repo builds a SECOND memory whose history has
  // nothing in common with the team's. The library was fixed for this; `nacre
  // brief` was later wired straight to the filesystem and reintroduced it.
  const bin = await readFile(fileURLToPath(new URL("../../bin/nacre.ts", import.meta.url)), "utf8");
  const cmd = bin.slice(bin.indexOf('command === "brief"'), bin.indexOf('command === "search"'));
  assert.ok(cmd.includes("ensureMemory"), "brief must fetch the memory");
  assert.ok(!/nacre init/.test(cmd), "brief must never send a bound repo to init");
});

test("a new memory is created on main, not on whatever git defaults to", async () => {
  // git init uses init.defaultBranch, still `master` unless someone changed it.
  // The memory was created on master, pushed to master, and a teammate cloning
  // a remote whose HEAD is main got an empty tree and was told the memory did
  // not look like a nacre memory. Silent, and only ever hit by the second person.
  await withHome(async (home: string) => {
    const store = await initStore({ store: null as unknown as string, who: "alice" });
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const git = promisify(execFile);
    const { stdout } = await git("git", ["-C", store.dir, "symbolic-ref", "HEAD"]);
    assert.equal(stdout.trim(), "refs/heads/main", "the memory must be created on main");
    assert.ok(home);
  });
});

test("an empty memory remote is reported as unpushed, not as malformed", async () => {
  // The likeliest thing a teammate hits after the likeliest owner mistake.
  // Blaming the contents sends them to inspect a repo that is simply empty.
  await withHome(async (home: string) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const git = promisify(execFile);
    const remote = join(home, "empty.git");
    await git("git", ["init", "-q", "--bare", "-b", "main", remote]);

    const { ensureMemory } = await import("../src/store.js");
    const r = await ensureMemory(join(home, "memory"), remote);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /empty/);
    assert.match((r as { reason: string }).reason, /has not pushed/);
  });
});

test("linking writes a SessionStart hook without touching the project's own settings", async () => {
  // The AGENTS.md note *asks* an agent to load context. Asking is discipline,
  // and discipline is what this project exists to stop relying on. A hook fires
  // whether or not anyone remembers.
  await withHome(async (home: string) => {
    const repo = join(home, "atlas-web");
    await mkdir(join(repo, ".claude"), { recursive: true });
    await writeFile(join(repo, ".claude", "settings.json"), JSON.stringify({
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo theirs" }] }] },
    }));
    await initStore({ store: "git@github.com:acme/acme-context.git", who: "alice" });
    await addProject({ project: "atlas", who: "alice" });
    const linked = await linkRepo({ repo, project: "atlas" });
    assert.ok(linked.hooked);

    const settings = JSON.parse(await readFile(join(repo, ".claude", "settings.json"), "utf8"));
    assert.deepEqual(settings.permissions.allow, ["Bash(ls:*)"], "their settings must survive");
    const commands = settings.hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    assert.ok(commands.includes("echo theirs"), "their hook must survive");
    assert.equal(commands.filter((c: string) => c.includes("nacre-cli brief")).length, 1);
  });
});

test("the hook is written once, however many times add is re-run", async () => {
  await withHome(async (home: string) => {
    const repo = join(home, "atlas-web");
    await mkdir(repo, { recursive: true });
    await initStore({ store: "git@github.com:acme/acme-context.git", who: "alice" });
    await addProject({ project: "atlas", who: "alice" });
    await linkRepo({ repo, project: "atlas" });
    const second = await linkRepo({ repo, project: "atlas" });
    await linkRepo({ repo, project: "atlas" });

    assert.equal(second.hooked, false, "an unchanged hook should not report a write");
    const settings = JSON.parse(await readFile(join(repo, ".claude", "settings.json"), "utf8"));
    const commands = settings.hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    assert.equal(commands.filter((c: string) => c.includes("nacre-cli brief")).length, 1);
  });
});

test("unparseable settings are left alone rather than replaced", async () => {
  // Almost certainly someone's in-progress edit. Rewriting it would turn a
  // syntax error into a lost file.
  await withHome(async (home: string) => {
    const repo = join(home, "atlas-web");
    await mkdir(join(repo, ".claude"), { recursive: true });
    const broken = '{ "permissions": { "allow": [ }';
    await writeFile(join(repo, ".claude", "settings.json"), broken);
    await initStore({ store: "git@github.com:acme/acme-context.git", who: "alice" });
    await addProject({ project: "atlas", who: "alice" });
    const linked = await linkRepo({ repo, project: "atlas" });

    assert.equal(linked.hooked, false);
    assert.equal(await readFile(join(repo, ".claude", "settings.json"), "utf8"), broken);
  });
});

test("one bullet is one entry, and it does not carry its own marker", () => {
  // Two defects in one line of parsing. Blocks split on blank lines alone, so
  // three rejected options written as three bullets came back as ONE run-on
  // entry — the highest-value content in the store, merged into a sentence
  // nobody wrote. And the marker survived, so the brief rendered "- * Reverting".
  const { against } = parseLog(
    "---\nproject: atlas\n---\n\n## Decided against\n\n" +
      "* Reverting to 401.\n- Retrying uploads.\n\n* A third one,\n  wrapped onto two lines.\n",
  );
  assert.deepEqual(against, [
    "Reverting to 401.",
    "Retrying uploads.",
    // A wrapped continuation still belongs to the bullet above it.
    "A third one, wrapped onto two lines.",
  ]);
});

test("a missing LOCAL memory is not reported as a permissions problem", async () => {
  // git prints the same "could not read from remote / correct access rights"
  // for a path that is simply not there. On Windows that turned a missing
  // directory into "the memory is private and you are not on it yet", which
  // sends someone to ask for an invite to a repository nobody has.
  await withHome(async (home: string) => {
    const { ensureMemory } = await import("../src/store.js");
    const r = await ensureMemory(join(home, "memory"), join(home, "does-not-exist.git"));
    assert.equal(r.ok, false);
    const reason = (r as { reason: string }).reason;
    // Match the sentence, not the word: macOS temp paths contain "/private/".
    assert.ok(!/is private and you are not on it/i.test(reason), reason);
    assert.ok(!/nacre invite/i.test(reason), reason);
    assert.match(reason, /could not clone/i);
  });
});
