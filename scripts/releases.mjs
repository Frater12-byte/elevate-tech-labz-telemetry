import { readFileSync, writeFileSync } from "node:fs";
// Builds releases.json for the website: commits, releases and CI results across ALL repos and ALL contributors.
// Uses the GitHub REST API with a read-only token. https://docs.github.com/en/rest
//
// Env:
//   GH_READ_TOKEN   fine-grained PAT (or GitHub App token) with read-only Contents, Metadata and Actions
//                   on every repo you want counted. It sees exactly the repos its owner can see.
//   GH_READ_TOKEN_2 optional second token (e.g. one Samir creates on his account for SamirElevate/elevate-hub).
//                   Fine-grained tokens only reach repos owned by their own account, so a repo owned by
//                   someone else needs a token from that account.
//   GH_OWNERS       optional, comma list of users/orgs to include (e.g. "Frater12-byte,SamirElevate,elevate-tech-labz")
//   GH_EXCLUDE      optional, comma list of "owner/repo" to skip
//   REPO_ALIASES    optional JSON {"owner/repo":"hub"} — the public name shown on the site
//   STATS_CACHE     file that remembers per-commit line counts (default commit-stats.json), so each run only reads new commits
//   MESSAGE_MODE    "subject" (first line, cleaned) | "first2" (first 2 words + hidden length) | "type" | "hidden"
const TOKENS = [process.env.GH_READ_TOKEN || process.env.SECRET_GH_READ_TOKEN, process.env.GH_READ_TOKEN_2 || process.env.SECRET_GH_READ_TOKEN_2].filter(Boolean);
if (!TOKENS.length) { console.error("GH_READ_TOKEN is not set"); process.exit(1); }
const OWNERS = (process.env.GH_OWNERS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const EXCLUDE = new Set((process.env.GH_EXCLUDE || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
const ALIASES = JSON.parse(process.env.REPO_ALIASES || "{}");
const MODE = process.env.MESSAGE_MODE || "subject";
const hdr = (t) => ({ Authorization: `Bearer ${t}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ElevateTechLabz-Releases/1.0" });
let H = hdr(TOKENS[0]);

async function gh(path) {
  const r = await fetch(`https://api.github.com${path}`, { headers: H });
  if (r.status === 409 || r.status === 404) return [];          // empty repo / no access
  if (!r.ok) throw new Error(`${r.status} ${path}\n${await r.text()}`);
  return r.json();
}
async function all(path, cap = 1000) {
  const out = [];
  for (let p = 1; out.length < cap; p++) {
    const page = await gh(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${p}`);
    const items = Array.isArray(page) ? page : page.workflow_runs || [];
    out.push(...items); if (items.length < 100) break;
  }
  return out;
}
// keep messages safe to publish: no emails, links, keys, ticket refs to private trackers
function clean(msg) {
  let s = (msg || "").split("\n")[0].trim();
  s = s.replace(/\S+@\S+/g, "…").replace(/https?:\/\/\S+/g, "…").replace(/\b[A-Za-z0-9_\-]{32,}\b/g, "…").replace(/\b[A-Z]{2,}-\d+\b/g, "").replace(/\s{2,}/g, " ").trim();
  if (MODE === "hidden") return "";
  if (MODE === "first2") { const w = s.split(/\s+/); return w.length <= 2 ? s : { text: w.slice(0, 2).join(" "), rest: w.slice(2).join(" ").length }; }
  if (MODE === "type") { const m = s.match(/^(\w+)(\([^)]*\))?!?:/); return m ? m[0].replace(/:$/, "") : "update"; }
  return s.length > 80 ? s.slice(0, 79) + "…" : s;
}
const now = Date.now(), week = new Date(now - 7 * 864e5).toISOString(), monthIso = new Date(now - 30 * 864e5).toISOString(), month = now - 30 * 864e5;

// every token lists the repos it can read; each repo is then read with the token that found it
const seenRepos = new Map();
for (const [i, t] of TOKENS.entries()) {
  H = hdr(t); const list = await all("/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed");
  console.error(`token ${i + 1}: can read ${list.length} repo(s)`);   // counts only: this log is public
  for (const r of list) if (!seenRepos.has(r.full_name)) seenRepos.set(r.full_name, Object.assign(r, { _token: t }));
}
const repos = [...seenRepos.values()]
  .filter((r) => !r.archived && !r.fork)
  .filter((r) => !OWNERS.length || OWNERS.includes(r.owner.login.toLowerCase()))
  .filter((r) => !EXCLUDE.has(r.full_name.toLowerCase()));

// ---- per-commit line counts and languages (exact numbers; cached so each run only reads new commits) ----
const CACHE_FILE = process.env.STATS_CACHE || "commit-stats.json";
let cache = {}; try { cache = JSON.parse(readFileSync(CACHE_FILE, "utf8")); } catch (e) {}
const LANG = { ts:"TypeScript", tsx:"TypeScript", mts:"TypeScript", cts:"TypeScript", js:"JavaScript", jsx:"JavaScript", mjs:"JavaScript", cjs:"JavaScript",
  py:"Python", html:"HTML", htm:"HTML", css:"CSS", scss:"CSS", sass:"CSS", less:"CSS", sql:"SQL", prisma:"Prisma", json:"JSON", md:"Markdown", mdx:"Markdown",
  yml:"YAML", yaml:"YAML", sh:"Shell", bash:"Shell", ps1:"PowerShell", go:"Go", java:"Java", kt:"Kotlin", swift:"Swift", php:"PHP", rb:"Ruby", cs:"C#",
  vue:"Vue", svelte:"Svelte", xml:"XML", graphql:"GraphQL", gql:"GraphQL", toml:"Config", ini:"Config", env:"Config", tf:"Terraform", bicep:"Bicep", dockerfile:"Docker", txt:"Text", csv:"Data" };
const SKIP = [/(^|\/)(node_modules|dist|build|out|\.next|coverage|vendor|__pycache__|\.venv|staticfiles)\//i, /(^|\/)migrations\//i,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|uv\.lock|bun\.lockb)$/i,
  /\.(min\.(js|css)|map|snap|lock)$/i, /\.(png|jpe?g|gif|webp|avif|ico|svg|pdf|woff2?|ttf|otf|eot|mp4|webm|mov|mp3|zip|gz|tar|xlsx?|docx?|pptx?)$/i];
function langOf(f){ const base = f.split("/").pop(); if (/^dockerfile/i.test(base)) return "Docker"; const ext = base.includes(".") ? base.split(".").pop().toLowerCase() : ""; return LANG[ext] || "Other"; }
async function commitDetail(full, sha, token){
  const r = await fetch(`https://api.github.com/repos/${full}/commits/${sha}`, { headers: hdr(token) });
  if (!r.ok) return null; const j = await r.json(); let a = 0, d = 0; const l = {};
  for (const f of j.files || []) {
    if (SKIP.some((re) => re.test(f.filename)) || f.additions > 20000) continue;   // generated or vendored code isn't "written"
    const k = langOf(f.filename); a += f.additions; d += f.deletions; (l[k] = l[k] || [0, 0]); l[k][0] += f.additions; l[k][1] += f.deletions;
  }
  return { a, d, l };
}

const commits = [], releases = [], all30 = [], runsList = []; let runsOk = 0, runsFail = 0, runsOk7 = 0, runsFail7 = 0, lastRun = null, prs7 = 0, prs30 = 0, prAccess = true;
const day = (t) => t.slice(0, 10), byRepo = {};
for (const r of repos) {
  if (Date.parse(r.pushed_at) < month) continue;                  // quiet repos don't need a call
  H = hdr(r._token);
  const name = ALIASES[r.full_name] || r.name;
  for (const c of await all(`/repos/${r.full_name}/commits?since=${monthIso}`, 1500)) {
    if ((c.parents || []).length > 1) continue;                   // skip merge commits
    const at = c.commit.author.date; byRepo[name] = (byRepo[name] || 0) + 1;
    all30.push({ full: r.full_name, token: r._token, sha: c.sha, at, repo: name });
    if (at < week) continue;
    { const m = clean(c.commit.message); commits.push({ repo: name, sha: c.sha.slice(0, 7), msg: typeof m === "object" ? m.text : m, hidden: typeof m === "object" ? m.rest : 0, at }); }
  }
  for (const rel of await gh(`/repos/${r.full_name}/releases?per_page=10`)) {
    if (rel.draft || Date.parse(rel.published_at) < month) continue;
    releases.push({ repo: name, tag: rel.tag_name, name: (function(){ const m = MODE === "hidden" ? "" : clean(rel.name || rel.tag_name); return typeof m === "object" ? m.text : m; })(), at: rel.published_at, pre: rel.prerelease });
  }
  try { for (const pr of await all(`/repos/${r.full_name}/pulls?state=closed&sort=updated&direction=desc`, 300)) if (pr.merged_at && pr.merged_at >= monthIso) { prs30++; if (pr.merged_at >= week) prs7++; } } catch (e) { prAccess = false; }   // needs "Pull requests: read"
  const runs = await gh(`/repos/${r.full_name}/actions/runs?per_page=100&created=>=${monthIso.slice(0, 10)}`);
  for (const w of runs.workflow_runs || []) {
    if (w.status !== "completed") continue;
    const ok = w.conclusion === "success", bad = ["failure", "timed_out"].includes(w.conclusion), recent = w.created_at >= week;
    if (ok) runsOk++; else if (bad) runsFail++;
    if (recent){ if (ok) runsOk7++; else if (bad) runsFail7++; }
    if (!lastRun || w.updated_at > lastRun.at) lastRun = { repo: name, conclusion: w.conclusion, at: w.updated_at };
    if (recent) runsList.push({ repo: name, workflow: MODE === "hidden" ? "ci" : (w.name || "ci"), conclusion: w.conclusion, at: w.updated_at, secs: Math.max(0, Math.round((Date.parse(w.updated_at) - Date.parse(w.run_started_at || w.created_at)) / 1000)) });
  }
}

// read details only for commits we haven't seen before, a few at a time
const todo = all30.filter((c) => !cache[c.sha.slice(0, 12)]).slice(0, 1800);
for (let i = 0; i < todo.length; i += 8) {
  await Promise.all(todo.slice(i, i + 8).map(async (c) => { const det = await commitDetail(c.full, c.sha, c.token).catch(() => null); if (det) cache[c.sha.slice(0, 12)] = { t: c.at, ...det }; }));
}
console.error(`commit details: ${todo.length} new, ${Object.keys(cache).length} cached`);
for (const k of Object.keys(cache)) if (Date.parse(cache[k].t) < now - 40 * 864e5) delete cache[k];
writeFileSync(CACHE_FILE, JSON.stringify(cache));

// aggregate the last 30 days
const perDay = {}, langs = {}, heat = Array.from({ length: 7 }, () => Array(24).fill(0)); let add30 = 0, del30 = 0, add7 = 0, del7 = 0, missing = 0;
for (const c of all30) {
  const dd = day(c.at); const pd = (perDay[dd] = perDay[dd] || { commits: 0, added: 0, removed: 0 }); pd.commits++;
  const g = new Date(Date.parse(c.at) + 4 * 3600e3); heat[(g.getUTCDay() + 6) % 7][g.getUTCHours()]++;   // Dubai time, Monday first
  const st = cache[c.sha.slice(0, 12)]; if (!st) { missing++; continue; }
  pd.added += st.a; pd.removed += st.d; add30 += st.a; del30 += st.d; if (c.at >= week) { add7 += st.a; del7 += st.d; }
  for (const [k, [a, d]] of Object.entries(st.l || {})) { const L = (langs[k] = langs[k] || { lang: k, added: 0, removed: 0 }); L.added += a; L.removed += d; }
}
const langList = Object.values(langs).sort((a, b) => b.added - a.added);
const topLangs = langList.slice(0, 7); const restL = langList.slice(7).reduce((o, l) => ({ lang: "Other", added: o.added + l.added, removed: o.removed + l.removed }), { lang: "Other", added: 0, removed: 0 });
if (restL.added) { const o = topLangs.find((l) => l.lang === "Other"); if (o) { o.added += restL.added; o.removed += restL.removed; } else topLangs.push(restL); }
commits.sort((a, b) => b.at.localeCompare(a.at));
runsList.sort((a, b) => b.at.localeCompare(a.at));
const days30 = []; for (let i = 29; i >= 0; i--){ const d = new Date(now - i * 864e5).toISOString().slice(0, 10); const v = perDay[d] || { commits: 0, added: 0, removed: 0 }; days30.push({ day: d, commits: v.commits, added: v.added, removed: v.removed }); }
releases.sort((a, b) => b.at.localeCompare(a.at));
const rate = (ok, bad) => ok + bad ? Math.round((ok / (ok + bad)) * 100) : null;

process.stdout.write(JSON.stringify({
  updatedAt: new Date().toISOString(),
  stats: {
    commits7d: commits.length, commits30d: all30.length,
    prsMerged7d: prAccess ? prs7 : null, prsMerged30d: prAccess ? prs30 : null,
    releases30d: releases.length,
    activeRepos7d: new Set(commits.map((c) => c.repo)).size, activeRepos30d: Object.keys(byRepo).length,
    linesAdded7d: add7, linesRemoved7d: del7, linesAdded30d: add30, linesRemoved30d: del30, linesPartial: missing > 0,
    ciRuns7d: runsOk7 + runsFail7, ciPassRate7d: rate(runsOk7, runsFail7),
    ciRuns30d: runsOk + runsFail, ciPassRate30d: rate(runsOk, runsFail)
  },
  lastRun,
  perDay: days30,
  languages: topLangs,
  heatmap: heat,
  byRepo: Object.entries(byRepo).map(([repo, n]) => ({ repo, commits: n })).sort((a, b) => b.commits - a.commits),
  recentRuns: runsList.slice(0, 12),
  releases: releases.slice(0, 20),
  commits: commits.slice(0, 40)
}, null, 2) + "\n");
