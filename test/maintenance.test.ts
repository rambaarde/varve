import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { lint, sleep } from "../src/maintenance.js";

async function store(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "nacre-maint-")));
  await writeFile(
    join(dir, "_company.md"),
    `---\ntype: nacre-company\ncompany: Acme\n---\n\n# Snapshot\n\n* **What we build:** invoicing.\n`,
  );
  await mkdir(join(dir, "atlas", "devs", "alice"), { recursive: true });
  await writeFile(
    join(dir, "atlas", "_project.md"),
    `---\nproject: atlas\nrepos: [atlas-api]\nteams: [devs]\n---\n\n# Purpose\n\n* **Purpose:** invoice sync.\n`,
  );
  await writeFile(
    join(dir, "atlas", "devs", "alice", "atlas-2026-08-01_09-14-03.md"),
    `---\nproject: atlas\nwho: alice\nrepos: [atlas-api]\n---\n\n## Summary\n\nDid a thing.\n`,
  );
  return dir;
}

test("lint is clean on a filled store", async () => {
  assert.deepEqual(await lint(await store()), []);
});

test("lint flags an unfilled lesson and a who/folder mismatch", async () => {
  const dir = await store();
  await mkdir(join(dir, "_lessons"), { recursive: true });
  await writeFile(
    join(dir, "_lessons", "stub.md"),
    `---\ntype: nacre-lesson\ntopic: "stub"\n---\n\n# stub\n\n## 2026-09-12 · atlas\n\n### Problem\n[symptom]\n\n### Solution\n[fix]\n`,
  );
  await writeFile(
    join(dir, "atlas", "devs", "alice", "atlas-2026-08-02_09-14-03.md"),
    `---\nproject: atlas\nwho: bob\n---\n\n## Summary\n\nMismatch.\n`,
  );
  const findings = await lint(dir);
  assert.ok(findings.some((f) => f.file === "_lessons/stub.md"), "unfilled lesson not flagged");
  assert.ok(findings.some((f) => /split in two/.test(f.message)), "who/folder mismatch not flagged");
});

test("sleep runs lint and flags nothing to consolidate on a small store", async () => {
  const r = await sleep(await store());
  assert.deepEqual(r.consolidation, []);
  assert.ok(Array.isArray(r.findings));
});
