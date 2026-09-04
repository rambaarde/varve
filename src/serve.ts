/**
 * The human door: a local read-only portal over your own clone.
 *
 * A node:http server rather than a site generator. The local portal is a live
 * process reading a checkout, so a build step buys nothing here — and a
 * framework would be a dependency tree inside a package whose install pitch is
 * that it has none.
 *
 * No auth, and none needed: it binds loopback and serves a clone you already
 * have. Whoever can read the memory can already read it.
 *
 * Layout follows the design the store's shape implies — three entry axes, a
 * flat rail with counts, and a project page ordered by urgency of not knowing
 * rather than by recency. Colour carries meaning only.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { exists } from "./store.js";
import { markdown, escape, inline } from "./markdown.js";
import { setIssueTemplate } from "./markdown.js";
import { issueTemplate } from "./notify.js";
import { tilde } from "./render.js";
import { index, projectView, personView, search, age, readLogs, projectStandards, unfilled, seamGraph } from "./portal.js";
import type { Hit, Log, Graph, GraphNode } from "./portal.js";

type Index = Awaited<ReturnType<typeof index>>;
type ProjectView = NonNullable<Awaited<ReturnType<typeof projectView>>>;
type PersonView = Awaited<ReturnType<typeof personView>>;
type Active = { project?: string; who?: string; month?: string; company?: string; section?: string };

/**
 * Design: Obsidian's palette and type, a documentation site's structure.
 *
 * Obsidian because the store is a vault of markdown and the portal should not
 * feel like a different product from the editor people already read it in.
 * Documentation-site structure — sticky header with search, grouped sidebar,
 * breadcrumbs, an on-this-page rail — because a memory with three hundred logs
 * is a reference work, and reference works solved navigation long ago.
 *
 * This supersedes thesis §6.4.4 on two points, deliberately and on the author's
 * instruction: cards and summary tiles are now allowed. What it keeps is what
 * that section got right — three entry axes, counts in the rail, and
 * decided-against as first-class colour that is never struck through.
 */
const CSS = `
:root{
  color-scheme:light dark;
  /* Achromatic by default. The only hues in the product are the two that carry
     meaning — a rejected option and an open risk — so they read as information
     rather than decoration. A brand colour on every surface is what makes a
     reference work look like a landing page. */
  --paper:#fdfdfc; --sunk:#f4f4f1; --ink:#101014; --ink-2:#3c3c44; --ink-3:#6b6b74;
  --rule:#dcdcd7; --rule-2:#b9b9b2;
  --declined:#8f3a20; --risk:#7a5a10;
  --serif:"Iowan Old Style","Charter","Palatino Linotype",Palatino,Georgia,serif;
  --sans:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",Helvetica,Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --measure:41rem; --side:15rem; --toc:13rem;
}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){
  --paper:#101012; --sunk:#191a1d; --ink:#f0f0ed; --ink-2:#b8b8b4; --ink-3:#8a8a91;
  --rule:#303036; --rule-2:#4a4a52;
  --declined:#e0906c; --risk:#d4b05a;
}}
:root[data-theme=dark]{
  --paper:#101012; --sunk:#191a1d; --ink:#f0f0ed; --ink-2:#b8b8b4; --ink-3:#8a8a91;
  --rule:#303036; --rule-2:#4a4a52;
  --declined:#e0906c; --risk:#d4b05a;
}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);
font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}

/* ---------- masthead ---------- */
.top{display:flex;align-items:center;gap:.8rem;padding:.55rem 1.1rem;
border-bottom:1px solid var(--rule);position:sticky;top:0;z-index:20;background:var(--paper)}
.sidetgl{flex:none;display:inline-flex;align-items:center;justify-content:center;
width:1.75rem;height:1.75rem;background:none;border:1px solid transparent;border-radius:6px;
color:var(--ink-3);cursor:pointer;font:inherit;line-height:1;padding:0}
/* One control, two homes: inside the sidebar while it is open, and in the
   masthead once it is not — otherwise hiding the sidebar hides the only way
   to bring it back. */
.top .sidetgl{margin-left:-.35rem;display:none}
:root[data-side=off] .top .sidetgl{display:inline-flex}
.sidetgl:hover{color:var(--ink);background:var(--sunk);border-color:var(--rule)}
.sidetgl:focus-visible{outline:2px solid var(--ink);outline-offset:1px}
.sidetgl .bar{display:block;width:.95rem;height:.72rem;border:1.5px solid currentColor;
border-radius:2px;position:relative}
.sidetgl .bar::before{content:"";position:absolute;left:2.5px;top:0;bottom:0;
width:1.5px;background:currentColor}
:root[data-side=off] .sidetgl .bar::before{opacity:.28}
.brand{font-family:var(--serif);font-size:1.12rem;letter-spacing:.01em;font-weight:600}
.top .repo{font-family:var(--mono);font-size:.72rem;color:var(--ink-3);
overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.top .grow{flex:1}
.qbox{display:flex;align-items:center;gap:.7rem;flex:0 0 auto;width:16rem;max-width:44vw;
height:2rem;background:var(--sunk);border:1px solid var(--rule);border-radius:6px;
padding:0 .5rem 0 .7rem;cursor:pointer;font:inherit;text-align:left}
.qbox:hover{border-color:var(--rule-2);color:var(--ink)}
.qbox:focus-visible{outline:2px solid var(--ink);outline-offset:1px}
.qbox .qph{flex:1;font-family:var(--sans);font-size:.8rem;color:var(--ink-3);
overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qbox kbd{font-family:var(--mono);font-size:.68rem;color:var(--ink-3)}
.tgl{flex:none;display:inline-flex;align-items:center;justify-content:center;
width:2rem;height:2rem;background:none;border:1px solid transparent;border-radius:6px;
color:var(--ink-2);cursor:pointer;font-size:1rem;line-height:1;padding:0}
.tgl:hover{color:var(--ink);background:var(--sunk);border-color:var(--rule)}
.tgl:focus-visible{outline:2px solid var(--ink);outline-offset:1px}
/* Show the moon in light mode and the sun in dark: the control offers what you
   would get, not what you already have. */
.tgl .sun{display:none}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]) .tgl .sun{display:inline}
  :root:not([data-theme=light]) .tgl .moon{display:none}}
:root[data-theme=dark] .tgl .sun{display:inline}
:root[data-theme=dark] .tgl .moon{display:none}

/* ---------- frame ---------- */
.frame{display:grid;grid-template-columns:1fr}
@media(min-width:58rem){.frame{grid-template-columns:var(--side) minmax(0,1fr)}}
@media(min-width:84rem){.frame{grid-template-columns:var(--side) minmax(0,1fr) var(--toc)}}
/* Collapsed: the column goes, and the reading measure stays put rather than
   stretching to fill the space — a longer line is not the reward for hiding
   the navigation. */
:root[data-side=off] .side{display:none}
@media(min-width:58rem){:root[data-side=off] .frame{grid-template-columns:minmax(0,1fr)}}
@media(min-width:84rem){:root[data-side=off] .frame{grid-template-columns:minmax(0,1fr) var(--toc)}}
:root[data-side=off] .main{max-width:64rem;margin:0 auto;width:100%}

/* ---------- contents rail ---------- */
.side{padding:1.4rem 1.1rem 3rem;border-bottom:1px solid var(--rule)}
@media(min-width:58rem){.side{border-bottom:0;border-right:1px solid var(--rule);
position:sticky;top:3rem;height:calc(100vh - 3rem);overflow-y:auto}}
.side h4{margin:1.9rem 0 .45rem;font-family:var(--sans);font-size:.72rem;font-weight:600;
letter-spacing:.06em;color:var(--ink-3)}
.side h4:first-child{margin-top:0}
.sidehead{display:flex;align-items:center;justify-content:space-between;
gap:.5rem;margin:0 0 1.1rem}
.sidelbl{font-family:var(--sans);font-size:.72rem;font-weight:600;color:var(--ink-3)}
.side ul{list-style:none;margin:0;padding:0}
.side li>a{display:flex;justify-content:space-between;gap:.8rem;align-items:baseline;
padding:.27rem .55rem;margin:0 0 0 -.55rem;border-radius:4px;
font-size:.88rem;color:var(--ink-2)}
.side li>a:hover{color:var(--ink);background:var(--sunk)}
.side li.on>a{color:var(--ink);font-weight:600;background:var(--sunk)}
.side li{position:relative}
.side .n{font-family:var(--mono);font-size:.7rem;color:var(--ink-3);font-variant-numeric:tabular-nums}
.side .none{color:var(--ink-3);font-size:.8rem}

/* ---------- article ---------- */
.main{padding:2.1rem 1.4rem 6rem;min-width:0}
@media(min-width:58rem){.main{padding:2.6rem 2.6rem 7rem}}
.crumbs{font-family:var(--mono);font-size:.7rem;letter-spacing:.02em;
color:var(--ink-3);margin:0 0 .9rem}
.crumbs a:hover{color:var(--ink);border-bottom:1px solid var(--rule-2)}
.crumbs .sl{padding:0 .35rem;color:var(--rule-2)}
h1{font-family:var(--serif);font-size:2.15rem;line-height:1.14;letter-spacing:-.016em;
font-weight:600;margin:0 0 .4rem}
.lede{font-family:var(--mono);font-size:.74rem;color:var(--ink-3);
margin:0 0 1.1rem;letter-spacing:.01em}

/* ---------- page tabs ---------- */
.tabs{display:flex;gap:1.5rem;margin:0 0 2.5rem;padding:0 0 .5rem;
border-bottom:1px solid var(--rule);font-family:var(--sans);font-size:.86rem}
.tabs a{color:var(--ink-3);padding-bottom:.5rem;margin-bottom:-.5rem;border-bottom:2px solid transparent}
.tabs a:hover{color:var(--ink)}
.tabs a.on{color:var(--ink);border-bottom-color:var(--ink)}

/* ---------- facts: a definition row, not tiles ---------- */
.facts{display:flex;flex-wrap:wrap;gap:1rem 3rem;margin:0 0 2.4rem}
.facts div{min-width:0}
.facts dt{font-family:var(--sans);font-size:.74rem;color:var(--ink-3);margin:0 0 .1rem}
.facts dd{margin:0;font-family:var(--sans);font-size:1.05rem;line-height:1.3;
color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums}
.facts .of{display:block;font-family:var(--mono);font-size:.72rem;font-weight:400;
line-height:1.5;color:var(--ink-3);margin-top:.15rem;max-width:14rem}

/* ---------- handoff: a rule and a hanging label, no fill ---------- */
.callout{margin:0 0 2.5rem;padding:.9rem 1.1rem;background:var(--sunk);border-radius:6px}
.callout .ct{display:flex;align-items:baseline;gap:.7rem;font-family:var(--sans);
font-size:.8rem;font-weight:650;color:var(--ink);margin:0 0 .35rem}
.callout .cw{margin-left:auto;font-weight:400;color:var(--ink-3);letter-spacing:.01em}
.callout .prose{font-family:var(--serif);font-size:1.06rem;line-height:1.5}
.callout p{margin:0}

/* ---------- sections ---------- */
.sec{margin:0 0 2.6rem;scroll-margin-top:4.5rem}
.sec>h2{display:flex;align-items:baseline;gap:.8rem;font-family:var(--sans);
font-size:1rem;font-weight:600;letter-spacing:-.006em;color:var(--ink);
margin:0 0 .85rem;padding-bottom:.45rem;border-bottom:1px solid var(--rule)}
.sec>h2 .cnt{margin-left:auto;font-family:var(--mono);font-size:.7rem;font-weight:400;
letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);font-variant-numeric:tabular-nums}

/* ---------- reading column ---------- */
.prose{max-width:var(--measure);font-family:var(--serif);font-size:1.02rem;line-height:1.62}
.prose h1,.prose h2{font-family:var(--sans);font-size:.94rem;font-weight:650;
color:var(--ink);margin:1.7rem 0 .45rem;letter-spacing:-.002em}
.prose h3,.prose h4{font-family:var(--sans);font-size:.88rem;font-weight:600;
color:var(--ink-2);margin:1.2rem 0 .25rem}
.prose p{margin:.6rem 0}
.prose ul,.prose ol{margin:.55rem 0;padding-left:1.1rem}
.prose li{margin:.28rem 0}
.prose li::marker{color:var(--ink-3)}
.prose strong{font-weight:650}
.prose code,.prose pre{font-family:var(--mono);font-size:.84em}
.prose code{background:var(--sunk);padding:.06em .3em}
.prose pre{background:var(--sunk);border:1px solid var(--rule);padding:.8rem 1rem;overflow-x:auto}
.prose pre code{background:none;padding:0}
.prose blockquote{margin:.8rem 0;padding-left:.9rem;border-left:2px solid var(--rule-2);color:var(--ink-2)}
.prose hr{border:0;border-top:1px solid var(--rule);margin:1.6rem 0}
.prose a{border-bottom:1px solid var(--rule-2)}
.prose a:hover{border-bottom-color:var(--ink)}

/* ---------- rows ---------- */
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse}
td{padding:.5rem .9rem .5rem 0;border-bottom:1px solid var(--rule);vertical-align:baseline}
tr:last-child td{border-bottom:0}
td.d,td.w,td.r{font-family:var(--mono);font-size:.72rem;color:var(--ink-3);white-space:nowrap}
td.w{color:var(--ink-2)}
td.sum{width:100%;font-family:var(--serif);font-size:.99rem;line-height:1.45;padding-right:0}
td.sum a{border-bottom:1px solid transparent}
tr:hover td.sum a{border-bottom-color:var(--rule-2)}
td.sum strong{font-weight:650}
td.sum code{font-family:var(--mono);font-size:.82em;background:var(--sunk);padding:.05em .28em}
.flag{color:var(--declined);margin-right:.4rem;font-family:var(--mono)}

/* ---------- contents of this page ---------- */
.toc{display:none}
@media(min-width:84rem){.toc{display:block;padding:2.6rem 1.4rem 4rem;
position:sticky;top:3rem;height:calc(100vh - 3rem);overflow-y:auto}}
.toc h5{margin:0 0 .55rem;font-family:var(--sans);font-size:.72rem;font-weight:600;
letter-spacing:.06em;color:var(--ink-3)}
.toc ul{list-style:none;margin:0;padding:0}
.toc a{display:block;padding:.24rem 0;font-size:.85rem;color:var(--ink-2)}
.toc a:hover{color:var(--ink)}

/* ---------- in-page search ---------- */
.find[hidden]{display:none}
.find{margin:0 0 2.4rem}
.find .row{display:flex;align-items:center;gap:.7rem;
border:1px solid var(--rule-2);border-radius:6px;padding:0 .7rem;height:2.4rem}
.find .row:focus-within{border-color:var(--ink)}
.find input{flex:1;min-width:0;font-family:var(--sans);font-size:.94rem;color:var(--ink);
background:transparent;border:0;padding:.4rem 0}
.find input:focus{outline:none}
/* Chrome's native clear control is the only saturated pixel on the page, and
   escape already clears the field. */
.find input::-webkit-search-cancel-button,
.palbox input::-webkit-search-cancel-button{-webkit-appearance:none;appearance:none}
.find input::placeholder{color:var(--ink-3)}
.find .meta{font-family:var(--mono);font-size:.72rem;color:var(--ink-3);white-space:nowrap}
.find .scope{font-family:var(--mono);font-size:.7rem;color:var(--ink-3);
padding:.1rem .4rem;border:1px solid var(--rule);border-radius:3px}
.find .out{margin:.9rem 0 0}
.find .hint{font-family:var(--sans);font-size:.86rem;color:var(--ink-3);margin:.9rem 0 0}
.find .sug{margin:1.1rem 0 0}
.find .sug h6{margin:0 0 .45rem;font-family:var(--sans);font-size:.74rem;
font-weight:600;color:var(--ink-3)}
.find .chips{display:flex;flex-wrap:wrap;gap:.35rem;margin:0 0 1.1rem}
.find .chip{font-family:var(--mono);font-size:.75rem;color:var(--ink-2);
background:var(--sunk);border:1px solid var(--rule);border-radius:4px;
padding:.15rem .5rem;cursor:pointer}
.find .chip:hover{color:var(--ink);border-color:var(--rule-2)}

/* ---------- command palette ---------- */
.pal[hidden]{display:none}
.pal{position:fixed;inset:0;z-index:100;display:flex;justify-content:center;
align-items:flex-start;padding:12vh 1rem 1rem;background:rgba(16,16,20,.42);
backdrop-filter:blur(2px)}
.palbox{width:100%;max-width:34rem;background:var(--paper);border:1px solid var(--rule-2);
border-radius:10px;box-shadow:0 18px 50px -12px rgba(0,0,0,.34);overflow:hidden}
.palbox input{width:100%;font-family:var(--sans);font-size:1rem;color:var(--ink);
background:transparent;border:0;border-bottom:1px solid var(--rule);padding:.85rem 1rem}
.palbox input::placeholder{color:var(--ink-3)}
.palbox input:focus{outline:none}
.palist{list-style:none;margin:0;padding:.35rem;max-height:52vh;overflow-y:auto}
.palist li{border-radius:6px}
.palist a{display:flex;align-items:baseline;gap:.7rem;padding:.45rem .65rem;
font-size:.9rem;color:var(--ink-2)}
.palist li[aria-selected=true]{background:var(--sunk)}
.palist li[aria-selected=true] a{color:var(--ink)}
.palist .g{font-family:var(--mono);font-size:.68rem;color:var(--ink-3);
text-transform:uppercase;letter-spacing:.08em;min-width:5.2rem}
.palist .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.palist .n{font-family:var(--mono);font-size:.7rem;color:var(--ink-3)}
.palfoot{display:flex;gap:1rem;padding:.5rem 1rem;border-top:1px solid var(--rule);
font-family:var(--mono);font-size:.68rem;color:var(--ink-3)}
.palfoot b{font-weight:400;color:var(--ink-2)}

.empty{font-family:var(--serif);font-size:1rem;color:var(--ink-2);margin:.2rem 0;max-width:var(--measure)}
.empty code{font-family:var(--mono);font-size:.82em;background:var(--sunk);padding:.06em .3em}

/* The seam graph. Every colour is an existing token: the graph is part of the
   portal, not a widget dropped into it, and a bespoke palette here would be the
   first thing to drift when the theme changes. */
.gstat{display:flex;flex-wrap:wrap;gap:1.4rem;font-family:var(--mono);font-size:.74rem;
  color:var(--ink-3);margin:.9rem 0 1.4rem;padding-bottom:.9rem;border-bottom:1px solid var(--rule)}
.gstat b{color:var(--ink);font-weight:600}
.gwrap{margin:0 0 2rem;padding:.4rem 0}
.gstage{position:relative;border:1px solid var(--rule);border-radius:4px;overflow:hidden;background:var(--sunk)}
.gwrap svg{display:block;touch-action:none;cursor:grab}
.gwrap svg:active{cursor:grabbing}
.gbtn{font-family:var(--mono);font-size:.68rem;color:var(--ink-3);
  background:none;border:1px solid var(--rule-2);border-radius:3px;padding:.2rem .5rem;cursor:pointer}
.gbtn:hover{color:var(--ink);border-color:var(--ink-3)}
/* Filter box: same idiom as the masthead search, so it reads as part of the
   portal rather than a widget bolted onto the graph. Typing lights the nodes
   whose label or kind matches and dims the rest — the one thing hover cannot
   do. Hover answers "what touches this"; the filter answers "where is the
   thing I already have a word for". */
.gfilter{margin-left:auto;height:1.7rem;width:11rem;max-width:40vw;background:var(--sunk);
  border:1px solid var(--rule);border-radius:6px;padding:0 .55rem;font:inherit;
  font-family:var(--mono);font-size:.72rem;color:var(--ink)}
.gfilter::placeholder{color:var(--ink-3)}
.gfilter:focus-visible{outline:2px solid var(--ink);outline-offset:1px;border-color:var(--rule-2)}
.gfilter::-webkit-search-cancel-button{-webkit-appearance:none;appearance:none}
.gstat .gbtn{margin-left:.5rem}
/* Hover dims everything except the hovered node and what it touches. Reading a
   cluster means seeing its neighbourhood, and at any real size the rest is
   noise while you do that. */
.gnode,.gedge,.gseam{transition:opacity .12s}
svg.focused .gnode,svg.focused line{opacity:.13}
svg.focused .gnode.lit,svg.focused .gnode.near,svg.focused line.near{opacity:1}
/* Filtering dims on its own class so it never fights hover: a hover can still
   light a neighbourhood on top of an active filter, and a mouseout cannot wipe
   the filter out from under it. */
svg.filtering .gnode,svg.filtering line{opacity:.1}
svg.filtering .gnode.match{opacity:1}
.ginfo{position:absolute;top:10px;right:10px;width:15rem;max-width:60%;padding:.7rem .8rem;
  background:var(--paper);border:1px solid var(--rule-2);border-radius:4px;
  opacity:0;transform:translateY(-3px);transition:opacity .12s,transform .12s;pointer-events:none}
.ginfo.on{opacity:1;transform:none}
/* Pinned: a click makes the panel stay, so its links can be reached. Hover is
   transient and never needs pointer events; a pin does. */
.ginfo.pinned{pointer-events:auto;border-color:var(--ink-3)}
.ginfo .x{position:absolute;top:.45rem;right:.5rem;width:1.1rem;height:1.1rem;line-height:1;
  background:none;border:0;color:var(--ink-3);font-size:.95rem;cursor:pointer;padding:0}
.ginfo .x:hover{color:var(--ink)}
.ginfo a.open{display:inline-block;margin:.5rem 0 0;font-family:var(--mono);font-size:.66rem;
  color:var(--ink-2);border-bottom:1px solid var(--rule-2)}
.ginfo a.open:hover{color:var(--ink);border-color:var(--ink-3)}
.ginfo h5{font-family:var(--mono);font-size:.78rem;margin:0 0 .1rem;color:var(--ink)}
.ginfo p{font-family:var(--mono);font-size:.66rem;color:var(--ink-3);margin:0 0 .45rem}
.ginfo ul{list-style:none;margin:0;padding:0;max-height:11rem;overflow:auto}
.ginfo li{display:flex;justify-content:space-between;gap:.6rem;font-family:var(--mono);
  font-size:.68rem;color:var(--ink-2);padding:.12rem 0}
.ginfo li.s{color:var(--ink);font-weight:600}
.ginfo li b{color:var(--ink-3);font-weight:400}
.ginfo .go{margin:.45rem 0 0;font-size:.62rem;color:var(--ink-3)}
.gedge{stroke:var(--rule-2);opacity:.55}
/* The seam is the one thing on this page no other tool can draw, so it is the
   one thing drawn at full strength. */
.gseam{stroke:var(--ink);opacity:.95}
/* Filled, so clusters read as mass at a glance — the reason for a force layout
   at all. Sessions are size; kind is BOTH hue and shape, so the distinction
   survives greyscale and colour-blindness both — the three hues below carry it
   at a glance, and a square repo carries it again where colour cannot. */
/* Three hues, and they are the only colour in the portal.
   The rest of the product is monochrome on purpose — it is a log, and colour
   there would be decoration. A graph is the one place hue does work no other
   channel can: at a glance you see whether a cluster is people, projects or
   repos, without reading a single label. Shape still carries repos as well, so
   the distinction survives greyscale and colour-blindness both.
   Mid-luminance on purpose, so the same values read on paper and on ink. */
.gwrap{--g-who:#6f93c9;--g-project:#c8913c;--g-repo:#4f9e94}
.gnode circle,.gnode rect{fill:var(--ink-3);stroke:var(--paper);stroke-width:2;transition:fill .12s}
.g-who circle{fill:var(--g-who)}
.g-project circle{fill:var(--g-project)}
.g-repo rect{fill:var(--g-repo)}
.gnode{cursor:grab}
.gnode.held{cursor:grabbing}
.gnode.held circle,.gnode.held rect{fill:var(--ink)}
.gnode text{pointer-events:none}
.gnode text{font-family:var(--mono);font-size:.7rem;fill:var(--ink-3)}
.gnode:hover circle,.gnode:hover rect{fill:var(--ink)}
.gnode:hover text{fill:var(--ink)}
.gkey{display:flex;flex-wrap:wrap;gap:1.3rem;font-family:var(--mono);font-size:.68rem;
  color:var(--ink-3);margin-top:.7rem}
.gkey .k{display:flex;align-items:center;gap:.45rem}
.gkey .k::before{content:"";width:10px;height:10px;border-radius:50%;background:var(--ink-3)}
.gkey .k-who::before{background:var(--g-who)}
.gkey .k-project::before{background:var(--g-project)}
.gkey .k-repo::before{background:var(--g-repo)}
.gkey .k-repo::before{border-radius:2px}
.gkey .k-seam::before{border-radius:0;width:18px;height:2px;background:var(--ink)}
/* The hint is prose, not a key: a swatch in front of it reads as a fourth category. */
.gkey .k-hint{margin-left:auto;color:var(--ink-3);opacity:.8}
.gkey .k-hint::before{display:none}
.gtab{border-collapse:collapse;font-family:var(--mono);font-size:.76rem;margin:.6rem 0 1.4rem}
.gtab th{text-align:left;font-weight:500;color:var(--ink-3);border-bottom:1px solid var(--rule);
  padding:.3rem 1.2rem .3rem 0}
.gtab td{padding:.3rem 1.2rem .3rem 0;border-bottom:1px solid var(--rule);color:var(--ink-2)}
`;

/**
 * Theme persistence, and the command palette.
 *
 * The palette filters a list the server already had — every project, person,
 * month and company document — so opening it costs no request and typing costs
 * no round trip. Anything it cannot answer locally falls through to full-text
 * search, which is the one thing that genuinely needs the server.
 */
const CLIENT_JS = String.raw`(function(){
var r=document.documentElement,K="nacre-theme";
try{var s=localStorage.getItem(K);if(s)r.setAttribute("data-theme",s)}catch(e){}
document.addEventListener("click",function(e){
  var b=e.target.closest("[data-tgl]");if(!b)return;
  var cur=r.getAttribute("data-theme")||(matchMedia("(prefers-color-scheme:dark)").matches?"dark":"light");
  var next=cur==="dark"?"light":"dark";r.setAttribute("data-theme",next);
  try{localStorage.setItem(K,next)}catch(e2){}});

var SK="nacre-side";
try{var sv=localStorage.getItem(SK);if(sv)r.setAttribute("data-side",sv)}catch(e){}
function side(next){r.setAttribute("data-side",next);try{localStorage.setItem(SK,next)}catch(e){}}
function toggleSide(){side(r.getAttribute("data-side")==="off"?"on":"off")}
document.addEventListener("click",function(e){
  if(e.target.closest("[data-side-tgl]")){e.preventDefault();toggleSide()}});

var pal=document.getElementById("pal"),inp=document.getElementById("palq"),
    list=document.getElementById("pallist"),
    items=JSON.parse(document.getElementById("paldata").textContent||"[]"),
    sel=0,shown=[];

function score(hay,q){
  hay=hay.toLowerCase();
  if(!q)return 1;
  var i=hay.indexOf(q);
  if(i===0)return 1000;
  if(i>0)return 500-i;
  // subsequence: every character of the query in order
  var k=0;for(var n=0;n<hay.length&&k<q.length;n++)if(hay[n]===q[k])k++;
  return k===q.length?100:0;
}
function render(){
  var q=(inp.value||"").trim().toLowerCase();
  shown=items.map(function(it){return {it:it,s:score(it.t+" "+it.g,q)}})
    .filter(function(x){return x.s>0})
    .sort(function(a,b){return b.s-a.s}).slice(0,40).map(function(x){return x.it});
  if(q)shown.push({t:'Search all logs for "'+inp.value.trim()+'"',g:"search",h:"/search?q="+encodeURIComponent(inp.value.trim())});
  if(sel>=shown.length)sel=Math.max(0,shown.length-1);
  list.innerHTML=shown.map(function(it,n){
    return '<li aria-selected="'+(n===sel)+'"><a href="'+it.h+'">'+
      '<span class="g">'+it.g+'</span><span class="t">'+it.t+'</span>'+
      (it.n!=null?'<span class="n">'+it.n+'</span>':'')+'</a></li>';}).join("");
  var on=list.children[sel];if(on&&on.scrollIntoView)on.scrollIntoView({block:"nearest"});
}
function open(){pal.hidden=false;inp.value="";sel=0;render();inp.focus()}
function close(){pal.hidden=true;inp.blur()}
function go(){var it=shown[sel];if(it)location.href=it.h}

document.addEventListener("keydown",function(e){
  var typing=/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
  if((e.metaKey||e.ctrlKey)&&e.key==="b"){e.preventDefault();toggleSide();return}
  if(((e.metaKey||e.ctrlKey)&&e.key==="k")||(e.key==="/"&&!typing)){e.preventDefault();open();return}
  if(pal.hidden)return;
  if(e.key==="Escape"){e.preventDefault();close()}
  else if(e.key==="ArrowDown"){e.preventDefault();sel=Math.min(sel+1,shown.length-1);render()}
  else if(e.key==="ArrowUp"){e.preventDefault();sel=Math.max(sel-1,0);render()}
  else if(e.key==="Enter"){e.preventDefault();go()}
});
inp.addEventListener("input",function(){sel=0;render()});
list.addEventListener("mousemove",function(e){
  var li=e.target.closest("li");if(!li)return;
  var n=[].indexOf.call(list.children,li);if(n!==sel){sel=n;render()}});
pal.addEventListener("mousedown",function(e){if(e.target===pal)close()});

/* ---- in-page project search ---- */
var find=document.getElementById("find");
if(find){
  var fq=document.getElementById("findq"),fout=document.getElementById("findout"),
      fmeta=document.getElementById("findmeta"),overview=document.getElementById("overview"),
      proj=find.getAttribute("data-project"),tabs=document.querySelectorAll("[data-tab]"),timer;

  function tab(name){
    var searching=name==="search";
    find.hidden=!searching;
    if(overview)overview.hidden=searching;
    tabs.forEach(function(t){t.classList.toggle("on",t.getAttribute("data-tab")===name)});
    if(searching){fq.focus();if(!fq.value.trim())idle()}
  }
  tabs.forEach(function(t){t.addEventListener("click",function(e){
    var n=t.getAttribute("data-tab");if(!n)return;e.preventDefault();tab(n);
    history.replaceState(null,"",n==="search"?"#search":location.pathname);});});

  function esc(x){return String(x).replace(/[&<>"]/g,function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
  // The same inline subset the server renders. Rows built here were showing
  // **bold** as asterisks while the server-rendered rows above them did not,
  // which made one list look like a different product from the other.
  function md(x){return esc(x)
    .replace(/\u0060([^\u0060]+)\u0060/g,"<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g,"$1<em>$2</em>")}

  var fd={people:[],repos:[],recent:[]};
  try{fd=JSON.parse(document.getElementById("finddata").textContent||"{}")}catch(e){}

  function chips(label,arr){
    if(!arr.length)return"";
    return '<div class="sug"><h6>'+label+'</h6><div class="chips">'+
      arr.map(function(x){return '<button class="chip" data-q="'+esc(x)+'" type="button">'+esc(x)+'</button>'}).join("")+
      '</div></div>';
  }
  function idle(){
    fmeta.textContent="";
    var rec=fd.recent.length
      ? '<div class="sug"><h6>Recent sessions</h6><div class="scroll"><table>'+
        fd.recent.map(function(h){return '<tr><td class="d">'+esc(h.d)+'</td><td class="w">'+esc(h.w)+
          '</td><td class="sum"><a href="'+h.h+'">'+md(h.l)+'</a></td></tr>'}).join("")+
        '</table></div></div>'
      : "";
    fout.innerHTML=chips("Repos",fd.repos)+chips("People",fd.people)+rec;
  }

  function run(){
    var q=fq.value.trim();
    if(!q){idle();return}
    fetch("/x/search?q="+encodeURIComponent(q)+"&project="+encodeURIComponent(proj))
      .then(function(r){return r.json()})
      .then(function(d){
        fmeta.textContent=d.total+" hit"+(d.total===1?"":"s")+" · "+d.sessions+" session"+(d.sessions===1?"":"s");
        if(!d.rows.length){fout.innerHTML='<p class="hint">No hits for “'+esc(q)+'” in '+esc(proj)+'.</p>';return}
        fout.innerHTML='<div class="scroll"><table>'+d.rows.map(function(h){
          return '<tr><td class="d">'+esc(h.d)+'</td><td class="w">'+esc(h.w)+'</td>'+
            '<td class="sum">'+(h.a?'<span class="flag">▌</span>':"")+
            '<a href="'+h.h+'">'+md(h.l)+'</a></td></tr>';}).join("")+'</table></div>'+
          (d.total>d.rows.length?'<p class="hint">Showing '+d.rows.length+' of '+d.total+
            ' — at most 3 per session. <a href="/search?q='+encodeURIComponent(q)+
            '&project='+encodeURIComponent(proj)+'">Open the full results</a>.</p>':"");
      })
      .catch(function(){fout.innerHTML='<p class="hint">Could not reach the memory.</p>'});
  }
  fout.addEventListener("click",function(e){
    var c=e.target.closest(".chip");if(!c)return;
    fq.value=c.getAttribute("data-q");fq.focus();run();});
  fq.addEventListener("input",function(){clearTimeout(timer);timer=setTimeout(run,120)});
  fq.addEventListener("keydown",function(e){
    if(e.key==="Escape"){e.preventDefault();if(fq.value){fq.value="";run()}else tab("overview")}});

  // Last, not first: opening the panel renders the suggestions, and those need
  // the data and the helpers above to exist. A var declaration hoists; the
  // value assigned to it does not.
  if(location.hash==="#search")tab("search");
}
document.addEventListener("click",function(e){if(e.target.closest("[data-pal]")){e.preventDefault();open()}});

/* The seam graph: a live force simulation, pan, zoom, drag and hover-to-focus.
   Only runs on the graph page; every other page stops at the first line.

   The layout runs HERE rather than on the server, because a settled picture and
   a living one answer different questions: dragging a node has to make the
   graph respond, or a cluster you did not expect cannot be pulled apart and
   read. The server still computes the starting positions, so the first paint is
   deterministic and the simulation begins somewhere sensible instead of from a
   random cloud.

   The forces are the ones d3-force uses and Quartz configures — charge, link,
   centre, collide — written out rather than imported, because a graph library
   would be this package's first runtime dependency and CI fails the build if
   one appears. */
var G=document.getElementById("seamsvg");
if(G){(function(){
  var D;try{D=JSON.parse(document.getElementById("seamdata").textContent)}catch(e){return}
  var view=document.getElementById("seamview"),info=document.getElementById("seaminfo");
  var N=D.n,E=D.e,W=D.W,H=D.H;
  var els=[],labels=[],lines=[];
  for(var i=0;i<N.length;i++){els.push(document.getElementById("sn"+i));labels.push(els[i].querySelector("text"))}
  for(var j=0;j<E.length;j++)lines.push(document.getElementById("se"+j));

  for(i=0;i<N.length;i++){N[i].vx=0;N[i].vy=0;N[i].fx=null;N[i].fy=null}

  var cam={x:0,y:0,k:1},alpha=1,alphaTarget=0,dragNode=null,panning=null,moved=false,raf=0;
  /* The natural edge length for this canvas and this many nodes — the same
     figure the server layout uses, so both settle at the same scale. */
  var K=Math.sqrt(W*H/Math.max(1,N.length))*0.62;
  var maxW=1;for(j=0;j<E.length;j++)maxW=Math.max(maxW,E[j].w);

  function tick(){
    alpha+=(alphaTarget-alpha)*0.0228;

    /* charge: k*k/d, the Fruchterman-Reingold form. An earlier version used
       k/d*d, which falls off so much faster than the springs pull that the
       whole graph collapsed to a clump in the middle of an empty canvas —
       measured at 30% of the width before this was fixed. */
    for(var a=0;a<N.length;a++)for(var b=a+1;b<N.length;b++){
      var p=N[a],q=N[b],dx=q.x-p.x,dy=q.y-p.y,d=Math.sqrt(dx*dx+dy*dy);
      if(d<1)d=1;
      var f=-(K*K)/d*0.10*alpha;
      var ux=dx/d*f,uy=dy/d*f;
      p.vx+=ux;p.vy+=uy;q.vx-=ux;q.vy-=uy}

    /* link: a spring per edge, stiffer when more sessions produced it, so
       repos worked on together end up close. That is the page's claim,
       enforced by the physics rather than stated in a caption. */
    for(j=0;j<E.length;j++){
      var e=E[j],s=N[e.s],t=N[e.t];
      var lx=t.x-s.x,ly=t.y-s.y,l=Math.sqrt(lx*lx+ly*ly)||1;
      var rest=(e.m?0.42:0.72)*K;
      var k=(0.22+(e.w/maxW)*0.34)*alpha;
      var mv=(l-rest)/l*k;
      var mx=lx*mv*0.5,my=ly*mv*0.5;
      s.vx+=mx;s.vy+=my;t.vx-=mx;t.vy-=my}

    /* centre: a weak pull home, so nothing drifts off into the margin */
    for(i=0;i<N.length;i++){N[i].vx+=(W/2-N[i].x)*0.006*alpha;N[i].vy+=(H/2-N[i].y)*0.006*alpha}

    /* collide: the force Quartz runs three iterations of, and the reason its
       nodes never sit on top of each other */
    for(var it=0;it<2;it++)for(a=0;a<N.length;a++)for(b=a+1;b<N.length;b++){
      var P=N[a],Q=N[b],cx=Q.x-P.x,cy=Q.y-P.y,cd=Math.sqrt(cx*cx+cy*cy)||0.01;
      var min=P.r+Q.r+16;
      if(cd<min){var push=(min-cd)/cd*0.5;
        var px=cx*push,py=cy*push;
        P.x-=px;P.y-=py;Q.x+=px;Q.y+=py}}

    for(i=0;i<N.length;i++){var n=N[i];
      if(n.fx!==null){n.x=n.fx;n.y=n.fy;n.vx=0;n.vy=0}
      else{n.vx*=0.62;n.vy*=0.62;n.x+=n.vx;n.y+=n.vy}}

    draw();
    if(alpha>0.002||dragNode)raf=requestAnimationFrame(tick);else raf=0}

  function draw(){
    for(var i=0;i<N.length;i++)els[i].setAttribute("transform","translate("+N[i].x.toFixed(1)+" "+N[i].y.toFixed(1)+")");
    for(var j=0;j<E.length;j++){var e=E[j],s=N[e.s],t=N[e.t],ln=lines[j];
      ln.setAttribute("x1",s.x.toFixed(1));ln.setAttribute("y1",s.y.toFixed(1));
      ln.setAttribute("x2",t.x.toFixed(1));ln.setAttribute("y2",t.y.toFixed(1))}}

  function kick(t){alphaTarget=t===undefined?0:t;if(alpha<0.35)alpha=0.35;if(!raf)raf=requestAnimationFrame(tick)}

  function applyCam(){
    view.setAttribute("transform","translate("+cam.x+" "+cam.y+") scale("+cam.k+")");
    /* Labels shrink with zoom rather than with the graph, and fade out when
       zoomed far enough that they would only overlap each other. */
    var inv=1/cam.k,op=cam.k<0.55?0:1;
    for(var i=0;i<labels.length;i++){
      labels[i].setAttribute("transform","scale("+inv.toFixed(3)+")");
      labels[i].style.opacity=op}}

  function pt(ev){var r=G.getBoundingClientRect();
    return{x:((ev.clientX-r.left)/r.width*W-cam.x)/cam.k,y:((ev.clientY-r.top)/r.height*H-cam.y)/cam.k}}

  G.addEventListener("wheel",function(ev){ev.preventDefault();
    var r=G.getBoundingClientRect();
    var sx=(ev.clientX-r.left)/r.width*W,sy=(ev.clientY-r.top)/r.height*H;
    var k=Math.min(5,Math.max(.3,cam.k*(ev.deltaY<0?1.14:1/1.14)));
    cam.x=sx-(sx-cam.x)*(k/cam.k);cam.y=sy-(sy-cam.y)*(k/cam.k);cam.k=k;applyCam()},{passive:false});

  G.addEventListener("pointerdown",function(ev){
    /* Remember which node was pressed. Pin/unpin is resolved from THIS index at
       pointerup, never re-hit-tested from the cursor: while the force sim is
       live the node drifts, so the click event lands on empty canvas and a
       cursor-based pin would miss the very node the user pressed. Not kicking
       here also keeps a bare press from nudging the graph before the release. */
    moved=false;downIdx=-1;var a=ev.target.closest(".gnode");
    if(a){downIdx=+a.getAttribute("data-i");dragNode=N[downIdx];dragNode.fx=dragNode.x;dragNode.fy=dragNode.y;
      a.classList.add("held")}
    else{var r=G.getBoundingClientRect();
      panning={mx:(ev.clientX-r.left)/r.width*W,my:(ev.clientY-r.top)/r.height*H,x:cam.x,y:cam.y}}
    G.setPointerCapture(ev.pointerId)});

  G.addEventListener("pointermove",function(ev){
    if(!dragNode&&!panning)return;moved=true;
    if(panning){var r=G.getBoundingClientRect();
      cam.x=panning.x+((ev.clientX-r.left)/r.width*W-panning.mx);
      cam.y=panning.y+((ev.clientY-r.top)/r.height*H-panning.my);applyCam();return}
    var p=pt(ev);dragNode.fx=p.x;dragNode.fy=p.y;kick(0.3)});

  function release(ev){
    if(dragNode){dragNode.fx=null;dragNode.fy=null;
      var h=G.querySelector(".held");if(h)h.classList.remove("held");
      dragNode=null;kick(0)}
    panning=null;try{G.releasePointerCapture(ev.pointerId)}catch(_){}
    /* A press that never moved is a click. Toggle the pin on the node captured
       at pointerdown; a press that started on empty canvas dismisses whatever
       is pinned. showNode/clearNode/pinned/downIdx are all in this closure and
       defined by the time any pointer event fires. */
    if(!moved){
      if(downIdx>=0){var was=pinned;pinned=-1;clearNode();
        if(was!==downIdx){pinned=downIdx;showNode(downIdx,true)}}
      else if(pinned>=0){pinned=-1;clearNode()}}
    downIdx=-1;}
  G.addEventListener("pointerup",release);G.addEventListener("pointercancel",release);
  var near=[];for(i=0;i<N.length;i++)near.push([]);
  for(j=0;j<E.length;j++){near[E[j].s].push([E[j].t,j,E[j].w,E[j].m]);near[E[j].t].push([E[j].s,j,E[j].w,E[j].m])}

  function esc(s){return String(s).replace(/[&<>"]/g,function(c){
    return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}

  /* Hover and pin light the same neighbourhood and fill the same panel, so both
     go through showNode. The only difference is that a pin keeps pointer
     events, gains a close control, and swaps the "click to pin" hint for a link
     to the node's full page — the panel is transient on hover and durable on a
     click. */
  var pinned=-1,downIdx=-1;
  function showNode(idx,pin){
    var a=els[idx];G.classList.add("focused");a.classList.add("lit");
    var list=near[idx],rows="";
    for(var q=0;q<list.length;q++){
      els[list[q][0]].classList.add("near");lines[list[q][1]].classList.add("near");
      rows+="<li"+(list[q][3]?' class="s"':"")+">"+esc(N[list[q][0]].l)+"<b>"+list[q][2]+"</b></li>"}
    if(info){var n=N[idx],href=a.getAttribute("href")||"";
      info.innerHTML=(pin?'<button class="x" type="button" aria-label="close">×</button>':"")
        +"<h5>"+esc(n.l)+"</h5><p>"+esc(n.t)+" · "+n.s+" session"+(n.s===1?"":"s")+"</p><ul>"
        +(rows||"<li>nothing yet</li>")+"</ul>"
        +(pin?'<a class="open" href="'+esc(href)+'">open full page →</a>'
             :'<p class="go">click to pin</p>');
      info.classList.add("on");info.classList.toggle("pinned",!!pin)}}
  function clearNode(){
    G.classList.remove("focused");
    var lit=G.querySelectorAll(".lit,.near");
    for(var q=0;q<lit.length;q++)lit[q].classList.remove("lit","near");
    if(info)info.classList.remove("on","pinned")}

  /* While a node is pinned, hover is inert: the pinned panel is what the reader
     is looking at, and letting a stray hover repaint it would be the panel
     moving on its own. */
  G.addEventListener("mouseover",function(ev){
    if(pinned>=0)return;var a=ev.target.closest(".gnode");if(!a)return;
    showNode(+a.getAttribute("data-i"),false)});
  G.addEventListener("mouseout",function(ev){
    if(pinned>=0)return;
    if(ev.relatedTarget&&ev.relatedTarget.closest&&ev.relatedTarget.closest(".gnode"))return;
    clearNode()});

  /* Pin/unpin is handled at pointerup (above). The click event exists only to
     stop a node's <a> link navigating away on a mouse click — the pin, not a
     page load, is the response. A keyboard activation (Enter on a focused node)
     reports detail===0 and is left to navigate, so the graph stays reachable
     without a pointer. */
  G.addEventListener("click",function(ev){if(ev.detail!==0)ev.preventDefault()},true);
  /* The close button lives in the panel, a sibling of the svg, so its click
     never reaches the handler above; dismiss it here. */
  if(info)info.addEventListener("click",function(ev){
    if(ev.target.closest(".x")){pinned=-1;clearNode()}});

  /* Filter: light every node whose label or kind contains the query and dim the
     rest. Independent of hover and pin — a filtered graph still hovers and
     still pins. An empty box clears the filter entirely. */
  var fbox=document.getElementById("seamfilter");
  if(fbox)fbox.addEventListener("input",function(){
    var q=fbox.value.trim().toLowerCase();
    if(!q){G.classList.remove("filtering");
      for(var i=0;i<N.length;i++)els[i].classList.remove("match");return}
    G.classList.add("filtering");
    for(var i=0;i<N.length;i++){
      var n=N[i],hit=n.l.toLowerCase().indexOf(q)>=0||String(n.t).toLowerCase().indexOf(q)>=0;
      els[i].classList.toggle("match",hit)}});

  var rst=document.getElementById("seamreset");
  if(rst)rst.addEventListener("click",function(){
    cam={x:0,y:0,k:1};applyCam();
    for(var q=0;q<N.length;q++){N[q].x=D.n[q].x0;N[q].y=D.n[q].y0;N[q].vx=0;N[q].vy=0;N[q].fx=null;N[q].fy=null}
    /* Reset means a clean slate: drop the filter and any pin too. */
    if(fbox){fbox.value="";G.classList.remove("filtering");
      for(q=0;q<N.length;q++)els[q].classList.remove("match")}
    pinned=-1;clearNode();
    kick(0)});

  applyCam();kick(0);
})()}
})();`;

const page = (title: string, body: string): string => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} · nacre</title><style>${CSS}</style></head><body>${body}<script>${CLIENT_JS}</script></body></html>`;

const link = (href: string, text: string): string => `<a href="${escape(href)}">${escape(text)}</a>`;

/** A heading that the on-this-page rail can point at. */
interface Anchor { id: string; label: string }
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function section(label: string, count: string, inner: string, anchors?: Anchor[]): string {
  const id = slug(label);
  anchors?.push({ id, label });
  return `<section class="sec" id="${id}">
    <h2>${escape(label)}${count ? `<span class="cnt">${escape(count)}</span>` : ""}</h2>
    ${inner}
  </section>`;
}

function rail(idx: Index, active: Active = {}): string {
  const group = (label: string, entries: Record<string, number>, prefix: string, key: keyof Active): string => {
    const rows = Object.entries(entries).sort(([a], [b]) => a.localeCompare(b));
    if (!rows.length) return `<h4>${label}</h4><ul><li><span class="none">none yet</span></li></ul>`;
    return `<h4>${label}</h4><ul>${rows
      .map(([name, n]) => `<li class="${active[key] === name ? "on" : ""}">
        <a href="${prefix}${encodeURIComponent(name)}">${escape(name)}<span class="n">${n}</span></a></li>`)
      .join("")}</ul>`;
  };
  return `<nav class="side">
    <div class="sidehead">
      <span class="sidelbl">Contents</span>
      <button class="sidetgl" data-side-tgl type="button"
        title="Hide the sidebar (⌘B)" aria-label="Hide sidebar"><span class="bar"></span></button>
    </div>
    <h4>Company</h4>
    <ul>
      <li class="${active.company === "_company" ? "on" : ""}"><a href="/c/_company">context</a></li>
      <li class="${active.company === "_standards" ? "on" : ""}"><a href="/c/_standards">standards</a></li>
      <li class="${active.section === "graph" ? "on" : ""}"><a href="/graph">the seam</a></li>
    </ul>
    ${group("Projects", idx.projects, "/p/", "project")}
    ${group("People", idx.people, "/who/", "who")}
    ${group("Time", idx.months, "/t/", "month")}
  </nav>`;
}

/** Every navigable target, for the palette to filter without a round trip. */
function paletteData(idx: Index): string {
  const rows: { t: string; g: string; h: string; n?: number }[] = [
    { t: "Company context", g: "company", h: "/c/_company" },
    { t: "Engineering standards", g: "company", h: "/c/_standards" },
  ];
  for (const [n, c] of Object.entries(idx.projects)) rows.push({ t: n, g: "project", h: `/p/${encodeURIComponent(n)}`, n: c });
  for (const [n, c] of Object.entries(idx.people)) rows.push({ t: n, g: "person", h: `/who/${encodeURIComponent(n)}`, n: c });
  for (const [n, c] of Object.entries(idx.months)) rows.push({ t: n, g: "month", h: `/t/${encodeURIComponent(n)}`, n: c });
  // Escaped as JSON inside a <script type="application/json">, so the only
  // sequence that could break out is the closing tag itself.
  return JSON.stringify(rows).replace(/</g, "\\u003c");
}

const crumbs = (trail: [string, string | null][]): string =>
  `<nav class="crumbs">${trail
    .map(([label, href], i) =>
      `${i ? '<span class="sl">/</span>' : ""}${href ? link(href, label) : `<span>${escape(label)}</span>`}`)
    .join("")}</nav>`;

/**
 * Force-directed layout, Fruchterman-Reingold, ~25 lines and no dependency.
 *
 * The first version of this page used three fixed columns and the commit
 * claimed a simulation "would be this package's first runtime dependency". That
 * conflated the algorithm with a library. The algorithm is repulsion between
 * every pair, attraction along every edge, and a cooling schedule; a graph
 * library is what would have been the dependency.
 *
 * The column version was also wrong on its own terms. Bipartite columns show
 * membership — who is in which group — when the question this page exists to
 * answer is which things cluster together. Clusters are the shape of the
 * answer, and columns cannot express one.
 *
 * Deterministic despite being a simulation: seeds are placed on a golden-angle
 * spiral by index rather than at random, so the same memory always draws the
 * same picture and a reader can return to a layout they recognise. O(n squared)
 * per tick is fine because node count tracks headcount, not session volume.
 */
function layout(g: Graph, W: number, H: number): Map<string, { x: number; y: number }> {
  const n = g.nodes.length;
  const pos = new Map<string, { x: number; y: number }>();
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  g.nodes.forEach((node, i) => {
    const r = (Math.min(W, H) / 2.6) * Math.sqrt((i + 0.5) / n);
    pos.set(node.id, { x: W / 2 + r * Math.cos(i * GOLDEN), y: H / 2 + r * Math.sin(i * GOLDEN) });
  });
  if (n < 2) return pos;

  const k = Math.sqrt((W * H) / n) * 0.62;
  const maxW = Math.max(1, ...g.edges.map((e) => e.weight));
  let temp = Math.min(W, H) / 6;

  for (let step = 0; step < 320; step++) {
    const disp = new Map(g.nodes.map((node) => [node.id, { x: 0, y: 0 }]));

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = pos.get(g.nodes[i]!.id)!, b = pos.get(g.nodes[j]!.id)!;
        let dx = a.x - b.x, dy = a.y - b.y;
        let d = Math.hypot(dx, dy);
        if (d < 0.01) { dx = ((i * 37) % 13) - 6; dy = ((j * 29) % 13) - 6; d = Math.hypot(dx, dy) || 1; }
        const force = (k * k) / d;
        const da = disp.get(g.nodes[i]!.id)!, db = disp.get(g.nodes[j]!.id)!;
        da.x += (dx / d) * force; da.y += (dy / d) * force;
        db.x -= (dx / d) * force; db.y -= (dy / d) * force;
      }
    }

    for (const e of g.edges) {
      const a = pos.get(e.a), b = pos.get(e.b);
      if (!a || !b) continue;
      const dx = a.x - b.x, dy = a.y - b.y;
      const d = Math.hypot(dx, dy) || 0.01;
      // Heavier edges pull harder, so repos worked on together sit together —
      // which is the entire claim this page makes, expressed as geometry.
      const force = ((d * d) / k) * (0.5 + (e.weight / maxW) * 0.9);
      const da = disp.get(e.a)!, db = disp.get(e.b)!;
      da.x -= (dx / d) * force; da.y -= (dy / d) * force;
      db.x += (dx / d) * force; db.y += (dy / d) * force;
    }

    for (const node of g.nodes) {
      const p = pos.get(node.id)!, d = disp.get(node.id)!;
      const len = Math.hypot(d.x, d.y) || 1;
      p.x += (d.x / len) * Math.min(len, temp);
      p.y += (d.y / len) * Math.min(len, temp);
      // A weak pull to centre keeps loose nodes from drifting to the margin,
      // where they read as unimportant rather than merely unconnected.
      p.x += (W / 2 - p.x) * 0.008;
      p.y += (H / 2 - p.y) * 0.008;
    }
    temp *= 0.975;
  }

  // Fit to the box: the simulation has no idea what size the viewport is.
  const xs = [...pos.values()].map((p) => p.x), ys = [...pos.values()].map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const PAD = 76;
  const sx = (W - PAD * 2) / Math.max(1, x1 - x0), sy = (H - PAD * 2) / Math.max(1, y1 - y0);
  const s = Math.min(sx, sy);
  for (const p of pos.values()) {
    p.x = PAD + (p.x - x0) * s + (W - PAD * 2 - (x1 - x0) * s) / 2;
    p.y = PAD + (p.y - y0) * s + (H - PAD * 2 - (y1 - y0) * s) / 2;
  }
  return pos;
}

/**
 * The seam graph, drawn server-side as SVG.
 *
 * Carries no log content. Nodes and counts only; every node links to the page
 * that holds the actual writing. The graph is an index, not a summary, so it
 * cannot grow into the unbounded assembled list that this project already
 * rejected once.
 */
function renderGraph(g: Graph): string {
  const W = 880, H = Math.max(430, Math.min(720, 300 + g.nodes.length * 26));
  const pos = layout(g, W, H);

  // Ids by index rather than by name: a repo may be called anything, and
  // getElementById is the only lookup the drag loop can afford per frame.
  const order = new Map(g.nodes.map((n, i) => [n.id, i]));
  const nodeId = (id: string): string => `sn${order.get(id) ?? 0}`;
  const edgeId = (i: number): string => `se${i}`;

  const maxW = Math.max(1, ...g.edges.map((e) => e.weight));
  const radius = (n: GraphNode): number => 4.5 + Math.min(9, Math.sqrt(n.sessions) * 3);

  const lines = g.edges
    .map((e, i) => {
      const a = pos.get(e.a), b = pos.get(e.b);
      if (!a || !b) return "";
      const w = 0.8 + (e.weight / maxW) * 2.6;
      return `<line id="${edgeId(i)}" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}"`
        + ` x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"`
        + ` class="${e.seam ? "gseam" : "gedge"}" style="stroke-width:${w.toFixed(1)}">`
        + `<title>${escape(e.a.split(":")[1] as string)} and ${escape(e.b.split(":")[1] as string)}`
        + ` — ${e.weight} session${e.weight === 1 ? "" : "s"}</title></line>`;
    })
    .join("");

  // Glyphs sit at the origin and the whole group is translated each frame, so a
  // tick is one attribute write per node instead of three.
  const dots = g.nodes
    .map((n, i) => {
      const p = pos.get(n.id);
      if (!p) return "";
      const r = radius(n);
      // Kind is carried by hue (the CSS colours g-who/g-project/g-repo) and by
      // SHAPE as well: a square repo stays distinguishable in both themes and
      // for anyone who cannot separate the hues.
      const glyph = n.kind === "repo"
        ? `<rect x="${(-r).toFixed(1)}" y="${(-r).toFixed(1)}" width="${(r * 2).toFixed(1)}"`
          + ` height="${(r * 2).toFixed(1)}" rx="2"></rect>`
        : `<circle cx="0" cy="0" r="${r.toFixed(1)}"></circle>`;
      return `<a href="${n.href}" id="${nodeId(n.id)}" data-i="${i}" class="gnode g-${n.kind}"`
        + ` transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})">${glyph}`
        + `<text y="${(r + 14).toFixed(1)}" text-anchor="middle">${escape(n.label)}</text></a>`;
    })
    .join("");

  const seams = g.edges.filter((e) => e.seam);
  const pct = g.logs ? Math.round((g.crossRepo / g.logs) * 100) : 0;

  /**
   * The simulation's input: nodes with a seed position, edges by index.
   *
   * Sent with the page rather than fetched. A round trip per hover or per tick
   * would make the read path chatty, and the whole graph serialises smaller
   * than a single session log.
   *
   * `x0`/`y0` are the server's settled positions. They are the starting state
   * and what "reset view" returns to, which is what keeps a deterministic first
   * paint even though the layout is alive once it loads.
   */
  const KIND: Record<GraphNode["kind"], string> = { who: "person", project: "project", repo: "repo" };
  const seamData = JSON.stringify({
    W, H,
    n: g.nodes.map((n) => {
      const p = pos.get(n.id) ?? { x: W / 2, y: H / 2 };
      return {
        l: n.label, t: KIND[n.kind], s: n.sessions, r: radius(n),
        x: Math.round(p.x), y: Math.round(p.y),
        x0: Math.round(p.x), y0: Math.round(p.y),
      };
    }),
    e: g.edges.map((e) => ({
      s: order.get(e.a) ?? 0, t: order.get(e.b) ?? 0, w: e.weight, m: e.seam ? 1 : 0,
    })),
  }).replace(/</g, "\\u003c");

  return `<h1>The seam</h1>
  <p class="lede">Who works where, and which repos a single session touched together.
  Nothing here is inferred: every line is read from the <code>project</code>,
  <code>who</code> and <code>repos</code> fields a log already carries.</p>

  <div class="gstat">
    <span><b>${g.nodes.length}</b> nodes</span>
    <span><b>${g.edges.length}</b> edges</span>
    <span><b>${g.logs}</b> sessions</span>
    <span><b>${g.crossRepo}</b> touched 2+ repos${g.logs ? ` · ${pct}%` : ""}</span>
    <input id="seamfilter" class="gfilter" type="search" placeholder="filter nodes…"
      autocomplete="off" spellcheck="false" aria-label="Filter graph nodes by name or kind">
    <button id="seamreset" class="gbtn" type="button">reset view</button>
  </div>

  <figure class="gwrap">
    <div class="gstage">
      <svg id="seamsvg" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img"
        aria-label="Entity graph: ${g.nodes.length} nodes, ${g.edges.length} edges">
        <g id="seamview"><g>${lines}</g><g>${dots}</g></g>
      </svg>
      <aside id="seaminfo" class="ginfo" aria-live="polite"></aside>
    </div>
    <figcaption class="gkey">
      <span class="k k-who">people</span>
      <span class="k k-project">projects</span>
      <span class="k k-repo">repos (square)</span>
      <span class="k k-seam">repos one session touched together</span>
      <span class="k k-hint">drag to pan · scroll to zoom · drag a node to pull it out</span>
    </figcaption>
  </figure>
  <script type="application/json" id="seamdata">${seamData}</script>

  <h2 id="seams">The cross-repo seam</h2>
  <p>These pairs are joined only because one session named both. A tool scoped to
  a single repository cannot draw them: it never sees the second repo.</p>
  ${seams.length
    ? `<table class="gtab"><thead><tr><th>repo</th><th>repo</th><th>sessions</th></tr></thead><tbody>`
      + seams.map((e) =>
        `<tr><td>${escape(e.a.split(":")[1] as string)}</td>`
        + `<td>${escape(e.b.split(":")[1] as string)}</td>`
        + `<td>${e.weight}</td></tr>`).join("")
      + `</tbody></table>`
    : `<p class="empty">No session has named two repos yet. Either this project is
       genuinely one repository, or <code>repos:</code> is not being filled in —
       and those are worth telling apart before reading anything into it.</p>`}`;
}

const shell = (
  memory: string, clone: string, idx: Index, active: Active,
  title: string, inner: string, anchors: Anchor[] = [],
): string => page(title, `
  <header class="top">
    <button class="sidetgl" data-side-tgl type="button" title="Show or hide the sidebar (⌘B)"
      aria-label="Toggle sidebar"><span class="bar"></span></button>
    <a class="brand" href="/">nacre</a>
    <span class="sep">/</span>
    <span class="repo">${escape(basename(memory))} · pulled ${escape(clone)}</span>
    <span class="grow"></span>
    <button class="qbox" data-pal type="button" aria-label="Search and jump to">
      <span class="qph">Search or jump to…</span><kbd>⌘K</kbd>
    </button>
    <button class="tgl" data-tgl type="button" title="Light or dark theme" aria-label="Toggle theme"
      ><span class="moon">☾</span><span class="sun">☀</span></button>
  </header>
  <div class="frame">
    ${rail(idx, active)}
    <main class="main">${inner}</main>
    ${anchors.length
      ? `<aside class="toc"><h5>On this page</h5><ul>${anchors
          .map((a) => `<li><a href="#${a.id}">${escape(a.label)}</a></li>`).join("")}</ul></aside>`
      : `<aside class="toc"></aside>`}
  </div>
  <div class="pal" id="pal" hidden role="dialog" aria-modal="true" aria-label="Search and jump to">
    <div class="palbox">
      <input id="palq" type="text" placeholder="Search or jump to…" autocomplete="off" spellcheck="false">
      <ul class="palist" id="pallist"></ul>
      <div class="palfoot"><span><b>↑↓</b> move</span><span><b>↵</b> open</span><span><b>esc</b> close</span></div>
    </div>
  </div>
  <script type="application/json" id="paldata">${paletteData(idx)}</script>`);

/** Project-scoped nav. On the page, not the rail — so moving between people and
 *  projects never reflows the sidebar. */
const tabs = (project: string, on: "overview" | "standards", hasStandards: boolean): string =>
  `<nav class="tabs">
    <a class="${on === "overview" ? "on" : ""}" href="/p/${encodeURIComponent(project)}" data-tab="overview">Overview</a>
    ${hasStandards ? `<a class="${on === "standards" ? "on" : ""}" href="/s/${encodeURIComponent(project)}">Standards</a>` : ""}
    <a href="/search?project=${encodeURIComponent(project)}" data-tab="search">Search</a>
  </nav>`;

/**
 * What the panel offers before you have typed anything.
 *
 * Every suggestion is drawn from this project's own logs — the repos it names,
 * the people who wrote in it, the sessions themselves. Nothing is invented, so
 * a suggestion that returns no hits is not possible.
 */
function findData(v: ProjectView): string {
  const people = [...new Set(v.logs.map((l) => l.who))].sort();
  const repos = [...new Set(v.logs.flatMap((l) => l.repos).concat(v.repos))].filter(Boolean).sort();
  const recent = v.logs.slice(0, 8).map((l) => ({
    d: l.date, w: l.who,
    l: (l.summary.split("\n").find((x) => x.trim()) ?? l.id).replace(/^#+\s*/, "").slice(0, 150),
    h: `/log/${encodeURIComponent(l.rel)}`,
  }));
  return JSON.stringify({ people, repos, recent }).replace(/</g, "\\u003c");
}

/** Searching a project should not cost the page you were reading. The link
 *  still works with scripting off; with it on, the panel opens in place. */
const findPanel = (project: string): string => `
  <div class="find" id="find" hidden data-project="${escape(project)}">
    <div class="row">
      <input id="findq" type="search" autocomplete="off" spellcheck="false"
        placeholder="Search ${escape(project)} logs…" aria-label="Search this project">
      <span class="scope">${escape(project)}</span>
      <span class="meta" id="findmeta"></span>
    </div>
    <div class="out" id="findout"></div>
  </div>`;

/** A fact, stated. Tiles turn three numbers into a dashboard; a definition row
 *  states them and gets out of the way. */
const fact = (k: string, v: string, s = ""): string =>
  `<div><dt>${escape(k)}</dt><dd>${escape(v)}${
    s ? `<span class="of">${escape(s)}</span>` : ""}</dd></div>`;

/** First written line of a log, with its inline markdown intact.
 *
 *  This used to go through escape(), so a summary containing **Deploy after
 *  atlas-api** rendered the asterisks literally — the one place in the portal
 *  where markdown was shown as source rather than as text. */
const firstLine = (l: Log): string => {
  const raw = l.summary.split("\n").find((x) => x.trim())?.replace(/^#+\s*/, "").trim();
  if (!raw) return escape(l.id);
  return inline(raw.length > 130 ? `${raw.slice(0, 130)}…` : raw);
};

const logRows = (logs: Log[], showProject = false): string => logs.length
  ? `<div class="scroll"><table>${logs.map((l) => `<tr>
      <td class="d">${escape(l.date)}</td>
      <td class="w">${escape(l.who)}</td>
      <td class="r">${escape(showProject ? l.project : (l.repos[0] ?? ""))}</td>
      <td class="sum"><a href="/log/${escape(encodeURIComponent(l.rel))}">${firstLine(l)}</a></td>
    </tr>`).join("")}</table></div>`
  : `<p class="empty">No logs yet — run <code>nacre-publish</code> at the end of a session.</p>`;

/** Rendered page plus the headings its on-this-page rail should point at. */
interface Rendered { html: string; anchors: Anchor[] }

/** Project page. Order is urgency of not knowing, not recency. */
function renderProject(v: ProjectView): Rendered {
  const a: Anchor[] = [];
  const html = `${crumbs([["Projects", null], [v.title, null]])}
  <h1>${escape(v.title)}</h1>
  <p class="lede">${v.repos.length} repo${v.repos.length === 1 ? "" : "s"} · ${
    v.teams.length ? `${v.teams.length} team${v.teams.length === 1 ? "" : "s"} · ` : ""
  }${v.count} log${v.count === 1 ? "" : "s"}${v.superseded ? ` · ${v.superseded} superseded` : ""}</p>
  ${tabs(v.project, "overview", v.hasStandards)}
  ${findPanel(v.project)}
  <script type="application/json" id="finddata">${findData(v)}</script>
  <div id="overview">
  <dl class="facts">
    ${fact("Repos", String(v.repos.length), v.repos.join(", ") || "none linked")}
    ${fact("Logs", String(v.count), v.superseded ? `· ${v.superseded} superseded` : "")}
    ${fact("Teams", String(v.teams.length || 0), v.teams.join(", ") || "devs")}
  </dl>
  ${v.handoff
      ? (a.push({ id: "handoff", label: "Handoff" }), `<div class="callout" id="handoff" style="scroll-margin-top:4.5rem">
          <div class="ct">Handoff<span class="cw">${
            escape(v.handoffBy ? `${v.handoffBy.who} · ${v.handoffBy.date}` : "")}</span></div>
          <div class="prose">${markdown(v.handoff)}</div>
        </div>`)
      : ""}
  ${section("Project note", v.note ? "curated" : "not written",
      v.note
        ? `<div class="prose">${markdown(v.note)}</div>`
        : `<p class="empty">Nobody has written one yet — it lives in <code>${
            escape(v.project)}/_project.md</code>. The logs below are the record either way.</p>`, a)}
  ${section("Recent", `${v.count} log${v.count === 1 ? "" : "s"}${
      v.superseded ? ` · ${v.superseded} superseded` : ""}`, logRows(v.logs), a)}
  </div>`;
  return { html, anchors: a };
}

function renderPerson(v: PersonView): Rendered {
  const a: Anchor[] = [];
  const html = `${crumbs([["People", null], [v.who, null]])}
  <h1>${escape(v.who)}</h1>
  <p class="lede">${v.projects.length} project${v.projects.length === 1 ? "" : "s"} · ${
    v.count} log${v.count === 1 ? "" : "s"}</p>
  <dl class="facts">
    ${fact("Logs", String(v.count))}
    ${fact("Projects", String(v.projects.length), v.projects.join(", ") || "none")}
  </dl>
  ${section("Profile", v.profile ? "curated" : "not written",
      v.profile
        ? `<div class="prose">${markdown(v.profile)}</div>`
        : `<p class="empty">Not written yet — it lives in <code>_team/_${
            escape(v.who)}/_profile.md</code>. The logs below are the record either way.</p>`, a)}
  ${section("Logs", String(v.count), logRows(v.logs, true), a)}`;
  return { html, anchors: a };
}

/** At most this many lines from any one session, then this many rows overall. */
const PER_LOG = 3;
const MAX_ROWS = 200;

function renderSearch(q: string, hits: Hit[], scope: string, all: boolean): string {
  // Rendering every hit was fine at three logs and produced a 4.4 MB page at
  // three hundred — 14,160 rows, because a common word appears on many lines of
  // every session. The server was never the bottleneck; the browser was.
  //
  // Breadth first, exactly as the CLI does it: cap each session before capping
  // the total, so one thorough log cannot crowd out every other session that
  // discussed the same thing.
  const perLog = new Map<string, number>();
  const spread = hits.filter((h) => {
    const n = (perLog.get(h.id) ?? 0) + 1;
    perLog.set(h.id, n);
    return n <= PER_LOG;
  });
  const shown = spread.slice(0, MAX_ROWS);
  const sessions = perLog.size;

  return `${crumbs([["Search", null], [q || "all", null]])}
  <h1>${q ? escape(q) : "Search"}</h1>
  <p class="lede">${escape(all ? "all projects" : scope || "all projects")} · ${
    hits.length} hit${hits.length === 1 ? "" : "s"}${
    hits.length ? ` across ${sessions} session${sessions === 1 ? "" : "s"}` : ""}</p>
  <form class="qbox" method="get" action="/search" style="max-width:30rem;margin:0 0 1.6rem">
    <input type="search" name="q" value="${escape(q)}" placeholder="Search the memory…" autofocus>
    ${scope ? `<input type="hidden" name="project" value="${escape(scope)}">` : ""}
  </form>
  ${hits.length
    ? `${shown.length < hits.length
        // Never truncate silently: a list that stops without saying so reads as
        // the whole answer.
        ? `<p class="empty">Showing ${shown.length} of ${hits.length} — at most ${PER_LOG} per session${
            spread.length > MAX_ROWS ? `, first ${MAX_ROWS} sessions` : ""
          }. Narrow the search, or open a session to read it whole.</p>`
        : ""}
      <div class="scroll"><table>${shown.map((h) => `<tr>
        <td class="d">${escape(h.date)}</td><td class="w">${escape(h.who)}</td>
        <td class="r">${escape(h.project)}</td>
        <td class="sum">${h.against ? '<span class="flag">▌</span>' : ""}<a href="/log/${
          escape(encodeURIComponent(h.rel))}">${inline(h.line.slice(0, 130))}</a></td></tr>`).join("")}</table></div>`
    : q ? `<p class="empty">No hits for “${escape(q)}”.</p>` : ""}`;
}

/**
 * Start the portal. Returns the server so a caller — or a test — can close it.
 */
export interface ServeOptions { memory: string; port?: number; host?: string }

export async function serve({ memory, port = 4173, host = "127.0.0.1" }: ServeOptions) {
  // Read once at start rather than per request: it is a company-wide setting
  // that changes about never, and a file read on every page load to answer the
  // same question is the kind of cost that only shows up under a real vault.
  setIssueTemplate(await issueTemplate(memory));

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${host}`);
      const idx = await index(memory);
      const clone = await age(memory);
      const send = (html: string, status = 200): void => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(html);
      };

      if (url.pathname === "/favicon.ico") {
        res.writeHead(204, { "cache-control": "max-age=86400" });
        return res.end();
      }

      const project = url.pathname.match(/^\/p\/(.+)$/);
      if (project) {
        const name = decodeURIComponent(project[1] as string);
        const v = await projectView(memory, name);
        if (!v) return send(shell(memory, clone, idx, {}, name, `<h1>${escape(name)}</h1><p class="empty">no such project</p>`), 404);
        const r = renderProject(v);
        return send(shell(memory, clone, idx, { project: name }, v.title, r.html, r.anchors));
      }

      const person = url.pathname.match(/^\/who\/(.+)$/);
      if (person) {
        const who = decodeURIComponent(person[1] as string);
        const v = await personView(memory, who);
        const r = renderPerson(v);
        return send(shell(memory, clone, idx, { who }, who, r.html, r.anchors));
      }

      const month = url.pathname.match(/^\/t\/(.+)$/);
      if (month) {
        const m = decodeURIComponent(month[1] as string);
        const logs = (await readLogs(memory)).filter((l) => l.date.startsWith(m));
        return send(shell(memory, clone, idx, { month: m }, m,
          `<h1>${escape(m)}</h1><p class="sub">${logs.length} log${logs.length === 1 ? "" : "s"}</p>${logRows(logs, true)}`));
      }

      const log = url.pathname.match(/^\/log\/(.+)$/);
      if (log) {
        const rel = decodeURIComponent(log[1] as string);
        // Path is taken from the index, never from user input beyond matching it.
        const all = await readLogs(memory);
        const found = all.find((l) => l.rel === rel);
        if (!found) return send(shell(memory, clone, idx, {}, "not found", '<p class="empty">no such log</p>'), 404);
        return send(shell(memory, clone, idx, { project: found.project, who: found.who }, found.id,
          `<h1>${escape(found.id)}</h1><p class="sub">${escape(found.who)} · ${escape(found.project)}${
            found.repos.length ? ` · repos[${found.repos.length}] ${escape(found.repos.join(", "))}` : ""
          }</p><div class="log">${markdown(found.summaryOnly)}</div>
           ${found.auto.length ? `<div class="bh"><span>From git</span><span class="cnt">recorded at publish</span></div>
             <hr class="thin"><div class="block auto">${markdown(found.auto.join("\n"))}</div>` : ""}`));
      }

      const projStd = url.pathname.match(/^\/s\/(.+)$/);
      if (projStd) {
        const name = decodeURIComponent(projStd[1] as string);
        const text = await projectStandards(memory, name);
        if (text === null) {
          return send(shell(memory, clone, idx, { project: name }, name,
            `<p class="empty">${escape(name)} has no standards of its own — the company standards apply</p>`), 404);
        }
        return send(shell(memory, clone, idx, { project: name }, `${name} standards`,
          `<h1>${escape(name)} — standards</h1>
           <p class="sub">${escape(name)}/_standards.md · loaded with this project only</p>
           ${tabs(name, "standards", true)}
           <div class="log">${markdown(text.replace(/^(?:\s|<!--[\s\S]*?-->)*---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").replace(/<!--[\s\S]*?-->/g, ""))}</div>`));
      }

      const company = url.pathname.match(/^\/c\/(_company|_standards)$/);
      if (company) {
        const name = company[1] as string;
        const path = join(memory, `${name}.md`);
        if (!(await exists(path))) {
          return send(shell(memory, clone, idx, {}, name, `<p class="empty">no ${name}.md in this memory</p>`), 404);
        }
        const title = name === "_company" ? "Company context" : "Engineering standards";
        // The same pipeline the project note and profile already use. This route
        // stripped only the LEADING frontmatter block, so authoring comments
        // rendered as visible prose and the shipped template's prompts read as
        // company facts — on the one page that is loaded into every brief.
        const body = unfilled(
          (await readFile(path, "utf8"))
            .replace(/^(?:\s|<!--[\s\S]*?-->)*---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
            .replace(/<!--[\s\S]*?-->/g, "")
            .trim(),
        );
        return send(shell(memory, clone, idx, { company: name }, title, `<h1>${escape(title)}</h1>
          <p class="sub">${escape(name)}.md · loaded into every brief, in every project</p>
          <div class="log">${body
            ? markdown(body)
            : `<p class="empty">Not written yet — it lives in <code>${escape(name)}.md</code> at the root of the memory.</p>`
          }</div>`));
      }

      // Scoped search as JSON. The palette answers navigation from data already
      // in the page; this answers "what did we say about X" — which needs the
      // logs, and those are the one thing too large to embed.
      if (url.pathname === "/x/search") {
        const q = url.searchParams.get("q") ?? "";
        const scope = url.searchParams.get("project") ?? "";
        const hits = q.trim() ? await search(memory, q, { project: scope, all: !scope }) : [];
        const perLog = new Map<string, number>();
        const rows = hits
          .filter((h) => {
            const n = (perLog.get(h.id) ?? 0) + 1;
            perLog.set(h.id, n);
            return n <= 3;
          })
          .slice(0, 60)
          .map((h) => ({ d: h.date, w: h.who, r: h.project, l: h.line.slice(0, 160), h: `/log/${encodeURIComponent(h.rel)}`, a: h.against }));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ total: hits.length, sessions: perLog.size, rows }));
      }

      if (url.pathname === "/search") {
        const q = url.searchParams.get("q") ?? "";
        const scope = url.searchParams.get("project") ?? "";
        const all = url.searchParams.get("all") === "1" || !scope;
        const hits = q ? await search(memory, q, { project: scope, all }) : [];
        return send(shell(memory, clone, idx, {}, "search", renderSearch(q, hits, scope, all)));
      }

      // Company-wide on purpose: the whole point is the edge between two repos,
      // and a project-scoped graph could never show one that crosses projects.
      if (url.pathname === "/graph") {
        const g = seamGraph(await readLogs(memory));
        return send(shell(memory, clone, idx, { section: "graph" }, "the seam", renderGraph(g),
          [{ id: "seams", label: "The cross-repo seam" }]));
      }

      if (url.pathname === "/") {
        const names = Object.keys(idx.projects);
        if (names.length === 1) {
          const v = (await projectView(memory, names[0] as string)) as ProjectView;
          const r = renderProject(v);
          return send(shell(memory, clone, idx, { project: names[0] as string }, v.title, r.html, r.anchors));
        }
        const people = Object.keys(idx.people).length;
        return send(shell(memory, clone, idx, {}, basename(memory), `
          ${crumbs([[basename(memory), null]])}
          <h1>${escape(basename(memory))}</h1>
          <p class="lede">the company memory · ${names.length} project${names.length === 1 ? "" : "s"} · ${
            people} ${people === 1 ? "person" : "people"} · ${idx.total} log${idx.total === 1 ? "" : "s"}</p>
          <dl class="facts">
            ${fact("Projects", String(names.length), names.join(", ") || "none yet")}
            ${fact("People", String(people), Object.keys(idx.people).join(", ") || "none yet")}
            ${fact("Logs", String(idx.total))}
          </dl>
          ${section("Projects", `${names.length}`, names.length
            ? `<div class="scroll"><table>${names.map((n) => `<tr>
                <td class="sum"><a href="/p/${escape(encodeURIComponent(n))}">${escape(n)}</a></td>
                <td class="d">${idx.projects[n]} log${idx.projects[n] === 1 ? "" : "s"}</td></tr>`).join("")}</table></div>`
            : `<p class="empty">No projects yet — run <code>nacre add &lt;project&gt; &lt;repo-dir&gt;</code>.</p>`)}`));
      }

      send(shell(memory, clone, idx, {}, "not found", '<p class="empty">not found</p>'), 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`error: ${message}\n`);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  const bound = typeof address === "object" && address ? address.port : port;
  return { server, url: `http://${host}:${bound}` };
}
