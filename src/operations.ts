/**
 * Operations — the only place product logic lives.
 *
 * Each is a plain function: typed input, typed result, no rendering. The CLI is
 * one thin adapter over these; a hosted worker would be another. That boundary
 * is kept from day one because the competitor this design learns from let their
 * CLI grow into the engine and is paying for the rewrite.
 *
 * Three setup acts, three operations, because they are done by different people
 * at different times:
 *
 *   initStore   once per company   create the centralised store
 *   addProject  once per project   create a project inside it
 *   linkRepo    once per repo      bind a repo to a project — BOTH records
 */

import {
  PKG_ROOT,
  AGENTS,
  exists,
  storePath,
  gitSlug,
  readRoster,
  addToRoster,
  listProjects,
  logStats,
  installSkills,
  resolveBinding,
  frontmatter,
  storeRemote,
  initGit,
  repoName,
  resolveStoreDir,
  isPubliclyReadable,
  ensureMemory,
  remoteHasCommits,
  gitIdentity,
  readFile,
  writeFile,
  mkdir,
  cp,
  basename,
  join,
  resolve,
  detectAgents,
  skillsInstalled,
} from "./store.js";
import type { Binding } from "./store.js";

export interface InitInput {
  store?: string; storePath?: string; who?: string; force?: boolean;
  allowPublic?: boolean;
}
export interface AddInput {
  project?: string; title?: string; team?: string; repos?: string[];
  storePath?: string; store?: string | null; who?: string;
}
export interface LinkInput {
  repo?: string; project?: string; store?: string | null;
  storePath?: string; skipRoster?: boolean;
}
export interface LinkResult {
  dir: string; name: string; file: string; wrote: boolean;
  /** Whether AGENTS.md gained or refreshed the nacre block. */
  noted: boolean;
  /** Whether the Claude Code SessionStart hook was written. */
  hooked: boolean;
  project: string; store: string; roster: { added: string[]; repos: string[] } | null;
}

/** Create the one centralised context store for a company. */
export async function initStore({ store, storePath: pathFlag, who, force, allowPublic }: InitInput) {
  const dir = await resolveStoreDir(pathFlag, store);

  // Two questions about the same remote — is it public, and does it already
  // hold a memory — so they are asked at once rather than one after the other.
  // Sequentially this was the slowest thing `init` did.
  const [open, populated] = store
    ? await Promise.all([
        allowPublic ? Promise.resolve(null) : isPubliclyReadable(store),
        force ? Promise.resolve(null) : remoteHasCommits(store),
      ])
    : [null, null];

  // Refuse before creating anything. A memory holds production reasoning, and
  // a public one cannot be made private after the fact — the history is already
  // out and already cloneable.
  if (open === true) {
    throw new Error(
      `${store} is readable by anyone · a memory holds production reasoning ` +
        "and git history cannot be un-published · make it private, or pass " +
        "--i-know-its-public",
    );
  }

  const already = await exists(join(dir, "_company.md"));
  if (already && !force) {
    return { dir, created: false, remote: await initGit(dir, store), projects: await listProjects(dir) };
  }

  // The memory is missing HERE, which is not the same as missing everywhere.
  // Scaffolding without asking is how a company ends up with two memories on one
  // URL: the second person to run `init` gets an empty store and a history that
  // has nothing in common with the one their team is already writing to.
  //
  // `null` — offline, no access, no such repo — falls through to scaffolding on
  // purpose. A remote nobody can reach is a remote nobody can diverge from.
  if (store && populated === true) {
    const got = await ensureMemory(dir, store);
    if (!got.ok) throw new Error(`${store} already exists but could not be fetched · ${got.reason}`);
    return { dir, created: false, cloned: true, remote: store, projects: await listProjects(dir) };
  }

  const author = who ?? (await gitSlug());
  await mkdir(dir, { recursive: true });
  await cp(join(PKG_ROOT, "store-template", "_company.md"), join(dir, "_company.md"));
  await cp(join(PKG_ROOT, "store-template", "_standards.md"), join(dir, "_standards.md"));
  await cp(join(PKG_ROOT, "store-template", "_lessons"), join(dir, "_lessons"), {
    recursive: true,
  });
  await cp(
    join(PKG_ROOT, "store-template", "_team", "_your-slug"),
    join(dir, "_team", `_${author}`),
    { recursive: true },
  );
  // Fill what git already knows. A profile that opens with [INSERT NAME] reads
  // as a form nobody filled in, and a form nobody filled in stays that way.
  const profile = join(dir, "_team", `_${author}`, "_profile.md");
  if (await exists(profile)) {
    const identity = await gitIdentity();
    let text = await readFile(profile, "utf8");
    text = text
      .replace(/^who:.*$/m, `who: ${author}`)
      .replace(/^name:.*$/m, `name: ${identity.name ?? author}`)
      .replace(/^email:.*$/m, `email: ${identity.email ?? ""}`)
      .replace(/^# \[Insert Name\]$/m, `# ${identity.name ?? author}`);
    await writeFile(profile, text);
  }
  await writeFile(
    join(dir, ".gitignore"),
    "# Never leaves the machine.\n**/_drafts/\n.DS_Store\n",
  );
  const remote = await initGit(dir, store);
  return { dir, created: true, who: author, remote, projects: [] };
}

/** Add a project to the store. Optionally link repos in the same motion. */
export async function addProject({ project, title, team, repos, storePath: pathFlag, store, who }: AddInput) {
  if (!project) throw new Error("missing required argument: nacre add <project>");
  const dir = await resolveStoreDir(pathFlag, store ?? (await resolveBinding())?.store);
  if (!(await exists(join(dir, "_company.md")))) {
    throw new Error(`no memory at ${dir} · run: nacre init <git-url>`);
  }

  const author = who ?? (await gitSlug());
  const teamName = team ?? "devs";
  const projectDir = join(dir, project);
  const fresh = !(await exists(projectDir));

  if (fresh) {
    await cp(join(PKG_ROOT, "store-template", "PROJECT-TEMPLATE"), projectDir, { recursive: true });
    const std = join(projectDir, "_standards.md");
    if (await exists(std)) {
      const t = await readFile(std, "utf8");
      await writeFile(std, t
        .replace(/^project:.*$/m, `project: ${project}`)
        .replace(/^# \[Insert Project\] — Standards$/m, `# ${title ?? project} — Standards`));
    }
    const file = join(projectDir, "_project.md");
    let text = await readFile(file, "utf8");
    text = text
      .replace(/^project:.*$/m, `project: ${project}`)
      .replace(/^title:.*$/m, `title: ${title ?? project}`)
      .replace(/^repos:.*$/m, `repos: []`)
      .replace(/^teams:.*$/m, `teams: [${teamName}]`)
      .replace(/^# \[Insert Display Name\]$/m, `# ${title ?? project}`);
    await writeFile(file, text);
    await mkdir(join(projectDir, teamName, author), { recursive: true });
  }

  const remote = store ?? (await storeRemote(dir));
  const linked: LinkResult[] = [];
  for (const repo of repos ?? []) {
    // Pass the resolved memory down. A repo being linked for the first time has
    // no binding of its own, so letting linkRepo re-derive would discard the
    // answer add already had — and fail outright when more than one memory
    // exists on the machine.
    linked.push(await linkRepo({ repo, project, storePath: dir, store: remote, skipRoster: true }));
  }
  const roster = linked.length
    ? await addToRoster(dir, project, linked.map((l) => l.name))
    : await readRoster(dir, project).then((r) => ({ repos: r?.repos ?? [], added: [] as string[] }));

  return { dir, project, created: fresh, team: teamName, who: author, linked, roster };
}

/**
 * Bind one code repo to a project — writing BOTH records.
 *
 * `.nacre.yml` answers "which project am I, and where is the store"; the
 * project roster answers "which repos make up this project". They deliberately
 * answer different questions, so neither is a copy of the other — but a link
 * that updated only one of them would leave the company-level answer silently
 * wrong while every individual repo looked correctly wired.
 */
export async function linkRepo({ repo, project, store, storePath: pathFlag, skipRoster }: LinkInput): Promise<LinkResult> {
  const dir = resolve(repo ?? process.cwd());
  const name = basename(dir);
  if (!(await exists(dir))) throw new Error(`no such directory: ${dir}`);

  let remote = store;

  // Resolve the store URL rather than demanding it: an already-bound sibling
  // knows it, and failing that the store's own git remote is the record.
  if (!remote) remote = (await resolveBinding(dir))?.store;
  const storeDir = await resolveStoreDir(pathFlag, remote);
  if (!remote) remote = await storeRemote(storeDir);
  if (!remote) {
    throw new Error(
      `store at ${storeDir} has no git remote · pass --store <git-url>, ` +
        `or set one: git -C ${storeDir} remote add origin <git-url>`,
    );
  }
  if (!project) throw new Error("missing required flag: --project <name>");

  const file = join(dir, ".nacre.yml");
  let wrote = false;
  if (await exists(file)) {
    const current = frontmatter(`---\n${await readFile(file, "utf8")}\n---`);
    if (current.project && current.project !== project) {
      throw new Error(
        `${file} already binds this repo to "${current.project}", not "${project}". ` +
          `Resolve it by hand — rebinding a repo silently would point it at the wrong memory.`,
      );
    }
  } else {
    await writeFile(file, `project: ${project}\nmemory: ${remote}\n`);
    wrote = true;
  }

  const noted = await writeAgentsNote(dir, project as string);
  const hooked = await writeSessionHook(dir);

  const roster = skipRoster ? null : await addToRoster(storeDir, project as string, [name]);
  return { dir, name, file, wrote, noted, hooked, project: project as string, store: remote as string, roster };
}

const HOOK_COMMAND = "npx -y nacre-cli brief --hook";

/**
 * Load the memory without anyone having to remember to.
 *
 * The AGENTS.md note *asks* an agent to run `nacre brief`. Asking is discipline,
 * and discipline is the thing this project exists to stop relying on — a step
 * someone must remember is the 6pm problem wearing a different hat. A
 * SessionStart hook is delivery: it fires whether or not anyone thought of it,
 * and the install is won once, by one person, for everyone who clones after.
 *
 * Written into the project's `.claude/settings.json` because that file is
 * committed, so a teammate inherits it with the repo. That makes this the first
 * thing nacre writes that changes *behaviour* rather than leaving a signpost —
 * so it is one recognisable line, reported in the output, and deleting it is
 * enough to be rid of it.
 *
 * Claude Code only. The other four agents have no equivalent, and they still
 * have the AGENTS.md note.
 *
 * Merged, never overwritten: a project's own hooks and settings are none of
 * nacre's business.
 */
async function writeSessionHook(dir: string): Promise<boolean> {
  const file = join(dir, ".claude", "settings.json");
  let settings: Record<string, any> = {};
  if (await exists(file)) {
    try {
      settings = JSON.parse(await readFile(file, "utf8")) as Record<string, any>;
    } catch {
      // Unparseable settings are someone else's in-progress edit. Touching them
      // would replace a syntax error with a lost file.
      return false;
    }
  }

  const hooks = (settings.hooks ??= {});
  const starts: any[] = (hooks.SessionStart ??= []);
  const already = starts.some((group: any) =>
    (group?.hooks ?? []).some((h: any) => typeof h?.command === "string" && h.command.includes("nacre-cli brief")),
  );
  if (already) return false;

  starts.push({
    // 10s: long enough for an npx resolve on a cold cache, short enough that a
    // network problem does not hold a session open.
    hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 10 }],
  });
  await mkdir(join(dir, ".claude"), { recursive: true });
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
  return true;
}

const NOTE_START = "<!-- nacre:start -->";
const NOTE_END = "<!-- nacre:end -->";

/**
 * Tell any agent, including one that has never heard of nacre, what to run.
 *
 * A skill only fires for an agent that already knows the skill exists, and an
 * MCP tool only for a client someone configured. `AGENTS.md` is the one file
 * nearly every coding agent reads on its own, so it is where the memory
 * announces itself. Without this, a new teammate's agent sits next to a full
 * team memory and never asks for it.
 *
 * Kept short on purpose: this text is loaded into every session in the repo, so
 * it is charged for constantly and read once.
 */
async function writeAgentsNote(dir: string, project: string): Promise<boolean> {
  const file = join(dir, "AGENTS.md");
  const block = [
    NOTE_START,
    "## Team memory",
    "",
    `This repo is part of the **${project}** project, which keeps a shared memory of`,
    "what the team has decided.",
    "",
    "**At the start of a session, run this and read the output:**",
    "",
    "```sh",
    // npx, not a bare `nacre`. Whoever set this project up has nacre installed;
    // the teammate who just cloned this repo does not, and telling their agent
    // to run a command that is not there fails at the exact moment the memory
    // was supposed to help. `npx` needs no install and resolves to the global
    // one when it exists.
    "npx -y nacre-cli brief",
    "```",
    "",
    "It reports the project's rules, what was **decided against**, open risks, and the",
    "newest session logs from every teammate. Plain file reads — no model call.",
    "",
    "If it says you have no access, the memory is private and nobody has added you",
    "yet: ask whoever set it up to run `nacre invite <your-github-username>`.",
    "",
    "Installed globally (`npm i -g nacre-cli`), the same command is just `nacre brief`,",
    "and `nacre search <term>` looks through the same memory. To record what this",
    "session decided, run the `nacre-publish` skill; a person confirms before anything",
    "is pushed.",
    NOTE_END,
    "",
  ].join("\n");

  let text = (await exists(file)) ? await readFile(file, "utf8") : "";
  const from = text.indexOf(NOTE_START);
  const to = text.indexOf(NOTE_END);
  if (from !== -1 && to > from) {
    // Replace in place. Re-running `nacre add` is normal — adding a repo later is
    // the same command — and each run appending another copy would grow the file
    // that every session pays for.
    const next = text.slice(0, from) + block.trimEnd() + text.slice(to + NOTE_END.length);
    if (next === text) return false;
    await writeFile(file, next);
    return true;
  }
  await writeFile(file, text ? `${text.replace(/\s*$/, "")}\n\n${block}` : block);
  return true;
}

export interface LogStats { count: number; newest: string | null; who: string | null }

/**
 * A discriminated union rather than one loose shape, so a renderer cannot read
 * a field that does not exist in the state it is rendering — `binding` is only
 * present once there is one.
 */
export type Status =
  | { state: "no-store"; store: string; projects: string[]; reason?: string }
  | { state: "no-binding"; store: string; projects: string[] }
  | { state: "unknown-project"; store: string; projects: string[]; binding: BoundBinding }
  | {
      state: "ready"; store: string; binding: BoundBinding; repos: string[];
      logs: LogStats; here: string; skillsReady: boolean;
      /** The slug this machine files logs under. Shown because it is not a free
       *  choice: a log written under a different one splits the author in two. */
      you: string;
    };

/** A binding that has been checked to actually name a project. */
export type BoundBinding = Binding & { project: string };

/** Live state for the bare `nacre` command. Read-only, no side effects. */
export async function status({ storePath: pathFlag }: { storePath?: string } = {}): Promise<Status> {
  const binding = await resolveBinding();
  const dir = await resolveStoreDir(pathFlag, binding?.store);

  // A bound repo knows where its memory lives, so fetch it rather than telling
  // someone to create a second one.
  const ready = await ensureMemory(dir, binding?.store);
  if (!ready.ok) return { state: "no-store", store: dir, projects: [], reason: ready.reason };

  const projects = await listProjects(dir);
  if (!binding?.project) return { state: "no-binding", store: dir, projects };

  const bound = binding as BoundBinding;
  const project = bound.project;
  const roster = await readRoster(dir, project);
  if (!roster) return { state: "unknown-project", store: dir, projects, binding: bound };

  const logs = await logStats(dir, project);
  // Every agent on this machine, not just Claude Code. Reporting "ready" while
  // the teammate's actual agent has nothing installed is the same bug as
  // defaulting the installer to claude.
  const detected = await detectAgents();
  const skillsReady = (await Promise.all(detected.map(skillsInstalled))).every(Boolean);
  return {
    state: "ready", store: dir, binding: bound, repos: roster.repos, logs,
    here: basename(binding.dir), skillsReady, you: await gitSlug(),
  };
}

export { installSkills };
