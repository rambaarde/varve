/**
 * Tests for reading the memory and serving it.
 *
 * The load-bearing one is that the CLI and the portal rank a query identically.
 * They are different renderers over one search, and if that ever stops being
 * true the promise of one mental model across both doors quietly breaks —
 * silently, because each door on its own would still look correct.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { parseLog, readLogs, search, projectView, personView, index, unfilled, projectStandards, seamGraph } from "../src/portal.js";
import { markdown, escape } from "../src/markdown.js";
import { serve } from "../src/serve.js";

const LOG_A = `---
project: atlas
who: alice
started: 2026-08-01T09:14:03
repos: [atlas-api, atlas-web]
---

Renamed the rate-limit headers and verified them in staging.

## Decided against
Raising the shared cache eviction limit. Same instance as beacon.

## Open risks
atlas-web still reads the old header name.

## Next
Remove the old header path in atlas-web.
`;

const LOG_B = `---
project: atlas
who: bob
started: 2026-08-04T16:22:07
repos: [atlas-web]
---

Added the new handler. Deploy after atlas-api.
`;

/** A memory with two people, two projects, and a cross-project fact. */
/**
 * Remove a temp directory safely on every platform.
 *
 * Windows refuses to delete the process's working directory, and holds file
 * handles briefly after close — so restore cwd first and let rm retry. On POSIX
 * both are no-ops, which is exactly why this stayed broken until CI ran on
 * Windows.
 */
const HOME_BASE = tmpdir();
export async function drop(dir: string): Promise<void> {
  if (process.cwd().startsWith(dir)) process.chdir(HOME_BASE);
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

async function fixture(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "nacre-portal-")));
  // Same isolation as store.test: nothing above the repo may influence a read.
  process.chdir(dir);
  await writeFile(join(dir, "_company.md"), "---\ntype: nacre-company\n---\n\nThe cache instance is shared by atlas and beacon.\n");
  await writeFile(join(dir, "_standards.md"), "---\ntype: nacre-standards\n---\n\nMigrations are raw SQL.\n");
  const PROJECTS: Array<[string, string]> = [["atlas", "Atlas"], ["beacon", "Beacon"]];
  for (const [p, title] of PROJECTS) {
    await mkdir(join(dir, p), { recursive: true });
    await writeFile(join(dir, p, "_project.md"),
      `---\nproject: ${p}\ntitle: ${title}\nrepos: [${p}-api]\nteams: [devs]\n---\n\n# ${title}\n`);
  }
  await mkdir(join(dir, "atlas", "devs", "alice"), { recursive: true });
  await mkdir(join(dir, "atlas", "devs", "bob"), { recursive: true });
  await mkdir(join(dir, "beacon", "devs", "alice"), { recursive: true });
  await writeFile(join(dir, "atlas/devs/alice/atlas-2026-08-01_09-14-03.md"), LOG_A);
  await writeFile(join(dir, "atlas/devs/bob/atlas-2026-08-04_16-22-07.md"), LOG_B);
  await writeFile(join(dir, "beacon/devs/alice/beacon-2026-07-28_11-02-18.md"),
    "---\nproject: beacon\nwho: alice\nrepos: [beacon-api]\n---\n\nInventory. The cache instance is shared with atlas.\n");
  return dir;
}

test("parseLog splits sections and survives a log that uses none", () => {
  const p = parseLog(LOG_A);
  assert.equal(p.fm.who, "alice");
  assert.deepEqual(p.fm.repos, ["atlas-api", "atlas-web"]);
  assert.match(p.against[0] ?? "", /cache eviction limit/);
  assert.match(p.risks[0] ?? "", /old header name/);
  assert.match(p.next, /Remove the old header path/);

  const plain = parseLog("---\nwho: bob\n---\n\nJust prose, no headings.\n");
  assert.deepEqual(plain.against, [], "no sections is not an error");
  assert.match(plain.summary, /Just prose/, "the body must survive intact");
});

test("readLogs walks team and person folders, newest first", async () => {
  const dir = await fixture();
  const logs = await readLogs(dir);
  assert.equal(logs.length, 3);
  assert.equal(logs[0]?.who, "bob", "newest first, and filenames sort");
  assert.deepEqual(await readLogs(dir, "beacon").then((l) => l.map((x) => x.who)), ["alice"]);
  await drop(dir);
});

test("the seam graph draws repo-to-repo only when one session named both", async () => {
  const dir = await fixture();
  const g = seamGraph(await readLogs(dir));

  // Entities are nodes; logs are not. Three logs must not become three nodes,
  // because that is the rule keeping this readable at a thousand sessions.
  assert.equal(g.logs, 3);
  assert.equal(g.nodes.filter((n) => n.kind === "who").length, 2);
  assert.equal(g.nodes.filter((n) => n.kind === "project").length, 2);

  const seams = g.edges.filter((e) => e.seam);
  assert.equal(seams.length, 1, "only alice's log names two repos");
  assert.deepEqual([seams[0]?.a, seams[0]?.b].sort(), ["repo:atlas-api", "repo:atlas-web"]);
  assert.equal(g.crossRepo, 1, "the cross-repo count is sessions, not pairs");

  // Weight is sessions, so two people on one project thicken the edge rather
  // than adding a second one.
  const alice = g.nodes.find((n) => n.id === "who:alice");
  assert.equal(alice?.sessions, 2, "alice appears in atlas and beacon");
  assert.ok(alice?.href.startsWith("/who/"), "nodes link to the writing behind them");

  await drop(dir);
});

test("the seam graph carries counts, never log content", async () => {
  const dir = await fixture();
  const g = seamGraph(await readLogs(dir));
  const serialised = JSON.stringify(g);
  // The page is an index, not a summary. If prose ever reaches it, the
  // never-aggregate-log-content rule has been broken and this catches it.
  assert.ok(!serialised.includes("rate-limit"), "no summary text");
  assert.ok(!serialised.includes("Raising the shared cache"), "no decided-against text");
  await drop(dir);
});

test("the graph page ships the filter and pin controls, and no NaN positions", async () => {
  const dir = await fixture();
  const { server, url } = await serve({ memory: dir, port: 0 });
  try {
    const body = await (await fetch(`${url}/graph`)).text();
    // The two interactions must actually reach the page, not just the CSS.
    assert.match(body, /id="seamfilter"/, "the filter input is absent");
    assert.match(body, /function showNode/, "the pin/hover panel logic is absent");
    assert.match(body, /svg\.filtering/, "the filter dim rule is absent");
    // A layout that divided by zero or read a missing seed would serialise NaN
    // into the node positions, and the force sim would then spread NaN to every
    // node on the first tick. The seed data must be finite.
    const seed = body.match(/<script type="application\/json" id="seamdata">([\s\S]*?)<\/script>/)?.[1] ?? "";
    assert.ok(seed.length > 0, "the seam data block is missing");
    assert.doesNotMatch(seed, /NaN/, "a node position serialised as NaN");
    assert.doesNotMatch(seed, /\\u003cscript/i, "unrelated, but the JSON must stay inert");
  } finally {
    server.close();
    await drop(dir);
  }
});

test("the graph renders on a degenerate store: one node, and none", async () => {
  // A single log is one person plus one project plus its repos — a graph with
  // barely any edges, the case where a spring/charge layout most easily divides
  // by zero. And an empty store has zero nodes, where every max/sqrt guard has
  // to hold. Both must return a page, not a stack trace.
  const one = await realpath(await mkdtemp(join(tmpdir(), "nacre-one-")));
  await writeFile(join(one, "_company.md"), "---\ntype: nacre-company\n---\n\nx\n");
  await mkdir(join(one, "atlas", "devs", "alice"), { recursive: true });
  await writeFile(join(one, "atlas", "_project.md"),
    "---\nproject: atlas\nrepos: [atlas-api]\nteams: [devs]\n---\n\n# Atlas\n");
  await writeFile(join(one, "atlas", "devs", "alice", "atlas-2026-08-01_09-14-03.md"),
    "---\nproject: atlas\nwho: alice\nrepos: [atlas-api]\n---\n\n## Summary\n\nOne session.\n");
  const s1 = await serve({ memory: one, port: 0 });
  try {
    const r = await fetch(`${s1.url}/graph`);
    assert.equal(r.status, 200, "one-node graph must render");
    assert.doesNotMatch(await r.text(), /NaN/, "one-node layout produced NaN");
  } finally { s1.server.close(); await drop(one); }

  const none = await realpath(await mkdtemp(join(tmpdir(), "nacre-none-")));
  await writeFile(join(none, "_company.md"), "---\ntype: nacre-company\n---\n\nx\n");
  const s2 = await serve({ memory: none, port: 0 });
  try {
    const r = await fetch(`${s2.url}/graph`);
    assert.equal(r.status, 200, "an empty store's graph must still render");
    assert.doesNotMatch(await r.text(), /NaN/, "empty layout produced NaN");
  } finally { s2.server.close(); await drop(none); }
});

test("search ranks live constraints above ordinary hits", async () => {
  const dir = await fixture();
  const hits = await search(dir, "cache", { all: true });
  assert.ok(hits.length >= 3);
  assert.equal(hits[0]?.against, true, "a decided-against must not sort below prose");
  assert.ok(hits.some((h) => h.project === "_company"),
    "the company-level fact is the row a per-repo tool cannot produce");
  await drop(dir);
});

test("search scoped to one project never returns another's", async () => {
  const dir = await fixture();
  const scoped = await search(dir, "cache", { project: "atlas" });
  assert.ok(scoped.every((h) => h.project === "atlas" || h.project === "_company"));
  assert.ok(!scoped.some((h) => h.project === "beacon"));
  await drop(dir);
});

test("a superseding log replaces the one it supersedes", async () => {
  const dir = await fixture();
  await writeFile(join(dir, "atlas/devs/alice/atlas-2026-08-05_10-00-00.md"),
    "---\nproject: atlas\nwho: alice\nsupersedes: atlas-2026-08-01_09-14-03\n---\n\n## Decided against\nCorrected: the limit can be raised after beacon moves off.\n");
  const v = await projectView(dir, "atlas");
  assert.ok(v);
  assert.ok(!v.logs.some((l) => l.id === "atlas-2026-08-01_09-14-03"),
    "the superseded log drops out of the live view");
  assert.ok(v.logs.some((l) => l.against.some((a) => /Corrected/.test(a))),
    "and the superseding one carries the correction");
  // `count` describes what is listed; `superseded` says how many are hidden.
  // Together they still prove nothing was overwritten, and unlike a single
  // total they do not print "3 logs" above two rows.
  assert.equal(v.superseded, 1, "the correction is reported, not silently hidden");
  assert.equal(v.count + v.superseded, 3, "both files remain — nothing is overwritten");
  assert.equal(v.count, v.logs.length, "the count must describe what is listed");
  await drop(dir);
});

test("projectView orders by urgency of not knowing", async () => {
  const dir = await fixture();
  const v = await projectView(dir, "atlas");
  assert.ok(v);
  assert.ok(v);
  assert.match(v.handoff, /Remove the old header path/);
  assert.deepEqual(v.repos, ["atlas-api"]);
  // Decisions and rejections are read in the log that made them, not merged
  // onto this page — a project with 99 logs would otherwise render 92 of them.
  assert.ok(!("against" in v), "the project page must not aggregate log content");
  assert.ok(!("risks" in v));
  await drop(dir);
});

test("personView spans projects", async () => {
  const dir = await fixture();
  const v = await personView(dir, "alice");
  assert.deepEqual(v.projects, ["atlas", "beacon"]);
  assert.equal(v.count, 2);
  assert.ok(!("against" in v), "nor the person page");
  assert.ok(!("decisions" in v));
  await drop(dir);
});

test("index counts all three axes", async () => {
  const dir = await fixture();
  const i = await index(dir);
  assert.deepEqual(i.projects, { atlas: 2, beacon: 1 });
  assert.deepEqual(i.people, { alice: 2, bob: 1 });
  assert.equal(i.total, 3);
  await drop(dir);
});

test("markdown escapes anything that could inject", () => {
  const html = markdown('<script>alert(1)</script>\n\n**bold** and `code`');
  assert.ok(!html.includes("<script>"), "raw tags must never survive");
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.equal(escape('a "b" <c>'), "a &quot;b&quot; &lt;c&gt;");
});

test("the portal serves every axis", async () => {
  const dir = await fixture();
  const { server, url } = await serve({ memory: dir, port: 0 });
  const get = async (p: string) => {
    const res = await fetch(url + p);
    return { status: res.status, body: await res.text() };
  };
  try {
    const project = await get("/p/atlas");
    assert.equal(project.status, 200);
    assert.match(project.body, /Remove the old header path/);
    assert.ok(!/text-decoration:\s*line-through/.test(project.body),
      "a live constraint must never render as struck through");

    assert.match((await get("/who/alice")).body, /2 projects/);
    assert.match((await get("/t/2026-08")).body, /2026-08/);
    assert.match((await get("/search?q=cache&all=1")).body, /hit/);
    assert.equal((await get("/p/nope")).status, 404);
    assert.equal((await get("/nowhere")).status, 404);
  } finally {
    server.close();
    await drop(dir);
  }
});

test("the CLI and the portal rank a query identically", async () => {
  // One search(), two renderers. If these ever diverge, each door still looks
  // right on its own — which is exactly why it needs a test rather than a rule.
  const dir = await fixture();
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const bin = fileURLToPath(new URL("../bin/nacre.js", import.meta.url));

  const engine = await search(dir, "cache", { all: true });
  const { stdout } = await run(process.execPath,
    [bin, "search", "cache", "--all", "--memory", dir]);

  const cliOrder = stdout.split("\n").filter((l: string) => /^\d{4}-|^,/.test(l))
    .map((l: string) => l.split(",").slice(0, 3).join(","));
  const engineOrder = engine.slice(0, cliOrder.length)
    .map((h) => [h.date, h.who, h.project].join(","));
  assert.deepEqual(cliOrder, engineOrder, "ranking is the engine's job, truncation the adapter's");
  await drop(dir);
});

test("company-wide reads sort by time, not by project name", async () => {
  // Filenames begin with the project slug, so sorting by name orders a
  // company-wide read alphabetically by project — and looks perfectly correct
  // inside any single project, which is why it needs its own test.
  const dir = await fixture();
  const logs = await readLogs(dir);
  const stamps = logs.map((l) => l.stamp);
  assert.deepEqual([...stamps].sort().reverse(), stamps, "newest first, across every project");
  assert.equal(logs[0]?.who, "bob");
  await drop(dir);
});

test("nacre search and nacre serve work as commands, not just as functions", async () => {
  // Everything else exercises the operations directly. These two reach the user
  // only through the CLI, so the wiring between them needs its own check.
  const dir = await fixture();
  const { execFile, spawn } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const bin = fileURLToPath(new URL("../bin/nacre.js", import.meta.url));

  const { stdout } = await run(process.execPath, [bin, "search", "cache", "--all", "--memory", dir]);
  assert.match(stdout, /^hits\[\d+\]\{date,who,project,line\}:/m, "AXI shape on stdout");
  assert.match(stdout, /help\[\]:/, "every result ends in a next step");

  const empty = await run(process.execPath, [bin, "search", "zzzznothing", "--all", "--memory", dir]);
  assert.match(empty.stdout, /no hits/, "an empty result must be explicit, never silent");

  // serve holds the process open, so drive it as a child and stop it.
  const child = spawn(process.execPath, [bin, "serve", "--memory", dir, "--port", "0"]);
  try {
    const line: string = await new Promise<string>((resolve, reject) => {
      child.stdout.once("data", (d: unknown) => resolve(String(d)));
      child.once("error", reject);
      setTimeout(() => reject(new Error("serve did not announce a url")), 8000);
    });
    assert.match(line, /ok: serving http:\/\/127\.0\.0\.1:\d+/);
  } finally {
    child.kill();
    await drop(dir);
  }
});

test("--port 0 asks for any free port, and is not swallowed", async () => {
  // `|| 4173` treated an explicit 0 as absent. Port 0 is the conventional way
  // to ask the OS for a free port, and it is what a second instance needs.
  const dir = await fixture();
  const { spawn } = await import("node:child_process");
  const bin = fileURLToPath(new URL("../bin/nacre.js", import.meta.url));
  const child = spawn(process.execPath, [bin, "serve", "--memory", dir, "--port", "0"]);
  try {
    const line: string = await new Promise<string>((resolve, reject) => {
      child.stdout.once("data", (d: unknown) => resolve(String(d)));
      setTimeout(() => reject(new Error("no url")), 8000);
    });
    const port = Number(line.match(/:(\d+)/)?.[1]);
    assert.notEqual(port, 4173, "an explicit 0 must not fall back to the default");
    assert.ok(port > 0);
  } finally {
    child.kill();
    await drop(dir);
  }
});

test("the vault's own bullet format parses, not just headings", async () => {
  // The format this design descends from uses labelled bullets under one
  // heading, not `## Sections`. A heading-only parser read a real 103-day-old
  // vault and surfaced nothing — every block on the project page came up empty
  // while the file rendered fine, which is the worst shape of wrong.
  const log = [
    "---", "project: acme", "who: ram", "---", "",
    "# Session Outcome", "",
    "* **High-Level Summary:** Split 401 and 419 so the client can tell",
    "  expired from unauthorised.",
    "* **Important Decisions:** API ships first; the web app follows.",
    "* **Decided Against:** Raising the shared eviction limit.",
    "* **Constraints / Blockers:** acme-fe still treats 419 as a logout.",
    "* **Next Step:** Add the handler, then deploy fe after be.",
    "* **Notes for Future AI:** Deploy order is a contract.",
  ].join("\n");

  const p = parseLog(log);
  assert.match(p.summary, /Split 401 and 419/);
  assert.match(p.decisions[0] ?? "", /API ships first/);
  assert.match(p.against[0] ?? "", /Raising the shared eviction limit/);
  assert.match(p.risks[0] ?? "", /still treats 419/, "Constraints / Blockers must reach risks");
  assert.match(p.next, /deploy fe after be/);
  assert.match(p.notes[0] ?? "", /contract/);

  // A wrapped bullet is one thought, not two entries.
  assert.ok(!p.summary.includes("\n"), "wrapped lines fold into one entry");
  assert.match(p.summary, /tell expired from unauthorised/);
});

test("heading form still parses, so either shape works", () => {
  const p = parseLog("---\nwho: jun\n---\n\n## Decided against\nOptimistic UI.\n\n## Next\nShip it.\n");
  assert.match(p.against[0] ?? "", /Optimistic UI/);
  assert.match(p.next, /Ship it/);
});

test("a project can carry its own standards, and they stay scoped to it", async () => {
  // Company standards are paid for by every project on every read. A rule true
  // of one stack must not be one of them — a Python project should never load
  // a Node project's test runner.
  const dir = await fixture();
  await writeFile(join(dir, "atlas", "_standards.md"),
    "---\ntype: nacre-project-standards\nproject: atlas\n---\n\n# Atlas — Standards\n\n* **Stack:** Node 20, Postgres.\n");

  const { projectStandards, projectView } = await import("../src/portal.js");

  assert.match((await projectStandards(dir, "atlas")) ?? "", /Node 20/);
  assert.equal(await projectStandards(dir, "beacon"), null,
    "a project without its own standards must report none, not inherit a file");

  assert.equal((await projectView(dir, "atlas"))?.hasStandards, true);
  assert.equal((await projectView(dir, "beacon"))?.hasStandards, false);

  const { serve } = await import("../src/serve.js");
  const { server, url } = await serve({ memory: dir, port: 0 });
  try {
    const atlas = await fetch(`${url}/s/atlas`);
    assert.equal(atlas.status, 200);
    assert.match(await atlas.text(), /Node 20/);

    // Absent is not an error worth a stack trace — it means the company rules apply.
    const beacon = await fetch(`${url}/s/beacon`);
    assert.equal(beacon.status, 404);
    assert.match(await beacon.text(), /company standards apply/);
  } finally {
    server.close();
    await drop(dir);
  }
});

test("the project page carries the curated note and does not grow with the log", async () => {
  // The page used to assemble every decision and rejection from every log. At
  // the scale the source vault actually runs — 99 logs, 92 of them carrying
  // decisions — that is a wall, and capping it only made it a truncated wall.
  const dir = await fixture();
  const many = join(dir, "atlas", "devs", "alice");
  for (let i = 1; i <= 40; i++) {
    const day = String(10 + (i % 20)).padStart(2, "0");
    await writeFile(join(many, `atlas-2026-09-${day}_09-${String(i).padStart(2, "0")}-00.md`),
      `---\nproject: atlas\nwho: alice\n---\n\n* **Decided Against:** rejection ${i}.\n`);
  }

  const { serve } = await import("../src/serve.js");
  const { server, url } = await serve({ memory: dir, port: 0 });
  try {
    const body = await (await fetch(`${url}/p/atlas`)).text();
    assert.match(body, /Project note/, "the curated half is what the page carries");
    assert.doesNotMatch(body, /rejection 4\b/, "log content is not merged onto the page");
    assert.doesNotMatch(body, /Decided against<\/span>/i);
  } finally {
    server.close();
    await drop(dir);
  }
});

test("the rail is identical on every page — only the highlight moves", async () => {
  // A sidebar that changes shape as you move is not navigation. The project
  // group used to appear only on project pages, so clicking a person made the
  // whole rail jump up four rows and every target land somewhere else.
  const dir = await fixture();
  await writeFile(join(dir, "atlas", "_standards.md"),
    "---\nproject: atlas\n---\n\n# Atlas — Standards\n\n* **Stack:** Node.\n");

  const { serve } = await import("../src/serve.js");
  const { server, url } = await serve({ memory: dir, port: 0 });
  try {
    const railOf = async (path: string) => {
      const html = await (await fetch(url + path)).text();
      const rail = html.match(/<nav class="side">[\s\S]*?<\/nav>/)?.[0] ?? "";
      // The active-highlight class is the only thing allowed to differ.
      return rail.replace(/class="(on)?"/g, "").replace(/\s+/g, " ");
    };

    const paths = ["/p/atlas", "/s/atlas", "/who/alice", "/c/_company", "/t/2026-08", "/search?q=cache"];
    const rails = await Promise.all(paths.map(railOf));
    for (const [i, rail] of rails.entries()) {
      assert.equal(rail, rails[0], `${paths[i]} renders a different rail`);
    }
    assert.ok(rails[0]!.length > 0, "and it is not empty");

    // Project-scoped nav lives on the page, where it cannot reflow the sidebar.
    const overview = await (await fetch(`${url}/p/atlas`)).text();
    assert.match(overview, /<nav class="tabs">/);
    assert.match(overview, /href="\/s\/atlas"/);

    // A page load must not log a 404 for a missing favicon.
    assert.equal((await fetch(`${url}/favicon.ico`)).status, 204);
  } finally {
    server.close();
    await drop(dir);
  }
});

test("the auto block never stands in for what a person wrote", async () => {
  // git output appended below the notes must not become the summary. A log with
  // commits and nothing said is still a log with nothing said.
  const log = [
    "---", "project: atlas", "who: ram", "---", "",
    "# Session Outcome", "",
    "* **High-Level Summary:** Split 401 and 419.",
    "", "## Auto Session Log",
    "_Auto-generated 2026-08-04 22:36:21._", "",
    "* **Repos:** atlas-api", "* **Branch:** main",
    "* **Commits this session:**", "- b057180 feat(api): send 419 on expiry",
  ].join("\n");

  const p = parseLog(log);
  assert.match(p.summary, /Split 401 and 419/);
  assert.doesNotMatch(p.summary, /b057180|Auto Session Log/,
    "machine output must stay out of the human summary");
  assert.ok(p.auto.some((a) => /b057180/.test(a)), "but it is still captured and readable");
});

test("an unfilled project template is an empty state, not thirty lines of brackets", async () => {
  // The template ships as prompts. Rendered verbatim it was thirty lines of
  // [What problem this product solves] above the logs — labelled "curated",
  // answering nothing, and pushing the actual sessions below the fold.
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(
    join(import.meta.dirname, "..", "..", "store-template", "PROJECT-TEMPLATE", "_project.md"),
    "utf8",
  );
  const body = raw
    .replace(/^(?:\s|<!--[\s\S]*?-->)*---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();

  assert.equal(unfilled(body), "", "the shipped template must read as unwritten");

  // Half-written keeps what was written, and only that — including dropping the
  // headings whose every line is still a prompt.
  const half = body.replace(
    "* **Purpose:** [What problem this product solves]",
    "* **Purpose:** Keep stock counts truthful across warehouses.",
  );
  const kept = unfilled(half);
  assert.match(kept, /Keep stock counts truthful/, "written lines survive");
  assert.doesNotMatch(kept, /\[What problem/, "prompts do not");
  assert.doesNotMatch(kept, /Architecture at a Glance/, "nor headings with nothing under them");
});

test("a scaffolded profile reads as unwritten too, not just the project note", async () => {
  // The placeholder rule was applied to the project note and not to profiles,
  // so a person's own page showed "Role: [One line]" under a heading marked
  // "curated". Same rule, both places.
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(
    join(import.meta.dirname, "..", "..", "store-template", "_team", "_your-slug", "_profile.md"),
    "utf8",
  );
  const body = raw
    .replace(/^(?:\s|<!--[\s\S]*?-->)*---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  assert.equal(unfilled(body), "", "the shipped profile template must read as unwritten");
});

test("every shipped template reads as unwritten — company and standards too", async () => {
  // The placeholder rule landed in three places across three releases: project
  // notes (0.2.4), profiles (0.2.6), and finally the company page — the one
  // document loaded into every brief, in every project. This asserts all four
  // shipped templates at once so the fourth omission cannot happen quietly.
  const { readFile } = await import("node:fs/promises");
  const root = join(import.meta.dirname, "..", "..", "store-template");
  const templates = [
    "_company.md",
    "_standards.md",
    join("_team", "_your-slug", "_profile.md"),
    join("PROJECT-TEMPLATE", "_project.md"),
    join("PROJECT-TEMPLATE", "_standards.md"),
  ];
  for (const rel of templates) {
    const body = (await readFile(join(root, rel), "utf8"))
      .replace(/^(?:\s|<!--[\s\S]*?-->)*---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .trim();
    assert.equal(unfilled(body), "", `${rel} must read as unwritten until someone fills it in`);
  }
});

test("a project name is one directory name, never a path", async () => {
  // The portal decodes URL parameters, and %2e%2e%2f survives Node's path
  // normalisation to become ../ afterwards — so /s/%2e%2e%2foutside read a
  // _standards.md from outside the memory entirely, and /p/ did the same with
  // _project.md. Guarding the two routes would have left the next route to
  // rediscover it, so the check lives where a name becomes a file.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "nacre-trav-")));
  const outside = join(dir, "outside");
  const memory = join(dir, "memory");
  await mkdir(outside, { recursive: true });
  await mkdir(join(memory, "atlas"), { recursive: true });
  await writeFile(join(outside, "_standards.md"), "SHOULD NEVER BE SERVED\n");
  await writeFile(join(outside, "_project.md"), "---\nproject: pwned\n---\nSHOULD NEVER BE SERVED\n");
  await writeFile(join(memory, "atlas", "_project.md"), "---\nproject: atlas\nrepos: [a]\n---\n");

  for (const evil of ["../outside", "..", ".", "../../etc", "a/b", "..\\outside", "atlas/../../outside"]) {
    assert.equal(await projectStandards(memory, evil), null, `standards must refuse ${evil}`);
    assert.equal(await projectView(memory, evil), null, `project view must refuse ${evil}`);
    assert.deepEqual(await readLogs(memory, evil), [], `logs must refuse ${evil}`);
  }

  // and the legitimate name still works
  assert.ok(await projectView(memory, "atlas"), "a real project still resolves");

  await drop(dir);
});

test("a search page stays readable when the memory is real-sized", async () => {
  // Measured against a memory matching the author's actual vault — 280 logs,
  // 1.9 MB, one 347 KB session. A common word matched 14,160 lines and the
  // portal rendered every one: a 4.4 MB HTML page. The server was never the
  // bottleneck at 116ms; the browser was.
  //
  // Breadth before depth, as the CLI already did: cap each session first, so one
  // thorough log cannot crowd out every other session that discussed the same
  // thing.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "nacre-scale-")));
  await mkdir(join(dir, "ledger", "devs", "dana"), { recursive: true });
  await writeFile(join(dir, "ledger", "_project.md"), "---\nproject: ledger\nrepos: [ledger-api]\n---\n");
  for (let i = 0; i < 60; i++) {
    const lines = Array.from({ length: 40 }, (_, k) => `* **Note ${k}:** the rollout touched both repos`).join("\n");
    await writeFile(
      join(dir, "ledger", "devs", "dana", `ledger-2025-01-01_${String(i).padStart(2, "0")}-00-00.md`),
      `---\nproject: ledger\nwho: dana\ndate: 2025-01-01\n---\n\n# Session ${i}\n\n* **High-Level Summary:** rollout ${i}\n${lines}\n`,
    );
  }

  const { serve } = await import("../src/serve.js");
  const { server, url } = await serve({ memory: dir, port: 0 });
  try {
    const page = await fetch(`${url}/search?q=rollout&all=1`).then((r) => r.text());
    const rows = (page.match(/<tr>/g) ?? []).length;

    assert.ok(rows <= 200, `a search page must stay bounded, got ${rows} rows`);
    assert.ok(page.length < 400_000, `page was ${(page.length / 1024).toFixed(0)}kb — too heavy to render`);
    // Bounded is not the same as honest: a list that stops without saying so
    // reads as the whole answer.
    assert.match(page, /showing \d+ of \d+/i, "it must say what it dropped");
    assert.match(page, /per session/, "and why");
  } finally {
    server.close();
  }
  await drop(dir);
});

test("the palette ships every navigable target, so typing costs no round trip", async () => {
  // ⌘K opens a palette that filters projects, people, months and the company
  // documents. It answers from a list embedded in the page rather than asking
  // the server, which is why it can respond on every keystroke — and why the
  // list has to actually be complete.
  const dir = await fixture();
  const { serve } = await import("../src/serve.js");
  const { server, url } = await serve({ memory: dir, port: 0 });
  try {
    const page = await fetch(`${url}/p/atlas`).then((r) => r.text());
    const raw = page.match(/<script type="application\/json" id="paldata">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(raw, "the page must embed the palette corpus");

    const rows = JSON.parse(raw as string) as { t: string; g: string; h: string }[];
    const groups = new Set(rows.map((r) => r.g));
    for (const g of ["company", "project", "person", "month"]) {
      assert.ok(groups.has(g), `the palette must offer ${g} targets`);
    }
    // Every row has somewhere to go, and nothing points outside the portal.
    for (const r of rows) {
      assert.match(r.h, /^\//, `${r.t} must link within the portal`);
      assert.ok(r.t.length > 0, "every target needs a label");
    }
    // The corpus is data in a script tag; a stray "<" would end it early.
    assert.doesNotMatch(raw as string, /<\/script/i, "the corpus must not be able to close its own tag");

    assert.match(page, /id="pal"/, "and the overlay itself must be present");
    assert.match(page, /data-side-tgl/, "as must the sidebar toggle it sits beside");
  } finally {
    server.close();
  }
  await drop(dir);
});

test("the browser script is valid JavaScript, which the compiler cannot check", async () => {
  // The client script lives in a template literal, so tsc never looks inside it.
  // A backtick in a code comment — `var` hoists — closed the string, the build
  // passed, and the portal failed to start. The same shape as the apostrophe
  // that closed a shell string in a workflow earlier: prose inside a quoted
  // block is where this hides.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(join(import.meta.dirname, "..", "..", "src", "serve.ts"), "utf8");
  const block = src.match(/const CLIENT_JS = String\.raw`([\s\S]*?)`;/);
  assert.ok(block, "the client script must be findable");
  const js = block[1] as string;

  assert.equal((js.match(/`/g) ?? []).length, 0, "a backtick would close the template literal early");
  assert.doesNotMatch(js, /\$\{/, "an unescaped ${ would interpolate into the script");

  // And it has to actually parse. Function() compiles without executing.
  assert.doesNotThrow(() => new Function(js), "the client script must be syntactically valid");
});

test("the CLI search caps are env-tunable and a bad value falls back", async () => {
  // The caps live in the CLI adapter, not the engine, so they are exercised
  // through the built binary. Four logs with four matching lines each is
  // sixteen hits; the default per-session cap of two shows eight and must say
  // the other eight are hidden and how to see them. Raising the cap past the
  // count removes the notice, and a zero or negative value must fall back to
  // the default rather than truncate to nothing or throw.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const bin = fileURLToPath(new URL("../bin/nacre.js", import.meta.url));

  const dir = await realpath(await mkdtemp(join(tmpdir(), "nacre-cap-")));
  await writeFile(join(dir, "_company.md"), "---\ntype: nacre-company\n---\n\nnothing to match here\n");
  await mkdir(join(dir, "atlas", "devs", "alice"), { recursive: true });
  await writeFile(join(dir, "atlas", "_project.md"),
    "---\nproject: atlas\nrepos: [atlas-api]\nteams: [devs]\n---\n\n# Atlas\n");
  for (let i = 0; i < 4; i++) {
    await writeFile(
      join(dir, "atlas", "devs", "alice", `atlas-2026-08-0${i + 1}_10-00-00.md`),
      `---\nproject: atlas\nwho: alice\n---\n\n## Summary\n\n`
        + `widget one\nwidget two\nwidget three\nwidget four\n`,
    );
  }
  const search = (env: NodeJS.ProcessEnv) =>
    run(process.execPath, [bin, "search", "widget", "--memory", dir, "--all"], { env: { ...process.env, ...env } })
      .then((r) => r.stdout);

  try {
    const def = await search({});
    assert.match(def, /hits\[16\]/, "all sixteen matches are counted");
    assert.match(def, /8 hidden/, "the default cap hides eight and says so");
    assert.match(def, /NACRE_SEARCH_PER_SESSION/, "the notice names the knob to raise");

    const raised = await search({ NACRE_SEARCH_PER_SESSION: "9", NACRE_SEARCH_LIMIT: "40" });
    assert.doesNotMatch(raised, /hidden/, "raising the caps past the count shows everything");

    const bad = await search({ NACRE_SEARCH_PER_SESSION: "0", NACRE_SEARCH_LIMIT: "-3" });
    assert.match(bad, /hits\[16\]/, "a bad cap must not crash or empty the result");
    assert.match(bad, /8 hidden/, "a bad cap falls back to the default of two per session");
  } finally {
    await drop(dir);
  }
});

test("readLogs interleaves three developers' logs by time, not by folder", async () => {
  // Logs live under per-person folders. A reader wants them newest-first across
  // the whole team, so a bob log from Wednesday must sit between two alice logs
  // from Tuesday and Thursday — ordering by stamp, never by which folder holds
  // the file. This is what keeps "what happened last" honest on a shared store.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "nacre-order-")));
  await writeFile(join(dir, "_company.md"), "---\ntype: nacre-company\n---\n\nx\n");
  await mkdir(join(dir, "atlas"), { recursive: true });
  await writeFile(join(dir, "atlas", "_project.md"),
    "---\nproject: atlas\nrepos: [atlas-api]\nteams: [devs]\n---\n\n# Atlas\n");
  const rows: Array<[string, string]> = [
    ["alice", "2026-08-04_09-00-00"],
    ["carol", "2026-08-02_09-00-00"],
    ["bob", "2026-08-03_09-00-00"],
    ["alice", "2026-08-06_09-00-00"],
    ["bob", "2026-08-01_09-00-00"],
  ];
  for (const [who, stamp] of rows) {
    await mkdir(join(dir, "atlas", "devs", who), { recursive: true });
    await writeFile(join(dir, "atlas", "devs", who, `atlas-${stamp}.md`),
      `---\nproject: atlas\nwho: ${who}\n---\n\n## Summary\n\n${who} at ${stamp}.\n`);
  }
  const logs = await readLogs(dir, "atlas");
  assert.deepEqual(
    logs.map((l) => l.stamp),
    ["2026-08-06_09-00-00", "2026-08-04_09-00-00", "2026-08-03_09-00-00", "2026-08-02_09-00-00", "2026-08-01_09-00-00"],
    "logs must sort by time across every author's folder",
  );
  assert.deepEqual(logs.map((l) => l.who), ["alice", "alice", "bob", "carol", "bob"],
    "the author order follows time, not the folder walk");
  await drop(dir);
});

test("the seam graph counts three developers and the repo they share", async () => {
  // Three people on one project, two of them touching the same repo. The graph
  // must show three who-nodes, a repo whose session count is the sum across the
  // developers who touched it, and one cross-repo seam from the single session
  // that named two repos — never one seam per developer.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "nacre-team-graph-")));
  await writeFile(join(dir, "_company.md"), "---\ntype: nacre-company\n---\n\nx\n");
  await mkdir(join(dir, "atlas"), { recursive: true });
  await writeFile(join(dir, "atlas", "_project.md"),
    "---\nproject: atlas\nrepos: [atlas-api, atlas-web]\nteams: [devs]\n---\n\n# Atlas\n");
  const logs: Array<[string, string, string]> = [
    ["alice", "2026-08-01_09-00-00", "[atlas-api]"],
    ["alice", "2026-08-02_09-00-00", "[atlas-api]"],
    ["bob", "2026-08-03_09-00-00", "[atlas-api, atlas-web]"], // the only cross-repo session
    ["carol", "2026-08-04_09-00-00", "[atlas-web]"],
  ];
  for (const [who, stamp, repos] of logs) {
    await mkdir(join(dir, "atlas", "devs", who), { recursive: true });
    await writeFile(join(dir, "atlas", "devs", who, `atlas-${stamp}.md`),
      `---\nproject: atlas\nwho: ${who}\nrepos: ${repos}\n---\n\n## Summary\n\nwork.\n`);
  }
  const g = seamGraph(await readLogs(dir, "atlas"));

  const who = g.nodes.filter((n) => n.kind === "who");
  assert.equal(who.length, 3, "three developers, three nodes");
  assert.equal(g.nodes.find((n) => n.id === "who:alice")?.sessions, 2, "alice wrote two sessions");

  // atlas-api is named by alice (twice) and bob (once): three sessions touched it.
  assert.equal(g.nodes.find((n) => n.id === "repo:atlas-api")?.sessions, 3, "the shared repo sums across developers");
  assert.equal(g.nodes.find((n) => n.id === "repo:atlas-web")?.sessions, 2, "atlas-web: bob and carol");

  // alice's edge to atlas is her session count, not one edge per session.
  const aliceAtlas = g.edges.find((e) => [e.a, e.b].sort().join(" ") === "project:atlas who:alice");
  assert.equal(aliceAtlas?.weight, 2, "the who-project edge weight is sessions");

  const seams = g.edges.filter((e) => e.seam);
  assert.equal(seams.length, 1, "one session named two repos, so one seam");
  assert.equal(g.crossRepo, 1, "cross-repo is counted in sessions, not developers");
  await drop(dir);
});

test("a developer can supersede another developer's log", async () => {
  // Corrections cross authors: bob's later session can retire alice's earlier
  // one. Supersession keys on the log id, not the writer, and the retired log's
  // constraints must both leave the live view and be counted so the absence is
  // announced rather than silent.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "nacre-super-")));
  await writeFile(join(dir, "_company.md"), "---\ntype: nacre-company\n---\n\nx\n");
  await mkdir(join(dir, "atlas", "devs", "alice"), { recursive: true });
  await mkdir(join(dir, "atlas", "devs", "bob"), { recursive: true });
  await writeFile(join(dir, "atlas", "_project.md"),
    "---\nproject: atlas\nrepos: [atlas-api]\nteams: [devs]\n---\n\n# Atlas\n");
  await writeFile(join(dir, "atlas", "devs", "alice", "atlas-2026-08-01_09-00-00.md"),
    "---\nproject: atlas\nwho: alice\n---\n\n## Decided against\n\n* Alice's original call, later found wrong.\n");
  await writeFile(join(dir, "atlas", "devs", "bob", "atlas-2026-08-05_09-00-00.md"),
    "---\nproject: atlas\nwho: bob\nsupersedes: atlas-2026-08-01_09-00-00\n---\n\n## Summary\n\nCorrecting alice's account.\n");

  const v = await projectView(dir, "atlas");
  assert.ok(v, "the project resolves");
  assert.equal(v!.count, 1, "the superseded log is not counted as live");
  assert.equal(v!.superseded, 1, "the retirement is counted");
  assert.ok(!v!.logs.some((l) => l.against.some((a) => /original call/.test(a))),
    "the retired developer's constraint left the live view");
  assert.equal(v!.supersededEntries, 1, "the retired constraint is counted so its absence is announced");
  await drop(dir);
});
