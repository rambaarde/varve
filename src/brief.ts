/**
 * The briefing — what a session needs to know before it writes a line.
 *
 * Lives apart from any one door because three of them now read it: `nacre brief`
 * in a terminal, the MCP server, and the skills that quote it. One composer means
 * an agent and a person cannot be told different things about the same project.
 *
 * The order is the one nacre-load uses: urgency of not knowing, not recency.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { exists, listProjects, frontmatter } from "./store.js";
import { age, projectStandards, projectView, search, unfilled } from "./portal.js";
import type { Log } from "./portal.js";

/**
 * Ceilings, in characters, at roughly four characters to the token.
 *
 * A brief that blows the context it was meant to save is worse than no brief,
 * and a caller cannot re-ask for less.
 */
const BRIEF_CHARS = 8_000; // ~2,000 tokens
const SEARCH_CHARS = 2_000; // ~500 tokens

/**
 * The share of the brief that constraints may always claim.
 *
 * Ordering alone was not enough. Everything above the constraints — company
 * files, project standards, the curated note, a handoff — is written once and
 * then only grows, and one long `_standards.md` can spend the whole budget
 * before the first decided-against is reached. That is the loss a recency window
 * caused, arriving from the other side: not too many logs, too much prose above
 * them. The floor is only claimed when constraints actually need it, so a
 * project with three of them still renders its standards in full.
 */
const CONSTRAINT_FLOOR = 4_000;

/** Below this an entry is no longer a recognisable thought, only noise. */
const MIN_ENTRY = 90;

/** What a cut in the brief can never have taken, said where the cut happened. */
const NOT_A_CONSTRAINT =
  "Decided-against and open risks hold a reserved share of this brief, so a cut " +
  "never removes one. ";

/** Trim to a ceiling on a line boundary, and say so rather than ending mid-word. */
function cap(text: string, limit: number, note = ""): string {
  if (text.length <= limit) return text;
  // Name what is missing. A brief that quietly ends is indistinguishable from a
  // project with nothing more to say, which is the failure this whole file is
  // arranged to avoid.
  //
  // The notice is counted against the limit rather than added after it. Appended
  // afterwards it made cap() return ~200 characters more than it was given —
  // which the caller had already promised to the constraints, so the section
  // with a reserved floor was the one the overrun spent.
  const notice = (missing: number) =>
    `\n\n[cut here to fit the budget — ${missing} more characters exist. ` +
    `${note}\`nacre search <term>\` reads the rest.]`;
  const room = Math.max(0, limit - notice(text.length).length);
  const cut = text.slice(0, room);

  // Prefer a line break, then a word break, then take the room as given.
  //
  // Backing up to the last newline unconditionally destroyed any section
  // written as one long paragraph — and markdown paragraphs are routinely a
  // single line. A 9,000-character `_standards.md` rendered as its heading and
  // nothing else: the newline it retreated to was the one after the heading.
  // Losing a few words at the edge is a rounding error; losing the section is
  // the failure this file exists to prevent.
  const half = room / 2;
  const nl = cut.lastIndexOf("\n");
  const sp = cut.lastIndexOf(" ");
  const edge = nl > half ? nl : sp > half ? sp : room;
  const kept = cut.slice(0, edge).trimEnd();
  return kept + notice(text.length - kept.length);
}

interface Entry {
  text: string;
  who: string;
  date: string;
}

const entryLine = (e: Entry, width?: number): string => {
  const body = width !== undefined && e.text.length > width ? `${e.text.slice(0, width).trimEnd()}…` : e.text;
  return `- ${body}  \n  — ${e.who}, ${e.date}`;
};

/**
 * Fit constraints into a budget by shortening entries, not by dropping them.
 *
 * A dropped constraint is invisible, and `nacre search` is no remedy for it: a
 * session cannot search for a fact it was never shown. It does not know beacon
 * exists. A shortened one still carries its subject, its author and its date —
 * enough to know the constraint is there and to go read the rest. Losing detail
 * is recoverable. Losing existence is not, and it fails in the direction that
 * looks like nothing went wrong.
 *
 * Only when even stubs will not fit does anything get dropped, and then it is
 * the newest that go. A constraint is not less true for being old; the old ones
 * are the ones nobody remembers and no recent summary repeats, which is the
 * whole reason they are worth carrying. The count is always named.
 */
function fitEntries(entries: Entry[], limit: number): string {
  const full = entries.map((e) => entryLine(e)).join("\n");
  if (!entries.length || full.length <= limit) return full;

  // Both notices are counted against the budget before anything is rendered, not
  // appended to a section already sized to fill it. Added afterwards they pushed
  // the section past its share, and the backstop cap() then trimmed the tail —
  // silently costing the last constraint, which is the exact loss this function
  // exists to prevent.
  const shrunkNote = (n: number) =>
    `\n\n[every constraint is listed; ${n} shortened to fit — “…” marks a cut. ` +
    "`nacre search <term>` reads one in full.]";

  // What each entry costs before a character of its text: bullet, wrap, byline,
  // the newline between rows, and the ellipsis a shortened one carries.
  const fixed = entries.reduce((n, e) => n + entryLine({ ...e, text: "" }).length + 2, 0);
  const share = Math.floor((limit - shrunkNote(entries.length).length - fixed) / entries.length);

  // Everything fits once shortened — the ordinary case, and the one worth
  // keeping ordinary. `share` may fall under the floor and still leave room for
  // every entry at MIN_ENTRY, so squeezing is tried before anything is dropped.
  const atFloor = fixed + entries.length * MIN_ENTRY + shrunkNote(entries.length).length;
  if (share >= MIN_ENTRY || atFloor <= limit) {
    // Entries under their share hand the slack back, so a run of short
    // constraints does not force a long one to be cut to the same width.
    const base = Math.max(share, MIN_ENTRY);
    const spare = entries.reduce((n, e) => n + Math.max(0, base - e.text.length), 0);
    const over = entries.filter((e) => e.text.length > base).length;
    const width = base + (over ? Math.floor(spare / over) : 0);
    const shortened = entries.filter((e) => e.text.length > width).length;
    return entries.map((e) => entryLine(e, width)).join("\n") + shrunkNote(shortened);
  }

  // The floor is spent. Keep the oldest that fit — `entries` arrives newest
  // first, so that is the tail — and say plainly what is not here.
  const droppedNote = (n: number, span: string) =>
    `\n\n[${n} newer entries${span} are NOT shown — the oldest are kept because ` +
    "no recent summary repeats them. This project has outgrown one brief: " +
    "`nacre search <term>`, and consider superseding what no longer holds.]";

  const perEntry = Math.ceil(fixed / entries.length) + MIN_ENTRY;
  const keep = Math.max(1, Math.floor((limit - droppedNote(entries.length, " from A to B").length) / perEntry));
  const kept = entries.slice(-keep);
  const dropped = entries.slice(0, Math.max(0, entries.length - keep));
  const dates = dropped.map((d) => d.date).filter(Boolean).sort();
  const span = dates.length ? ` from ${dates[0]} to ${dates[dates.length - 1]}` : "";
  return kept.map((e) => entryLine(e, MIN_ENTRY)).join("\n") + droppedNote(dropped.length, span);
}

/** Strip frontmatter and HTML comments, then drop unfilled template lines. */
function curated(text: string): string {
  return unfilled(
    text
      .replace(/^(?:\s|<!--[\s\S]*?-->)*---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .trim(),
  );
}

/** A lesson's title and its newest dated Problem→Fix, condensed for the brief. */
function lessonGist(name: string, text: string): string | null {
  const fm = frontmatter(text);
  const topic = typeof fm.topic === "string" ? fm.topic : "";
  const title =
    (topic && !topic.startsWith("[") ? topic : /^#\s+(.+)$/m.exec(text)?.[1]) ||
    name.replace(/\.md$/, "");
  // Dated entries are "## <date> · <project>" blocks; the newest is last.
  const blocks = text.split(/^##\s+/m).slice(1);
  const last = blocks[blocks.length - 1] || "";
  const grab = (h: string): string => {
    const m = new RegExp(`^###\\s+${h}\\s*\\n([\\s\\S]*?)(?=\\n###\\s|$)`, "m").exec(last);
    return (m?.[1] ?? "").trim().replace(/\s+/g, " ");
  };
  const problem = grab("Problem");
  const solution = grab("Solution");
  if (!problem && !solution) return null; // unfilled template or malformed
  const gist = [problem && `**Problem:** ${problem}`, solution && `**Fix:** ${solution}`]
    .filter(Boolean)
    .join("  ");
  return `- **${title}** — ${gist}`;
}

/**
 * Cross-project lessons (`_lessons/*.md`): failure→fix knowledge that outlives
 * any one project. Surfaced in every brief, high and ahead of the logs — the
 * sharpest "urgency of not knowing" is a mistake the company already paid for
 * once. Files whose name starts with `_` (the template) are skipped.
 */
async function companyLessons(memory: string): Promise<string[]> {
  const dir = join(memory, "_lessons");
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".md") && !n.startsWith("_"));
  } catch {
    return []; // no lessons folder yet — nothing to say
  }
  const items: string[] = [];
  for (const name of names.sort()) {
    const gist = lessonGist(name, await readFile(join(dir, name), "utf8"));
    if (gist) items.push(gist);
  }
  return items.length ? [`## Lessons — learned across projects\n\n${items.join("\n")}`] : [];
}

async function companyFiles(memory: string): Promise<string[]> {
  const out: string[] = [];
  for (const [name, heading] of [
    ["_company.md", "Company"],
    ["_standards.md", "Standards"],
  ] as const) {
    const file = join(memory, name);
    if (!(await exists(file))) continue;
    const body = curated(await readFile(file, "utf8"));
    // An unfilled template is not content. Saying nothing is honest; printing
    // twenty lines of square brackets reads as a filled-in file that says
    // nothing useful, which is worse than an absence the reader can act on.
    if (body) out.push(`## ${heading}\n\n${body}`);
  }
  return out;
}

/**
 * The briefing, in the order `nacre-load` reads it: urgency of not knowing,
 * not recency.
 */
export async function brief(memory: string, project: string): Promise<string> {
  const view = await projectView(memory, project);
  if (!view) {
    const known = await listProjects(memory);
    return known.length
      ? `No project named "${project}" in this memory.\nprojects: ${known.join(", ")}`
      : `No project named "${project}", and this memory has no projects yet.\nnext: nacre add <project> <repo-dir>`;
  }

  const head = [
    `memory: ${memory} · pulled ${await age(memory)}`,
    `project: ${view.project} · repos[${view.repos.length}]: ${view.repos.join(", ") || "none"} · logs: ${view.count}`,
  ];
  // A stale clone reads stale memory silently. That is this design's one quiet
  // failure, so the age goes at the top where it cannot be missed.

  // Orientation: written once, then only grows. It still goes first, but it no
  // longer gets to spend the constraints' share on the way past.
  const preamble: string[] = [head.join("\n")];
  preamble.push(...(await companyFiles(memory)));
  preamble.push(...(await companyLessons(memory)));

  const standards = await projectStandards(memory, project);
  if (standards) {
    const body = curated(standards);
    if (body) preamble.push(`## Standards — ${project}\n\n${body}\n\nWhere these disagree with company standards, these are the specific ones and win.`);
  }

  if (view.note) preamble.push(`## ${view.project}\n\n${view.note}`);

  if (view.handoff) {
    const by = view.handoffBy;
    preamble.push(`## Handoff\n\n${view.handoff}${by ? `\n\n— ${by.who}, ${by.date}` : ""}`);
  }

  // EVERY decided-against and every open risk, not a recency window.
  //
  // This used to read the newest 15 logs. A constraint is not less true for
  // being old — and under a fixed window one stops loading the moment fifteen
  // newer logs exist. Not ranked lower: gone, silently, while the session still
  // reports that it loaded the team's context. Two developers over two weeks
  // pass fifteen logs easily, so the entry a teammate most needed to see is
  // exactly the one a window drops first.
  //
  // Ordering fixed which section is cut. It did not fix the axis: cap() trims
  // the end, entries arrive newest first, so the oldest still went first — the
  // same entries the window dropped, in the same order, at a higher threshold.
  // Age is the one axis a constraint's truth does not depend on. So constraints
  // get a floor of their own, and inside it they degrade by shortening rather
  // than by disappearing.
  const entries = (pick: (l: Log) => string[]): Entry[] =>
    view.logs.flatMap((l) => pick(l).map((text) => ({ text, who: l.who, date: l.date })));
  const against = entries((l) => l.against);
  const risks = entries((l) => l.risks);

  // Sections are costed whole — heading and the blank line that joins them —
  // because a floor that forgets its own headings hands back a budget the
  // section cannot actually be written into.
  const sections = [
    { head: "## Decided against\n\n", es: against },
    { head: "## Open risks\n\n", es: risks },
  ]
    .filter((s) => s.es.length)
    .map((s) => ({ ...s, cost: s.head.length + fitEntries(s.es, Infinity).length + 2 }));

  const wanted = sections.reduce((n, s) => n + s.cost, 0);
  const reserved = Math.min(CONSTRAINT_FLOOR, wanted);

  const parts: string[] = [cap(preamble.join("\n\n"), BRIEF_CHARS - reserved, NOT_A_CONSTRAINT)];
  // Whatever the preamble did not use is theirs too — the floor is a guarantee,
  // not a ceiling, so a project with room renders every constraint in full.
  let left = BRIEF_CHARS - (parts[0] as string).length;

  // Smallest section first, each taking what it needs up to an even split of what
  // is left. Splitting the room in proportion to size instead gave a one-line
  // Open risks a share of fifteen characters — less than the notice explaining
  // the shortfall — so the section overran its own budget and the backstop cut
  // constraints off the end to pay for it. A small section must get all of what
  // it asked for; only the section that cannot fit does any squeezing.
  const budgets = new Map<string, number>();
  let sharing = sections.length;
  for (const s of [...sections].sort((a, b) => a.cost - b.cost)) {
    const give = Math.min(s.cost, Math.floor(left / sharing));
    budgets.set(s.head, give);
    left -= give;
    sharing--;
  }

  for (const s of sections) {
    parts.push(s.head + fitEntries(s.es, (budgets.get(s.head) as number) - s.head.length - 2));
  }

  // Supersession replaces a whole log, so correcting one decision also retires
  // every other constraint that log carried. That is the documented behaviour
  // and it is the right default — but done silently it is indistinguishable
  // from the loss this file exists to prevent. Say the number out loud.
  if (view.supersededEntries) {
    parts.push(
      `[${view.supersededEntries} constraint${view.supersededEntries === 1 ? "" : "s"} in superseded logs ` +
        "are not listed. Superseding retires the whole log, not one line of it, so anything still true " +
        "had to be restated in the log that replaced it. `nacre search <term>` reads the retired ones.]",
    );
  }

  // Summaries take what is left, and only if there is enough left to be worth
  // reading. They are the recoverable part: recent work is the work a session is
  // likeliest to already know about.
  const recent = view.logs.slice(0, 5).map((l) => {
    // Skip headings. A log with no `## Summary` fell back to the body, whose
    // first line is a heading — so the rail read "## Decided against" as though
    // that were what the session did.
    const line =
      (l.summary || l.summaryOnly)
        .split(/\r?\n/)
        .map((t) => t.trim())
        .find((t) => t && !t.startsWith("#")) ?? "";
    return `- ${l.date} · ${l.who} — ${line.replace(/^[-*]\s*/, "").trim()}`;
  });
  if (recent.length && BRIEF_CHARS - parts.join("\n\n").length > 240) {
    parts.push(cap(`## Recent sessions\n\n${recent.join("\n")}`, BRIEF_CHARS - parts.join("\n\n").length - 4));
  }

  if (parts.length === 1) {
    parts.push(
      "This project has a roster but nothing written yet — no logs, and the curated note is still a template.",
    );
  }

  return cap(parts.join("\n\n"), BRIEF_CHARS, NOT_A_CONSTRAINT);
}

export async function searchText(
  memory: string,
  query: string,
  opts: { project?: string; all?: boolean },
): Promise<string> {
  const hits = await search(memory, query, opts);
  if (!hits.length) {
    return `No match for "${query}"${opts.all ? "" : opts.project ? ` in ${opts.project}` : ""}.\nnext: retry with all=true to search every project`;
  }
  const rows = hits.map((h) => {
    // Company-wide files carry no date and no author — the fact is the company's,
    // not a session's. Rendering the log shape anyway produced rows that opened
    // " ·  · _company", which reads as missing data rather than as a different
    // kind of source. Name the file instead.
    const head = h.date && h.who ? `${h.date} · ${h.who} · ${h.project}` : h.rel;
    return `${head}${h.against ? " · DECIDED AGAINST" : ""}\n  ${h.line}`;
  });
  return cap(`${hits.length} match${hits.length === 1 ? "" : "es"} for "${query}"\n\n${rows.join("\n")}`, SEARCH_CHARS);
}
