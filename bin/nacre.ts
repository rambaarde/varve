#!/usr/bin/env node
/**
 * nacre CLI — argv in, one operation, rendered result out.
 *
 * No product logic here by design; it all lives in src/operations.ts.
 *
 * Output follows AXI (https://axi.md/): structured lines on stdout, explicit
 * empty states, and every command ending in the next command to run — so nobody
 * has to memorise a sequence. Exit 0 success / 1 error / 2 unknown flag.
 */

import { parseArgs } from "node:util";
import type { ParseArgsOptionsConfig } from "node:util";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { initStore, addProject, status, installSkills } from "../src/operations.js";
import type { Status } from "../src/operations.js";
import { isTTY, s as c, tilde, say, row, head, rule, ok, warn, next, blank } from "../src/render.js";
import { resolveStoreDir, resolveBinding, ensureMemory, memoryNeedsPush, detectAgents, exists, invite, storeRemote, PKG_ROOT } from "../src/store.js";
import { search as searchMemory, projectView } from "../src/portal.js";
import { serve } from "../src/serve.js";
import { serve as serveMcp } from "../src/mcp.js";
import { brief } from "../src/brief.js";
import { lint as lintStore, sleep as bedtime, CONSOLIDATE_THRESHOLD } from "../src/maintenance.js";
import { announcement, issueTemplate, notify } from "../src/notify.js";
import { readLogs } from "../src/portal.js";

// PKG_ROOT is imported, not recomputed. This file had its own copy that counted
// one directory up — correct from bin/ in the repo, wrong from dist/bin/ in the
// package, so `nacre --version` failed with ENOENT on every install. store.ts
// had already been fixed to walk up for package.json; the duplicate had not.

const OPTIONS = {
  memory: { type: "string" },
  "memory-path": { type: "string" }, // accepted spellings
  "store-path": { type: "string" },
  title: { type: "string" },
  team: { type: "string" },
  who: { type: "string" },
  agents: { type: "string" },
  force: { type: "boolean" },
  "no-skills": { type: "boolean" },
  "i-know-its-public": { type: "boolean" },
  plain: { type: "boolean" },
  port: { type: "string" },
  all: { type: "boolean" },
  open: { type: "boolean" },
  "dry-run": { type: "boolean" },
  hook: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
} as const satisfies ParseArgsOptionsConfig;

const USAGE = `nacre — one git-backed memory for a whole company

  nacre                          where am I, and what is next
  nacre init <git-url>           create the company memory     (once)
  nacre add  <project> [dir...]  add a project, and its repos  (as needed)
  nacre serve                    the portal, from your own clone
  nacre brief                    what the team already decided, before you start
  nacre invite <github-user>     give a teammate access to the memory
  nacre notify                   announce the newest log to $NACRE_NOTIFY_URL
  nacre search <term>            one search, same ranking as the portal
  nacre lint                     report store hygiene: unfilled files, weak lessons
  nacre sleep                    the bedtime pass: lint + what to consolidate
  nacre mcp                      serve the memory to any MCP client (stdio)

  also works as \`nac\`

Adding repos to an existing project is the same command again:
  nacre add atlas ../atlas-worker

  --memory <name|dir>  which memory, when you have more than one
  --team <name>        team folder       (default: devs)
  --title <name>       display name
  --who <slug>         author slug       (default: from git config)
  --agents <a,b>       claude,codex,gemini,opencode,cursor (default: those installed)
  --all                search every project, not just this one
  --port <n>           portal port       (default: 4173)
  --open               open the portal in your browser
  --dry-run            notify: print what would be sent, send nothing
  --hook               brief: silent on a thin store, never fails a session
  --no-skills          skip installing the skills
  --i-know-its-public  allow a memory anyone can read (it cannot be undone)
  --plain              plain output, as when piped

Reading and writing memory happen through the skills, not this binary.`;

/** Cut at a word boundary and say so, rather than stopping mid-word. */
const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, text.lastIndexOf(" ", max) > max / 2 ? text.lastIndexOf(" ", max) : max)}…`;

const out = (...lines: (string | null | undefined)[]): void =>
  lines.filter(Boolean).forEach((l) => console.log(l));

/** Brand line. Only a person needs to be told what they are looking at. */
const brand = (right: string): string[] => (isTTY() ? [blank(), head("nacre", right)] : []);

function fail(message: string, code = 1): never {
  if (isTTY()) {
    say(blank(), `  ${c.red("✗")} ${tilde(message)}`, blank());
  } else {
    console.log(`error: ${message}`);
    console.log("help[]: nacre --help");
  }
  process.exit(code);
}

/** Bare `nacre` — live state, and the single next command that applies. */
function renderStatus(st: Status): void {
  if (!isTTY()) return renderStatusPlain(st);

  if (st.state === "no-store") {
    return say(...brand(""), rule(),
      row("memory", tilde(st.store)),
      st.reason ? row("", st.reason) : null,
      blank(), next(`nacre ${c.bold("init")} <git-url>`), blank());
  }
  if (st.state === "no-binding") {
    const list = st.projects.length ? st.projects.join("  ") : c.grey("none yet");
    return say(...brand(tilde(st.store)), rule(),
      row("projects", list),
      row("here", c.grey("not bound to a project")),
      blank(),
      next(st.projects.length
        ? `nacre ${c.bold("add")} <${st.projects.join("|")}> .`
        : `nacre ${c.bold("add")} <project> .`),
      blank());
  }
  if (st.state === "unknown-project") {
    return say(...brand(tilde(st.store)), rule(),
      warn(`.nacre.yml names ${c.bold(st.binding.project)}, which is not in this memory`),
      row("projects", st.projects.join("  ") || c.grey("none")),
      blank(), next(`nacre ${c.bold("add")} ${st.binding.project}`), blank());
  }

  const { binding, repos, logs, here, skillsReady, you } = st;
  const summary = `${repos.length} repo${repos.length === 1 ? "" : "s"} · ${logs.count} log${logs.count === 1 ? "" : "s"}`;
  say(
    ...brand(tilde(st.store)),
    rule(),
    head(binding.project, summary),
    blank(),
    row("repos", repos.map((r) => (r === here ? c.bold(r) : c.dim(r))).join("  ") || c.grey("none linked")),
    logs.newest ? row("last", `${logs.newest.replace(/\.md$/, "")}  ${c.dim(logs.who)}`) : null,
    row("here", here ? c.bold(here) : c.grey("outside a linked repo")),
    row("you", `${c.bold(you)}  ${c.dim("— logs and your profile file under this")}`),
    blank(),
    skillsReady ? null : warn(`skills not installed · nacre add ${binding.project} .`),
    logs.count === 0
      ? next(`${c.bold("nacre-publish")} at the end of this session ${c.grey("— nothing recorded yet")}`)
      : next(`${c.bold("nacre-load")} at session start · ${c.bold("nacre-publish")} at the end`),
    blank(),
  );
}

/** The plain path is byte-for-byte what agents and CI already parse. */
function renderStatusPlain(st: Status): void {
  if (st.state === "no-store") {
    return out(
      `no memory at ${st.store}`,
      st.reason ? `reason: ${st.reason}` : null,
      "next: nacre init <git-url>",
      "help[]: nacre --help",
    );
  }
  if (st.state === "no-binding") {
    return out(
      `memory: ${st.store} · projects[${st.projects.length}]: ${st.projects.join(", ") || "none yet"}`,
      "this directory is not bound to a project",
      st.projects.length ? `next: nacre add <${st.projects.join("|")}> .` : "next: nacre add <project> .",
      "help[]: nacre --help",
    );
  }
  if (st.state === "unknown-project") {
    return out(
      `error: .nacre.yml names "${st.binding.project}", which is not in ${st.store}`,
      `projects[${st.projects.length}]: ${st.projects.join(", ") || "none"}`,
      `next: nacre add ${st.binding.project}`,
    );
  }
  const { binding, repos, logs, here, skillsReady, you } = st;
  out(
    `project: ${binding.project} · repos[${repos.length}]: ${repos.join(", ") || "none linked"} · ` +
      `logs: ${logs.count}${logs.newest ? ` · last: ${logs.newest.replace(/\.md$/, "")} (${logs.who})` : ""}`,
    `memory: ${st.store}${here ? ` · you are in: ${here}` : ""} · you: ${you}`,
    logs.count === 0
      ? "no logs yet · next: nacre-publish at the end of this session"
      : "next: nacre-load at the start of a session · nacre-publish at the end",
    skillsReady ? null : "warn: skills not installed · next: nacre add " + binding.project + " .",
  );
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ options: OPTIONS, allowPositionals: true, args: process.argv.slice(2) });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), 2);
  }
  const { values: o, positionals } = parsed;
  const [command, arg] = positionals;

  if (o.version) {
    const pkg = JSON.parse(await readFile(join(PKG_ROOT, "package.json"), "utf8"));
    return console.log(pkg.version);
  }
  if (o.help || command === "help") return console.log(USAGE);

  // Before anything else that could print. An MCP client speaks JSON-RPC on this
  // stdout, and a single stray line of human output corrupts the stream.
  if (command === "mcp") {
    const pkg = JSON.parse(await readFile(join(PKG_ROOT, "package.json"), "utf8"));
    return serveMcp({
      version: pkg.version as string,
      memory: o.memory ?? o["memory-path"] ?? o["store-path"],
    });
  }

  const memoryPath = o.memory ?? o["memory-path"] ?? o["store-path"];
  // Default to the agents actually installed on this machine, not to Claude
  // Code. A teammate on Cursor or Codex should not have to discover a flag to
  // get the same two commands everyone else has.
  const agents = o.agents
    ? o.agents.split(",").map((a) => a.trim()).filter(Boolean)
    : await detectAgents();

  try {
    // Bare `nacre` shows live state, never a usage dump.
    if (!command) return renderStatus(await status({ storePath: memoryPath }));

    if (command === "init") {
      if (!arg && !memoryPath) fail("missing argument: nacre init <git-url>");
      const r = await initStore({
        store: arg, storePath: memoryPath, who: o.who, force: o.force,
        allowPublic: o["i-know-its-public"],
      });
      // Cloned, not created — the company already had a memory at this URL, and
      // saying "created" would describe the one thing that did not happen.
      const cloned = "cloned" in r && r.cloned;
      if (!isTTY()) {
        if (cloned) {
          return out(
            `ok: memory fetched · ${r.dir}`,
            `projects[${r.projects.length}]: ${r.projects.join(", ") || "none yet"} · remote: ${r.remote ?? "not set"}`,
            "next: nacre add <project> <repo-dir>",
            "help[]: this memory already existed — nothing was overwritten",
          );
        }
        return r.created
          ? out(
              `ok: memory created · ${r.dir}`,
              `files: _company.md, _standards.md, _team/_${r.who}/ · remote: ${r.remote ?? "not set"}`,
              "next: nacre add <project> <repo-dir>",
              "help[]: commit and push the memory, then keep the default branch protected",
            )
          : out(
              `ok: memory already at ${r.dir} · projects[${r.projects.length}]: ${r.projects.join(", ") || "none yet"}`,
              "next: nacre add <project> <repo-dir>",
            );
      }
      if (cloned) {
        return say(blank(), ok(`memory fetched  ${c.grey(tilde(r.dir))}`),
          blank(),
          row("projects", r.projects.join("  ") || c.grey("none yet")),
          row("remote", r.remote ?? c.grey("not set")),
          blank(),
          `  ${c.grey("this memory already existed — nothing was overwritten")}`,
          next(`nacre ${c.bold("add")} <project> <repo-dir>`), blank());
      }
      if (!r.created) {
        return say(blank(), ok(`memory already at ${c.bold(tilde(r.dir))}`),
          row("projects", r.projects.join("  ") || c.grey("none yet")),
          blank(), next(`nacre ${c.bold("add")} <project> <repo-dir>`), blank());
      }
      return say(blank(),
        ok(`memory created  ${c.grey(tilde(r.dir))}`),
        blank(),
        row("files", `_company.md  _standards.md  _team/_${r.who}/`),
        row("remote", r.remote ?? c.grey("not set")),
        blank(),
        next(`nacre ${c.bold("add")} <project> <repo-dir>`),
        `  ${c.grey("then commit and push it, and protect the default branch")}`,
        blank());
    }

    if (command === "add") {
      if (!arg) fail("missing argument: nacre add <project> [dir...]");
      // Everything after the project name is a repo to link. Adding repos to an
      // existing project is the same command again — no separate verb for it.
      const r = await addProject({
        project: arg, title: o.title, team: o.team, repos: positionals.slice(2),
        storePath: memoryPath, who: o.who,
      });
      const ready = !o["no-skills"] && r.linked.length ? await installSkills(agents) : [];
      const fresh = r.linked.filter((l) => l.wrote).map((l) => l.name);
      const noted = r.linked.filter((l) => l.noted).map((l) => l.name);
      const hooked = r.linked.filter((l) => l.hooked).map((l) => l.name);
      // "teammates then need nothing" is true of .nacre.yml and false of the
      // memory, which no remote has seen yet. Promising the first while the
      // second sits unpushed is how someone clones a wired repo and finds an
      // empty store behind it.
      const needsPush = await memoryNeedsPush(r.dir);
      if (!isTTY()) {
        return out(
          `ok: ${r.project} ${r.created ? "added" : "already present"} · ${r.dir}/${r.project}`,
          `repos[${r.roster.repos.length}]: ${r.roster.repos.join(", ") || "none linked"} · team: ${r.team}`,
          ready.length ? `agents[${ready.length}]: ${ready.join(", ")}` : null,
          noted.length ? `AGENTS.md: ${noted.join(", ")} — so an agent that has never heard of nacre still finds it` : null,
          hooked.length ? `hook: ${hooked.join(", ")}/.claude/settings.json — Claude Code loads the memory without being asked` : null,
          needsPush
            ? `next: commit and push ${r.dir}${fresh.length ? `, then commit .nacre.yml in ${fresh.join(", ")}` : ""}`
            : fresh.length
              ? `next: commit .nacre.yml in ${fresh.join(", ")} — teammates then need nothing`
              : `next: nacre add ${r.project} <repo-dir>`,
          needsPush ? "help[]: until the memory is pushed, a teammate's clone finds nothing behind it" : null,
        );
      }
      return say(blank(),
        ok(`${c.bold(r.project)} ${r.created ? "added" : c.grey("already present")}  ${c.grey(tilde(r.dir + "/" + r.project))}`),
        blank(),
        row("repos", r.roster.repos.map((x) => (fresh.includes(x) ? c.bold(x) : c.dim(x))).join("  ") || c.grey("none linked")),
        row("team", r.team),
        ready.length ? row("agents", ready.map((a) => c.dim(a)).join("  ")) : null,
        noted.length ? row("AGENTS.md", c.grey(`${noted.join(", ")} — how an unfamiliar agent finds nacre`)) : null,
        hooked.length ? row("hook", c.grey("Claude Code loads the memory at session start, unasked")) : null,
        blank(),
        needsPush
          ? next(`commit and push ${c.bold(tilde(r.dir))}${fresh.length ? c.grey(`, then .nacre.yml in ${fresh.join(", ")}`) : ""}`)
          : fresh.length
            ? next(`commit ${c.bold(".nacre.yml")} in ${fresh.join(", ")} ${c.grey("— teammates then need nothing")}`)
            : next(`nacre ${c.bold("add")} ${r.project} <repo-dir>`),
        needsPush ? `  ${c.grey("until the memory is pushed, a teammate's clone finds nothing behind it")}` : null,
        blank());
    }


    if (command === "serve") {
      const binding = await resolveBinding();
      const memory = await resolveStoreDir(memoryPath, binding?.store);
      const ready = await ensureMemory(memory, binding?.store);
      if (!ready.ok) fail(`${tilde(memory)} · ${ready.reason}`);
      const port = o.port === undefined ? 4173 : Number(o.port);
      if (Number.isNaN(port)) fail(`--port must be a number, got: ${o.port}`, 2);
      const { url } = await serve({ memory, port });
      // Declared in the options table from the first version and never read, so
      // `--open` silently did nothing. Failing to open is not failing to serve:
      // the URL is printed either way.
      if (o.open) {
        const opener = process.platform === "darwin" ? "open"
          : process.platform === "win32" ? "explorer" : "xdg-open";
        const { spawn } = await import("node:child_process");
        try { spawn(opener, [url], { stdio: "ignore", detached: true }).unref(); } catch { /* the URL is above */ }
      }
      // A developer about to read someone else's reasoning wants to know, in
      // this order: is this the right memory, is it fresh, what is in it, what
      // changed last, and where am I standing. The URL alone answers none of
      // that, and a stale clone reading stale memory is this design's one quiet
      // failure — so its age is stated rather than left to be assumed.
      const { index: readIndex, readLogs: readAll, age: cloneAge } = await import("../src/portal.js");
      const { memoryNeedsPush: needsPush, storeRemote: remoteOf } = await import("../src/store.js");
      const [idx, logs, since, unpushed, remote] = await Promise.all([
        readIndex(memory), readAll(memory), cloneAge(memory), needsPush(memory), remoteOf(memory),
      ]);
      const bind = await resolveBinding();
      const newest = logs[0];
      const named = (m: Record<string, number>, n: number): string =>
        Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n)
          .map(([k, v]) => `${k} ${c.dim(String(v))}`).join(c.dim("  ·  "));

      if (isTTY()) {
        say(blank(), ok(`portal on ${c.bold(url)}`), blank(),
          row("memory", `${tilde(memory)}  ${c.dim(`pulled ${since}`)}`),
          remote ? row("remote", c.dim(remote)) : null,
          unpushed ? row("", c.yellow("unpushed work here — teammates will not see it yet")) : null,
          blank(),
          row("projects", named(idx.projects, 6) || c.grey("none yet")),
          row("people", named(idx.people, 6) || c.grey("none yet")),
          row("logs", `${idx.total}`),
          newest
            ? row("latest", `${c.dim(newest.date)}  ${newest.who}  ${c.dim(newest.project)}  ${
                clip((newest.summary.split("\n").find((x) => x.trim()) ?? newest.id)
                  .replace(/^#+\s*/, "").replace(/\*\*/g, ""), 58)}`)
            : null,
          blank(),
          bind?.project
            ? row("here", `${basename(process.cwd())} ${c.dim("→")} ${c.bold(bind.project)}`)
            : row("here", c.grey("not inside a wired repo")),
          blank(),
          `  ${c.dim("⌘K")} in the portal to jump  ${c.dim("·")}  ${c.dim("ctrl-c")} to stop`,
          blank());
      } else {
        out(
          `ok: serving ${url}`,
          `memory: ${memory} · pulled ${since}${remote ? ` · remote: ${remote}` : ""}`,
          `projects[${Object.keys(idx.projects).length}]: ${Object.entries(idx.projects).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
          `people[${Object.keys(idx.people).length}]: ${Object.entries(idx.people).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
          `logs: ${idx.total}${newest ? ` · latest: ${newest.date} ${newest.who} ${newest.project}` : ""}`,
          bind?.project ? `here: ${basename(process.cwd())} -> ${bind.project}` : "here: not inside a wired repo",
          unpushed ? "warn: unpushed work in the memory — teammates will not see it yet" : null,
          "help[]: ctrl-c to stop · --open launches your browser",
        );
      }
      return new Promise(() => {}); // hold the process open
    }

    // The read door that needs no skill, no MCP client, and no prior knowledge
    // of nacre. An agent that has never heard of this project can be told one
    // shell command and get the same briefing everything else reads.
    if (command === "brief" || command === "load") {
      const binding = await resolveBinding();
      const project = arg ?? binding?.project;

      // --hook is how a SessionStart hook calls this, and it has two rules a
      // person invoking `nacre brief` does not want.
      //
      // It never fails. A hook that errors interrupts a session that had
      // nothing to do with nacre, and the memory is not important enough to
      // stand between someone and their editor.
      //
      // It says nothing when there is nothing worth saying. A brief injected
      // into every session costs context forever, and a thin store spends it to
      // report that the team has decided nothing — which is also the fastest way
      // to teach someone the tool is not worth having.
      if (o.hook) {
        try {
          if (!project) return;
          const dir = await resolveStoreDir(memoryPath, binding?.store ?? null);
          if (!(await exists(join(dir, "_company.md")))) return;
          const view = await projectView(dir, project);
          if (!view || view.count === 0) return;
          console.log(await brief(dir, project));
        } catch {
          // Deliberately silent: see above.
        }
        return;
      }

      if (!project) {
        fail("no project here · run nacre add <project> . in this repo, or nacre brief <project>");
      }
      const memory = await resolveStoreDir(memoryPath, binding?.store ?? null);
      // Fetch it, never tell a teammate to `init`. Running init on a bound repo
      // builds a SECOND memory whose history has nothing in common with the one
      // the team is writing to — the failure this repo already has a test for,
      // reintroduced here because brief was wired straight to the filesystem.
      const got = await ensureMemory(memory, binding?.store);
      if (!got.ok) fail(got.reason);
      console.log(await brief(memory, project as string));
      return;
    }

    // Outbound only, and only after a person already confirmed the push. A
    // failure here is reported but never fails the command: the log is already
    // safe, and a red exit would send someone hunting a problem that is not there.
    // The one onboarding step that cannot be automated away: a private memory
    // gives a teammate nothing until they are on it. It used to live entirely
    // in a browser, which is why it sat between "clone the repo" and "warm".
    if (command === "invite") {
      if (!arg) fail("missing argument: nacre invite <github-username>");
      const binding = await resolveBinding();
      const memory = await resolveStoreDir(memoryPath, binding?.store ?? null);
      const remote = binding?.store ?? (await storeRemote(memory));
      const r = await invite(remote ?? null, arg);
      if (r.ok) {
        return out(
          `ok: invited ${arg} — write access to ${remote}`,
          `next: tell them to clone any repo in the project and run: npx -y nacre-cli brief`,
        );
      }
      return out(
        `not invited: ${r.reason}`,
        r.url ? `next: add them here — ${r.url}` : null,
        r.url ? "help[]: gh auth login, then nacre invite <github-username>" : null,
      );
    }

    if (command === "notify") {
      const binding = await resolveBinding();
      const memory = await resolveStoreDir(memoryPath, binding?.store ?? null);
      // Same rule as brief: fetch, never send a bound repo to `init`.
      const have = await ensureMemory(memory, binding?.store);
      if (!have.ok) fail(have.reason);
      const [newest] = await readLogs(memory, arg ?? binding?.project);
      if (!newest) {
        return out("no logs yet — nothing to announce", "next: nacre-publish at the end of a session");
      }
      const text = announcement(newest, await issueTemplate(memory));
      if (o["dry-run"]) return out(text, "", "dry run — nothing sent");
      const r = await notify(text);
      return out(
        r.sent ? `ok: announced ${newest.rel}` : `not sent: ${r.reason}`,
        r.unset ? "help[]: export NACRE_NOTIFY_URL=<your Slack/Discord webhook>" : null,
      );
    }

    if (command === "search") {
      const term = positionals.slice(1).join(" ");
      if (!term) fail("missing argument: nacre search <term>");
      const binding = await resolveBinding();
      const memory = await resolveStoreDir(memoryPath, binding?.store);
      await ensureMemory(memory, binding?.store);
      const hits = await searchMemory(memory, term, { project: binding?.project, all: o.all });
      if (!hits.length) {
        return out(`no hits for "${term}"${binding?.project && !o.all ? ` in ${binding.project}` : ""}`,
          "help[]: nacre search <term> --all");
      }
      // Ranking is the engine's; truncation is this adapter's. Breadth beats depth inside a token ceiling. One thorough log can match
      // six times and crowd out every other session that mentioned the same
      // thing — the opposite of what "what did the team decide" needs. The
      // portal still shows every line; this ceiling is the CLI's alone.
      //
      // Both caps are env-tunable, the same escape hatch create-ai-memory's
      // ai-mem-search gives (AI_MEM_SEARCH_LIMIT / AI_MEM_SEARCH_PER_FILE): a
      // reader who hits the ceiling can raise it in place rather than lose the
      // hidden rows. A non-numeric or non-positive value falls back to the
      // default rather than truncating to nothing or throwing.
      const envInt = (name: string, fallback: number): number => {
        const n = Number(process.env[name]);
        return Number.isInteger(n) && n > 0 ? n : fallback;
      };
      const perSession = envInt("NACRE_SEARCH_PER_SESSION", 2);
      const limit = envInt("NACRE_SEARCH_LIMIT", 12);
      const perLog = new Map<string, number>();
      const spread = hits.filter((h) => {
        const n = (perLog.get(h.id) ?? 0) + 1;
        perLog.set(h.id, n);
        return n <= perSession;
      });
      const shown = spread.slice(0, limit);
      // Count first, then how many are hidden and why, then how to see them —
      // the reader needs to know the result set is larger than the page before
      // acting on the page, exactly as ai-mem-search reports its own cap.
      const hidden = hits.length - shown.length;
      out(`hits[${hits.length}]{date,who,project,line}:`,
        ...shown.map((h) => `${h.date},${h.who},${h.project},${h.line.slice(0, 90)}`),
        hidden > 0
          ? `(showing ${shown.length} of ${hits.length}, ${hidden} hidden — at most ${perSession} per session;`
            + ` raise NACRE_SEARCH_PER_SESSION / NACRE_SEARCH_LIMIT, narrow the term, or nacre serve for all)`
          : null,
        "help[]: nacre serve · nacre search <term> --all");
      return;
    }

    if (command === "lint") {
      const binding = await resolveBinding();
      const memory = await resolveStoreDir(memoryPath, binding?.store);
      await ensureMemory(memory, binding?.store);
      const findings = await lintStore(memory);
      if (!findings.length) return out("clean · no hygiene issues in this memory");
      out(
        `issues[${findings.length}]{file,message}:`,
        ...findings.map((f) => `${f.file} — ${f.message}`),
        "help[]: fix these, or nacre sleep for the full bedtime pass",
      );
      return;
    }

    if (command === "sleep") {
      const binding = await resolveBinding();
      const memory = await resolveStoreDir(memoryPath, binding?.store);
      await ensureMemory(memory, binding?.store);
      const report = await bedtime(memory);
      const lines: (string | null)[] = [
        report.findings.length ? `lint[${report.findings.length}]:` : "lint: clean",
        ...report.findings.map((f) => `  ${f.file} — ${f.message}`),
        report.consolidation.length
          ? `consolidate[${report.consolidation.length}] (${CONSOLIDATE_THRESHOLD}+ logs — distil into a lesson):`
          : "consolidate: nothing large enough yet",
        ...report.consolidation.map((c) => `  ${c.project} · ${c.logs} logs`),
        // The honest boundary: nacre keeps every log because the brief reads
        // every decided-against and risk from all of them. Sleep never sweeps.
        "note: sleep reports only — it never archives; every log stays in recall by design",
      ];
      out(...lines);
      return;
    }

    fail(`unknown command: ${command} · try: nacre --help`, 2);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
