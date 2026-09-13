/**
 * Store hygiene and the bedtime pass — nacre's take on create-ai-memory's
 * `ai-mem-lint` and `ai-mem-sleep`.
 *
 * `lint` reports what has rotted: templates left unfilled, lessons with no
 * failure→fix, logs whose `who:` disagrees with the folder they live in (the
 * split-identity bug the publish skill warns about).
 *
 * `sleep` is the bedtime pass: it runs the lint and flags projects whose logs
 * have grown enough to be worth consolidating. It deliberately does NOT archive
 * or delete anything. create-ai-memory can archive old logs because its durable
 * layer is `_lessons/`; nacre's durable layer is the logs themselves — the
 * brief surfaces every decided-against and open risk from every log, forever —
 * so moving a log out of the tree would silently drop it from recall. Decay in
 * nacre is a consolidation the human approves, never a sweep that runs itself.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { exists, listProjects, frontmatter } from "./store.js";
import { readLogs } from "./portal.js";

export interface Finding {
  level: "warn" | "info";
  file: string;
  message: string;
}

/** Placeholder markers a template leaves behind when nobody fills it in. */
const PLACEHOLDER = /\[(?:Insert|What|One line|Deploy|Area|Who|Date|Project|symptom|fix)\b[^\]]*\]/i;

/** True when a lesson body carries a real Problem AND Solution (not the stub). */
function lessonIsFilled(text: string): boolean {
  const grab = (h: string): string => {
    const m = new RegExp(`^###\\s+${h}\\s*\\n([\\s\\S]*?)(?=\\n###\\s|\\n##\\s|$)`, "m").exec(text);
    return (m?.[1] ?? "").trim();
  };
  const p = grab("Problem");
  const s = grab("Solution");
  return !!p && !!s && !PLACEHOLDER.test(p) && !PLACEHOLDER.test(s);
}

/**
 * Report store hygiene issues. Never writes. The checks mirror the failures the
 * brief and the publish skill already guard against, surfaced in one place so a
 * maintainer can fix them before a teammate reads a half-filled brief.
 */
export async function lint(memory: string): Promise<Finding[]> {
  const out: Finding[] = [];

  // 1. Always-loaded company files left as templates.
  for (const name of ["_company.md", "_standards.md"]) {
    const file = join(memory, name);
    if ((await exists(file)) && PLACEHOLDER.test(await readFile(file, "utf8"))) {
      out.push({ level: "warn", file: name, message: "still has unfilled template placeholders" });
    }
  }

  // 2. Per-project files + profiles left as templates.
  for (const project of await listProjects(memory)) {
    for (const rel of [join(project, "_project.md"), join(project, "_standards.md")]) {
      const file = join(memory, rel);
      if ((await exists(file)) && PLACEHOLDER.test(await readFile(file, "utf8"))) {
        out.push({ level: "warn", file: rel, message: "unfilled template" });
      }
    }
  }

  // 3. Lessons that never got a real Problem/Solution.
  const lessonsDir = join(memory, "_lessons");
  if (await exists(lessonsDir)) {
    for (const name of await readdir(lessonsDir)) {
      if (!name.endsWith(".md") || name.startsWith("_")) continue;
      const text = await readFile(join(lessonsDir, name), "utf8");
      if (!lessonIsFilled(text)) {
        out.push({ level: "warn", file: `_lessons/${name}`, message: "a lesson with no Problem/Solution" });
      }
    }
  }

  // 4. Logs whose `who:` disagrees with the folder — the split-identity bug.
  for (const log of await readLogs(memory)) {
    const declared = frontmatter(await readFile(log.path, "utf8")).who;
    if (typeof declared === "string" && declared && declared !== log.who) {
      out.push({
        level: "warn",
        file: log.rel,
        message: `who: "${declared}" but the log lives under "${log.who}" — one person, split in two`,
      });
    }
  }

  return out;
}

export interface Consolidation {
  project: string;
  logs: number;
}

export interface SleepReport {
  findings: Finding[];
  consolidation: Consolidation[];
}

/** How many logs a project can hold before it is worth consolidating. */
export const CONSOLIDATE_THRESHOLD = 30;

/**
 * The bedtime pass: lint, then flag projects grown large enough to consolidate.
 * Reports only — it never moves or deletes a log (see the module note).
 */
export async function sleep(memory: string): Promise<SleepReport> {
  const findings = await lint(memory);
  const counts = new Map<string, number>();
  for (const log of await readLogs(memory)) {
    counts.set(log.project, (counts.get(log.project) ?? 0) + 1);
  }
  const consolidation = [...counts.entries()]
    .filter(([, n]) => n >= CONSOLIDATE_THRESHOLD)
    .map(([project, logs]) => ({ project, logs }))
    .sort((a, b) => b.logs - a.logs);
  return { findings, consolidation };
}
