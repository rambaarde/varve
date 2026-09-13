import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { TOOLS, handle } from "../src/mcp.js";
import { brief, searchText } from "../src/brief.js";
import { resolveStoreDir } from "../src/store.js";

/** A memory with two projects, one shared constraint, one decided-against. */
async function memory(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "nacre-mcp-")));
  await writeFile(
    join(dir, "_company.md"),
    `---\ntype: nacre-company\ncompany: Acme\n---\n\n<!-- a comment that must not survive -->\n# Shared Infrastructure\n\n* **Redis:** one instance, shared by atlas and beacon.\n`,
  );
  await mkdir(join(dir, "atlas", "devs", "alice"), { recursive: true });
  await writeFile(
    join(dir, "atlas", "_project.md"),
    `---\nproject: atlas\nrepos: [atlas-api, atlas-web]\nteams: [devs]\n---\n\n# Purpose\n\n* **Purpose:** [What problem this product solves]\n`,
  );
  await writeFile(
    join(dir, "atlas", "devs", "alice", "atlas-2026-08-01_09-14-03.md"),
    `---\nproject: atlas\nwho: alice\nrepos: [atlas-api]\n---\n\n## Summary\n\nRate-limit headers renamed.\n\n## Decided against\n\n* Raising the shared cache eviction limit — starves beacon's workers.\n\n## Open risks\n\n* The old header path still ships in atlas-web.\n\n## Next\n\nRemove the old header path.\n`,
  );
  return dir;
}

const call = (name: string, args: Record<string, unknown> = {}) =>
  handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

const text = (msg: Awaited<ReturnType<typeof handle>>): string =>
  ((msg?.result as { content: { text: string }[] }).content[0]?.text ?? "");

test("initialize echoes a protocol version the client asked for", async () => {
  const r = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
  const result = r?.result as { protocolVersion: string; capabilities: unknown; serverInfo: { name: string } };
  assert.equal(result.protocolVersion, "2024-11-05");
  assert.equal(result.serverInfo.name, "nacre");
  assert.ok(result.capabilities);
});

test("initialize falls back to the latest version it knows", async () => {
  const r = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.equal((r?.result as { protocolVersion: string }).protocolVersion, "2025-06-18");
});

test("notifications are never answered", async () => {
  // Replying to a notification is a protocol violation some clients treat as fatal.
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal(await handle({ jsonrpc: "2.0", id: null, method: "ping" }), null);
});

test("tools/list advertises read-only tools, and nothing that writes", async () => {
  const r = await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = (r?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
  assert.deepEqual(names, ["nacre_brief", "nacre_search"]);
  // The gate that makes publishing safe cannot be enforced from here, so no
  // tool may ever write. This test is the guard on that.
  assert.ok(!names.some((n) => /publish|write|add|init|commit|push/.test(n)));
});

test("every tool advertises a valid schema", () => {
  for (const t of TOOLS) {
    assert.equal(t.inputSchema.type, "object");
    assert.ok(t.description.length > 40, `${t.name} needs a description a model can route on`);
  }
});

test("an unknown method is a JSON-RPC error, not a crash", async () => {
  const r = await handle({ jsonrpc: "2.0", id: 7, method: "tools/nope" });
  assert.equal((r?.error as { code: number }).code, -32601);
  assert.equal(r?.id, 7);
});

test("an unknown tool is rejected", async () => {
  const r = await call("nacre_publish");
  assert.equal((r?.error as { code: number }).code, -32602);
});

test("brief reads company facts, decided-against and risks", async () => {
  const dir = await memory();
  const out = await brief(dir, "atlas");
  assert.match(out, /Redis.*one instance/);
  assert.match(out, /Decided against/);
  assert.match(out, /starves beacon's workers/);
  assert.match(out, /Open risks/);
  assert.match(out, /Handoff/);
  assert.match(out, /alice/);
  assert.match(out, /repos\[2\]/);
});

test("brief drops unfilled template lines and HTML comments", async () => {
  const dir = await memory();
  const out = await brief(dir, "atlas");
  assert.ok(!out.includes("[What problem this product solves]"), "placeholder leaked into the brief");
  assert.ok(!out.includes("must not survive"), "HTML comment leaked into the brief");
});

test("brief surfaces cross-project lessons, ahead of the logs", async () => {
  const dir = await memory();
  await mkdir(join(dir, "_lessons"), { recursive: true });
  await writeFile(
    join(dir, "_lessons", "gui-app-has-no-shell-path.md"),
    `---\ntype: nacre-lesson\ntopic: "gui-app-has-no-shell-path"\n---\n\n# gui-app-has-no-shell-path\n\n## 2026-09-12 \u00b7 mnelia\n\n### Problem\nA macOS GUI app could not find ffmpeg on PATH.\n\n### Solution\nResolve binaries from the common install dirs, not just PATH.\n`,
  );
  const out = await brief(dir, "atlas");
  assert.match(out, /Lessons/);
  assert.match(out, /gui-app-has-no-shell-path/);
  assert.match(out, /could not find ffmpeg/);
  assert.ok(
    out.indexOf("Lessons") < out.indexOf("Decided against"),
    "a cross-project lesson should rank ahead of the logs",
  );
});

test("an unfilled lesson template never leaks into the brief", async () => {
  const dir = await memory();
  await mkdir(join(dir, "_lessons"), { recursive: true });
  await writeFile(
    join(dir, "_lessons", "_lesson-template.md"),
    `---\ntype: nacre-lesson\ntopic: "[Insert kebab-case slug]"\n---\n\n# [Insert slug]\n\n## [Date] \u00b7 [Project]\n\n### Problem\n[symptom]\n\n### Solution\n[fix]\n`,
  );
  const out = await brief(dir, "atlas");
  assert.ok(!out.includes("Insert slug"), "template leaked into the brief");
  assert.ok(!/^## Lessons/m.test(out), "an empty lessons section was rendered");
});

test("brief stays inside its token budget", async () => {
  const dir = await memory();
  await mkdir(join(dir, "atlas", "devs", "bob"), { recursive: true });
  for (let i = 0; i < 60; i++) {
    const day = String((i % 28) + 1).padStart(2, "0");
    await writeFile(
      join(dir, "atlas", "devs", "bob", `atlas-2026-08-${day}_10-00-${String(i).padStart(2, "0")}.md`),
      `---\nproject: atlas\nwho: bob\n---\n\n## Decided against\n\n* ${"a rejected approach ".repeat(40)}\n`,
    );
  }
  const out = await brief(dir, "atlas");
  assert.ok(out.length <= 8_400, `brief was ${out.length} chars`);
  // The guarantee is that the budget holds and the shortfall is announced, not
  // the wording of the notice.
  assert.match(out, /shortened to fit|more characters exist|are NOT shown/);
});

test("constraints shorten before any of them disappears", async () => {
  // 60 long decided-against entries do not fit at full length. The failure worth
  // preventing is not the loss of detail — it is the loss of *existence*: a
  // session cannot `nacre search` for a constraint it was never shown, because
  // it does not know beacon exists. Every entry must still be on the page.
  const dir = await memory();
  await mkdir(join(dir, "atlas", "devs", "bob"), { recursive: true });
  for (let i = 0; i < 60; i++) {
    const day = String((i % 28) + 1).padStart(2, "0");
    await writeFile(
      join(dir, "atlas", "devs", "bob", `atlas-2026-08-${day}_10-00-${String(i).padStart(2, "0")}.md`),
      `---\nproject: atlas\nwho: bob\n---\n\n## Decided against\n\n* ${"a rejected approach ".repeat(40)}\n`,
    );
  }
  const out = await brief(dir, "atlas");

  const bylines = out.match(/— bob, 2026-08-\d\d/g) ?? [];
  assert.equal(bylines.length, 60, `only ${bylines.length} of 60 constraints survived`);
  assert.match(out, /every constraint is listed/);
  assert.match(out, /…/, "a shortened entry must mark where it was cut");
  // Alice's week-one constraint is still whole among them.
  assert.match(out, /starves beacon's workers/);
  assert.ok(out.length <= 8_400, `brief was ${out.length} chars`);
});

test("a long standards file cannot starve the constraints", async () => {
  // The second way the same loss arrives. Ordering decided which section a cut
  // ate; it did not stop the sections *above* the constraints from spending the
  // whole budget first. One oversized _standards.md used to be enough.
  const dir = await memory();
  await writeFile(
    join(dir, "atlas", "_standards.md"),
    `# Atlas standards\n\n${"* every service pins its dependencies exactly and vendors nothing.\n".repeat(300)}`,
  );
  const out = await brief(dir, "atlas");

  assert.match(out, /starves beacon's workers/, "a constraint was starved by the prose above it");
  assert.match(out, /Decided against/);
  assert.match(out, /reserved share/, "the cut must say a constraint was not what went");
  assert.ok(out.length <= 8_400, `brief was ${out.length} chars`);
});

test("supersession says how many constraints it retired", async () => {
  // Superseding replaces the whole log, so a correction to one decision also
  // retires every other constraint that log carried. That is the right default
  // and the wrong silence: an absence nobody is told about is the failure this
  // file exists to prevent, whatever caused it.
  const dir = await memory();
  await writeFile(
    join(dir, "atlas", "devs", "alice", "atlas-2026-08-09_11-00-00.md"),
    "---\nproject: atlas\nwho: alice\nsupersedes: atlas-2026-08-01_09-14-03\n---\n\n" +
      "## Summary\n\nThe header rename shipped; the earlier account of it was wrong.\n",
  );
  const out = await brief(dir, "atlas");

  assert.doesNotMatch(out, /starves beacon's workers/, "a retired log's constraints must not list as live");
  assert.match(out, /2 constraints in superseded logs/);
  assert.match(out, /had to be restated/, "the reader must be told why they are gone");
});

test("an unknown project names the ones that exist", async () => {
  const dir = await memory();
  const out = await brief(dir, "nope");
  assert.match(out, /No project named "nope"/);
  assert.match(out, /atlas/);
});

test("search flags decided-against rows", async () => {
  const dir = await memory();
  const out = await searchText(dir, "cache", { project: "atlas" });
  assert.match(out, /DECIDED AGAINST/);
});

test("search says so when nothing matches, and what to try", async () => {
  const dir = await memory();
  const out = await searchText(dir, "zzzz", { project: "atlas" });
  assert.match(out, /No match/);
  assert.match(out, /next:/);
});

test("a traversing project name is refused", async () => {
  const r = await call("nacre_brief", { project: "../../etc" });
  assert.equal((r?.result as { isError: boolean }).isError, true);
  assert.match(text(r), /Invalid project name/);
});

test("a failure is content the model can read, not a vanished call", async () => {
  // Run somewhere with no .nacre.yml above it and no project given.
  const cwd = process.cwd();
  process.chdir(await realpath(await mkdtemp(join(tmpdir(), "nacre-nowhere-"))));
  try {
    const r = await call("nacre_brief");
    assert.equal((r?.result as { isError: boolean }).isError, true);
    assert.match(text(r), /No project given/);
  } finally {
    process.chdir(cwd);
  }
});

test("one project's brief never carries another project's constraints", async () => {
  // The isolation the skill states as a rule ("Never read another project's
  // tree"). Company files are shared on purpose; a project LOG's decided-against
  // is not, and a brief that leaked beacon's into atlas would hand a session a
  // constraint the team never agreed for the work in front of it.
  const dir = await memory();
  await mkdir(join(dir, "beacon", "devs", "carol"), { recursive: true });
  await writeFile(join(dir, "beacon", "_project.md"),
    "---\nproject: beacon\nrepos: [beacon-api]\nteams: [devs]\n---\n\n# Beacon\n");
  await writeFile(
    join(dir, "beacon", "devs", "carol", "beacon-2026-08-02_10-00-00.md"),
    "---\nproject: beacon\nwho: carol\n---\n\n## Decided against\n\n* Sharding beacon's queue — a beacon-only choice.\n",
  );
  const out = await brief(dir, "atlas");
  assert.doesNotMatch(out, /Sharding beacon's queue/, "a sibling project's decided-against leaked in");
  assert.match(out, /starves beacon's workers/, "atlas's own constraint is still present");
});

test("the handoff section is absent when no live log carries a Next", async () => {
  // handoff = the newest live log with a `## Next`. A project whose logs never
  // wrote one must not sprout an empty `## Handoff` heading — an empty section
  // reads as a handoff that said nothing, which is not the same as no handoff.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "nacre-noh-")));
  await writeFile(join(dir, "_company.md"), "---\ntype: nacre-company\n---\n\nShared nothing.\n");
  await mkdir(join(dir, "atlas", "devs", "alice"), { recursive: true });
  await writeFile(join(dir, "atlas", "_project.md"),
    "---\nproject: atlas\nrepos: [atlas-api]\nteams: [devs]\n---\n\n# Atlas\n");
  await writeFile(join(dir, "atlas", "devs", "alice", "atlas-2026-08-01_09-14-03.md"),
    "---\nproject: atlas\nwho: alice\n---\n\n## Summary\n\nGroundwork, no follow-up named.\n");
  const out = await brief(dir, "atlas");
  assert.doesNotMatch(out, /## Handoff/, "an empty handoff heading appeared");
  assert.match(out, /Groundwork/, "the recent summary is still there");
});

test("a project with a roster but no logs says so, rather than rendering blank", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "nacre-empty-")));
  await writeFile(join(dir, "_company.md"), "---\ntype: nacre-company\n---\n\nShared nothing.\n");
  await mkdir(join(dir, "atlas"), { recursive: true });
  await writeFile(join(dir, "atlas", "_project.md"),
    "---\nproject: atlas\nrepos: [atlas-api]\nteams: [devs]\n---\n\n# Atlas\n");
  const out = await brief(dir, "atlas");
  assert.match(out, /nothing written yet/, "an empty project must announce itself");
});

test("a company-file hit is labelled by its file, not by a blank session row", async () => {
  // A company fact has no date and no author — it belongs to the company, not a
  // session. Rendered in the log shape it opened " ·  · _company", which reads
  // as missing data. The row must name the file instead.
  const dir = await memory();
  const out = await searchText(dir, "Redis", { project: "atlas", all: true });
  assert.match(out, /Redis/, "the company fact is found");
  assert.doesNotMatch(out, /·\s+·\s+_company/, "a company hit rendered as a blank session row");
  assert.match(out, /_company/, "the row still names the source file");
});

test("three developers on one project all appear in one brief, newest handoff wins", async () => {
  // The whole reason a shared memory exists: a fourth developer arriving reads
  // one brief and sees what all three before them decided, not just the last
  // one's. Each decided-against is a different person's, and only the newest
  // Next — regardless of who wrote it — is the live handoff.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "nacre-team-")));
  await writeFile(join(dir, "_company.md"), "---\ntype: nacre-company\n---\n\nOne Redis, shared.\n");
  await mkdir(join(dir, "atlas"), { recursive: true });
  await writeFile(join(dir, "atlas", "_project.md"),
    "---\nproject: atlas\nrepos: [atlas-api, atlas-web]\nteams: [devs]\n---\n\n# Atlas\n");
  // Three sessions, three authors, ascending timestamps. carol's is newest.
  const sessions: Array<[string, string, string, string]> = [
    ["alice", "2026-08-01_09-00-00", "Sharding the queue — one Redis for two products.", "Wire the new header path."],
    ["bob", "2026-08-03_11-00-00", "A second cache tier — the shared instance already caps us.", "Delete the legacy header reader."],
    ["carol", "2026-08-06_14-30-00", "Rewriting the poller in a new language mid-quarter.", "Land the poller refactor behind a flag."],
  ];
  for (const [who, stamp, against, next] of sessions) {
    await mkdir(join(dir, "atlas", "devs", who), { recursive: true });
    await writeFile(join(dir, "atlas", "devs", who, `atlas-${stamp}.md`),
      `---\nproject: atlas\nwho: ${who}\nrepos: [atlas-api]\n---\n\n## Summary\n\n${who} worked.\n\n`
        + `## Decided against\n\n* ${against}\n\n## Next\n\n${next}\n`);
  }
  const out = await brief(dir, "atlas");
  // Every developer's decision is present, none crowded out by another.
  assert.match(out, /Sharding the queue/, "alice's decision is missing");
  assert.match(out, /A second cache tier/, "bob's decision is missing");
  assert.match(out, /Rewriting the poller/, "carol's decision is missing");
  // The handoff is the newest session's, whoever wrote it — not the first read.
  assert.match(out, /## Handoff\n\nLand the poller refactor behind a flag/, "the newest handoff must win");
  assert.doesNotMatch(out, /## Handoff\n\nWire the new header path/, "an older handoff shadowed the newest");
});

test("the server speaks JSON-RPC on stdio and writes nothing else", async () => {
  // The real failure this guards: one stray console.log corrupts the stream and
  // the client reports a parse error instead of the line that caused it.
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ];
  // spawn, not execFile: promisified execFile has no `input` option (that is
  // execFileSync), so the child's stdin never closes, the read loop never ends,
  // and the test hangs rather than fails.
  const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/nacre.js", import.meta.url)), "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d: string) => (stdout += d));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => (stderr += d));
  child.stdin.end(`${requests.map((r) => JSON.stringify(r)).join("\n")}\n`);

  const code: number | null = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
    setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`mcp did not exit when stdin closed. stdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 15_000).unref();
  });
  assert.equal(code, 0, `exited ${code}. stderr:\n${stderr}`);

  const lines = stdout.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 2, `expected 2 replies, got ${lines.length}:\n${stdout}`);
  const parsed = lines.map((l) => JSON.parse(l) as { id: number; jsonrpc: string; result: { tools: unknown[] } });
  assert.deepEqual(parsed.map((p) => p.id), [1, 2]);
  assert.ok(parsed.every((p) => p.jsonrpc === "2.0"));
  assert.equal(parsed[1]?.result.tools.length, 2);
});

test("a company-wide hit names its file rather than an empty date and author", async () => {
  const dir = await memory();
  const out = await searchText(dir, "Redis", { all: true });
  assert.match(out, /_company\.md/);
  assert.ok(!/^\s*·\s+·/m.test(out), `row rendered with empty date/who:\n${out}`);
});

test("a local memory path in .nacre.yml is used directly, not re-derived", async () => {
  // The failure this guards: resolution derived ~/<name> from the path's last
  // segment and tried to clone into it, reporting "no projects yet" while
  // pointing at a directory full of them. Every store without a remote hit it.
  const dir = await memory();
  const resolved = await resolveStoreDir(undefined, dir);
  assert.equal(resolved, dir);
});

test("a remote URL still resolves under home, not as a local path", async () => {
  const resolved = await resolveStoreDir(undefined, "git@github.com:acme/acme-context.git");
  assert.equal(basename(resolved), "acme-context", resolved);
  assert.ok(!resolved.startsWith("git@"), resolved);
});

test("a week-one constraint survives twenty newer logs", async () => {
  // The failure a recency window causes, and the reason it matters *during* a
  // two-person pilot rather than after one: two devs over two weeks pass fifteen
  // logs in days. Under a fixed window the oldest constraint stops loading — not
  // ranked lower, gone — while the session still reports it loaded team context.
  // A teammate silently missing week one's constraint reads as "they didn't find
  // it useful", and the pilot gets misread.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "nacre-window-")));
  await mkdir(join(dir, "atlas", "devs", "alice"), { recursive: true });
  await writeFile(join(dir, "atlas", "_project.md"),
    "---\nproject: atlas\nrepos: [atlas-api]\nteams: [devs]\n---\n\n# Atlas\n");

  await writeFile(join(dir, "atlas", "devs", "alice", "atlas-2026-08-01_09-00-00.md"),
    "---\nproject: atlas\nwho: alice\n---\n\n## Decided against\n\n* Raising the shared cache limit — it starves beacon's workers.\n");

  await mkdir(join(dir, "atlas", "devs", "bob"), { recursive: true });
  for (let i = 0; i < 20; i++) {
    const day = String(2 + (i % 26)).padStart(2, "0");
    await writeFile(
      join(dir, "atlas", "devs", "bob", `atlas-2026-09-${day}_10-${String(i).padStart(2, "0")}-00.md`),
      `---\nproject: atlas\nwho: bob\n---\n\n## Summary\n\nRoutine session ${i}.\n`,
    );
  }

  const out = await brief(dir, "atlas");
  assert.match(out, /starves beacon's workers/, "the oldest constraint must still load");
  assert.match(out, /Decided against/);
});

test("past the floor it drops the newest, keeps the oldest, and says so", async () => {
  // Eighty heavy constraints do not fit even as stubs, so something has to go.
  // Which end goes is the whole argument: age is the one axis a constraint's
  // truth does not depend on, and the oldest are the ones no recent summary
  // repeats and nobody remembers. Cutting the tail — the default a length cap
  // gives you free — drops exactly those, which is the bug a recency window had.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "nacre-cut-")));
  await mkdir(join(dir, "atlas", "devs", "bob"), { recursive: true });
  await writeFile(join(dir, "atlas", "_project.md"),
    "---\nproject: atlas\nrepos: [atlas-api]\nteams: [devs]\n---\n\n# Atlas\n");
  for (let i = 0; i < 80; i++) {
    const month = String(6 + Math.floor(i / 28)).padStart(2, "0");
    const day = String((i % 28) + 1).padStart(2, "0");
    // The marker leads, so it survives being shortened to a stub.
    const mark = i === 0 ? "OLDEST" : i === 79 ? "NEWEST" : `entry-${i}`;
    await writeFile(
      join(dir, "atlas", "devs", "bob", `atlas-2026-${month}-${day}_10-00-00.md`),
      `---\nproject: atlas\nwho: bob\n---\n\n## Decided against\n\n* ${mark} ${"a rejected approach ".repeat(30)}\n`,
    );
  }
  const out = await brief(dir, "atlas");

  assert.match(out, /OLDEST/, "the oldest constraint is the one that must survive");
  assert.doesNotMatch(out, /NEWEST/, "the newest is what a full brief gives up first");
  assert.match(out, /are NOT shown/, "a drop this size must be stated, not implied");
  assert.match(out, /nacre search/);
  assert.ok(out.length <= 8_400, `brief was ${out.length} chars`);
});

test("a section written as one long paragraph is not reduced to its heading", async () => {
  // cap() backed up to the last newline unconditionally. Markdown paragraphs are
  // routinely a single line, so a long _standards.md rendered as its heading and
  // nothing else — the newline it retreated to was the one after the heading.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "nacre-oneline-")));
  await writeFile(join(dir, "_company.md"), "---\ntype: nacre-company\n---\n\n# Snapshot\n\nWe ship on Fridays.\n");
  await writeFile(
    join(dir, "_standards.md"),
    `---\ntype: nacre-standards\n---\n\n# Standards\n\nMARKER ${"every rule on one line ".repeat(500)}\n`,
  );
  await mkdir(join(dir, "atlas", "devs", "bob"), { recursive: true });
  await writeFile(join(dir, "atlas", "_project.md"),
    "---\nproject: atlas\nrepos: [atlas-api]\nteams: [devs]\n---\n\n# Atlas\n");

  const out = await brief(dir, "atlas");
  assert.match(out, /MARKER every rule on one line/, "the body must survive, not just the heading");
  assert.ok(out.length <= 8_000, `brief was ${out.length} chars`);
});

test("a log with no summary section does not report a heading as its summary", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "nacre-nosum-")));
  await mkdir(join(dir, "atlas", "devs", "bob"), { recursive: true });
  await writeFile(join(dir, "atlas", "_project.md"),
    "---\nproject: atlas\nrepos: [atlas-api]\nteams: [devs]\n---\n\n# Atlas\n");
  await writeFile(join(dir, "atlas", "devs", "bob", "atlas-2026-09-01_10-00-00.md"),
    "---\nproject: atlas\nwho: bob\n---\n\n## Decided against\n\n* Reverting to 401.\n");

  const out = await brief(dir, "atlas");
  const recent = out.slice(out.indexOf("## Recent sessions"));
  assert.ok(!/—\s*#/.test(recent), `a heading leaked in as a summary:\n${recent}`);
  assert.match(recent, /Reverting to 401/);
});
