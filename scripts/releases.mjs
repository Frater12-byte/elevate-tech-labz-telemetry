// Builds releases.json for the website: commits, releases and CI results across ALL repos and ALL contributors.
// Uses the GitHub REST API with a read-only token. https://docs.github.com/en/rest
//
// Env:
//   GH_READ_TOKEN   fine-grained PAT (or GitHub App token) with read-only Contents, Metadata and Actions
//                   on every repo you want counted. It sees exactly the repos its owner can see.
//   GH_OWNERS       optional, comma list of users/orgs to include (e.g. "Frater12-byte,SamirElevate,elevate-tech-labz")
//   GH_EXCLUDE      optional, comma list of "owner/repo" to skip
//   REPO_ALIASES    optional JSON {"owner/repo":"hub"} — the public name shown on the site
//   MESSAGE_MODE    "subject" (default: first line, cleaned) | "type" (only "feat(hub)") | "hidden"
const TOKEN = (process.env.GH_READ_TOKEN || process.env.SECRET_GH_READ_TOKEN);
if (!TOKEN) { console.error("GH_READ_TOKEN is not set"); process.exit(1); }
const OWNERS = (process.env.GH_OWNERS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const EXCLUDE = new Set((process.env.GH_EXCLUDE || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
const ALIASES = JSON.parse(process.env.REPO_ALIASES || "{}");
const MODE = process.env.MESSAGE_MODE || "subject";
const H = { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ElevateTechLabz-Releases/1.0" };

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
  if (MODE === "type") { const m = s.match(/^(\w+)(\([^)]*\))?!?:/); return m ? m[0].replace(/:$/, "") : "update"; }
  return s.length > 80 ? s.slice(0, 79) + "…" : s;
}
const now = Date.now(), week = new Date(now - 7 * 864e5).toISOString(), month = now - 30 * 864e5;

const repos = (await all("/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed"))
  .filter((r) => !r.archived && !r.fork)
  .filter((r) => !OWNERS.length || OWNERS.includes(r.owner.login.toLowerCase()))
  .filter((r) => !EXCLUDE.has(r.full_name.toLowerCase()));

const commits = [], releases = [], authors = new Set(); let runsOk = 0, runsFail = 0, lastRun = null;
for (const r of repos) {
  if (Date.parse(r.pushed_at) < month) continue;                  // quiet repos don't need a call
  const name = ALIASES[r.full_name] || r.name;
  for (const c of await all(`/repos/${r.full_name}/commits?since=${week}`, 300)) {
    if ((c.parents || []).length > 1) continue;                   // skip merge commits
    authors.add((c.author && c.author.login) || c.commit.author.name);
    commits.push({ repo: name, sha: c.sha.slice(0, 7), msg: clean(c.commit.message), at: c.commit.author.date });
  }
  for (const rel of await gh(`/repos/${r.full_name}/releases?per_page=10`)) {
    if (rel.draft || Date.parse(rel.published_at) < month) continue;
    releases.push({ repo: name, tag: rel.tag_name, name: MODE === "hidden" ? "" : clean(rel.name || rel.tag_name), at: rel.published_at, pre: rel.prerelease });
  }
  const runs = await gh(`/repos/${r.full_name}/actions/runs?per_page=20&created=>=${week.slice(0, 10)}`);
  for (const w of runs.workflow_runs || []) {
    if (w.status !== "completed") continue;
    if (w.conclusion === "success") runsOk++; else if (["failure", "timed_out"].includes(w.conclusion)) runsFail++;
    if (!lastRun || w.updated_at > lastRun.at) lastRun = { repo: name, conclusion: w.conclusion, at: w.updated_at };
  }
}
commits.sort((a, b) => b.at.localeCompare(a.at));
releases.sort((a, b) => b.at.localeCompare(a.at));

process.stdout.write(JSON.stringify({
  updatedAt: new Date().toISOString(),
  stats: {
    commits7d: commits.length,
    releases30d: releases.length,
    activeRepos7d: new Set(commits.map((c) => c.repo)).size,
    contributors7d: authors.size,
    ciRuns7d: runsOk + runsFail,
    ciPassRate7d: runsOk + runsFail ? Math.round((runsOk / (runsOk + runsFail)) * 100) : null
  },
  lastRun,
  releases: releases.slice(0, 20),
  commits: commits.slice(0, 40)
}, null, 2) + "\n");
