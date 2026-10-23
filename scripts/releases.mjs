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
for (const t of TOKENS) { H = hdr(t); for (const r of await all("/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed")) if (!seenRepos.has(r.full_name)) seenRepos.set(r.full_name, Object.assign(r, { _token: t })); }
const repos = [...seenRepos.values()]
  .filter((r) => !r.archived && !r.fork)
  .filter((r) => !OWNERS.length || OWNERS.includes(r.owner.login.toLowerCase()))
  .filter((r) => !EXCLUDE.has(r.full_name.toLowerCase()));

const commits = [], releases = [], authors = new Set(), runsList = []; let runsOk = 0, runsFail = 0, lastRun = null, prsMerged7d = 0, prAccess = true;
const day = (t) => t.slice(0, 10), perDay = {}, byRepo = {};
for (const r of repos) {
  if (Date.parse(r.pushed_at) < month) continue;                  // quiet repos don't need a call
  H = hdr(r._token);
  const name = ALIASES[r.full_name] || r.name;
  for (const c of await all(`/repos/${r.full_name}/commits?since=${monthIso}`, 1000)) {
    if ((c.parents || []).length > 1) continue;                   // skip merge commits
    const at = c.commit.author.date; perDay[day(at)] = (perDay[day(at)] || 0) + 1; byRepo[name] = (byRepo[name] || 0) + 1;
    if (at < week) continue;
    authors.add((c.author && c.author.login) || c.commit.author.name);
    { const m = clean(c.commit.message); commits.push({ repo: name, sha: c.sha.slice(0, 7), msg: typeof m === "object" ? m.text : m, hidden: typeof m === "object" ? m.rest : 0, at: c.commit.author.date }); }
  }
  for (const rel of await gh(`/repos/${r.full_name}/releases?per_page=10`)) {
    if (rel.draft || Date.parse(rel.published_at) < month) continue;
    releases.push({ repo: name, tag: rel.tag_name, name: (function(){ const m = MODE === "hidden" ? "" : clean(rel.name || rel.tag_name); return typeof m === "object" ? m.text : m; })(), at: rel.published_at, pre: rel.prerelease });
  }
  try { for (const pr of await gh(`/repos/${r.full_name}/pulls?state=closed&sort=updated&direction=desc&per_page=50`)) if (pr.merged_at && pr.merged_at >= week) prsMerged7d++; } catch (e) { prAccess = false; }   // needs "Pull requests: read" on the token
  const runs = await gh(`/repos/${r.full_name}/actions/runs?per_page=20&created=>=${week.slice(0, 10)}`);
  for (const w of runs.workflow_runs || []) {
    if (w.status !== "completed") continue;
    if (w.conclusion === "success") runsOk++; else if (["failure", "timed_out"].includes(w.conclusion)) runsFail++;
    if (!lastRun || w.updated_at > lastRun.at) lastRun = { repo: name, conclusion: w.conclusion, at: w.updated_at };
    runsList.push({ repo: name, workflow: MODE === "hidden" ? "ci" : (w.name || "ci"), conclusion: w.conclusion, at: w.updated_at, secs: Math.max(0, Math.round((Date.parse(w.updated_at) - Date.parse(w.run_started_at || w.created_at)) / 1000)) });
  }
}
commits.sort((a, b) => b.at.localeCompare(a.at));
runsList.sort((a, b) => b.at.localeCompare(a.at));
const days30 = []; for (let i = 29; i >= 0; i--){ const d = new Date(now - i * 864e5).toISOString().slice(0, 10); days30.push({ day: d, commits: perDay[d] || 0 }); }
const commits30d = days30.reduce((a, d) => a + d.commits, 0);
releases.sort((a, b) => b.at.localeCompare(a.at));

process.stdout.write(JSON.stringify({
  updatedAt: new Date().toISOString(),
  stats: {
    commits7d: commits.length,
    commits30d,
    prsMerged7d: prAccess ? prsMerged7d : null,
    releases30d: releases.length,
    activeRepos7d: new Set(commits.map((c) => c.repo)).size,
    contributors7d: authors.size,
    ciRuns7d: runsOk + runsFail,
    ciPassRate7d: runsOk + runsFail ? Math.round((runsOk / (runsOk + runsFail)) * 100) : null
  },
  lastRun,
  perDay: days30,
  byRepo: Object.entries(byRepo).map(([repo, n]) => ({ repo, commits: n })).sort((a, b) => b.commits - a.commits),
  recentRuns: runsList.slice(0, 12),
  releases: releases.slice(0, 20),
  commits: commits.slice(0, 40)
}, null, 2) + "\n");
