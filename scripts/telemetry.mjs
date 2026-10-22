// Builds telemetry.json for the website: AI tokens used across ALL projects and ALL users.
//
// Sources (each one is optional; set the secret to switch it on):
//   1. Anthropic Usage API      every Claude API call, every workspace and API key in the org
//      https://platform.claude.com/docs/en/manage-claude/usage-cost-api
//   2. Claude Code Analytics    every developer using Claude Code across every repo (tokens, commits, PRs)
//      https://platform.claude.com/docs/en/manage-claude/claude-code-analytics-api
//   3. OpenAI Usage API         every OpenAI project and user (Codex and other OpenAI calls made with API keys)
//      https://developers.openai.com/api/reference  (GET /v1/organization/usage/completions)
//
// Reads usage counts only. No prompts, code or outputs are ever fetched.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const AKEY = (process.env.ANTHROPIC_ADMIN_KEY || process.env.SECRET_ANTHROPIC_ADMIN_KEY) || "";
const OKEY = (process.env.OPENAI_ADMIN_KEY || process.env.SECRET_OPENAI_ADMIN_KEY) || "";
const SINCE = process.env.TELEMETRY_SINCE || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
if (!AKEY && !OKEY) { console.error("No API keys set yet; skipping so the site keeps showing demo data."); process.exit(1); }
const STATE = "state.json";            // per-day cache, so each run only re-reads the last couple of days
const UA = "ElevateTechLabz-Telemetry/2.0 (https://elevatetechlabz.com)";

const now = new Date();
const dayStr = (d) => d.toISOString().slice(0, 10);
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const days = [];
for (let d = new Date(SINCE + "T00:00:00Z"); d <= now; d = new Date(d.getTime() + 864e5)) days.push(dayStr(d));
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { days: {} };
const fresh = new Set(days.slice(-2));   // today and yesterday are always re-read (late-arriving data)

function sumTokens(o) {                  // adds every numeric field whose name ends in "tokens" (any depth)
  let n = 0;
  for (const [k, v] of Object.entries(o || {})) {
    if (typeof v === "number" && /tokens$/.test(k)) n += v;
    else if (v && typeof v === "object") n += sumTokens(v);
  }
  return n;
}
async function getJSON(url, headers) {
  const r = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
  if (!r.ok) throw new Error(`${r.status} ${url}\n${await r.text()}`);
  return r.json();
}
async function paged(base, params, headers, pageParam = "page") {
  const out = []; let page = null;
  do {
    const q = new URLSearchParams(params); if (page) q.set(pageParam, page);
    const j = await getJSON(`${base}?${q.toString().replace(/%5B%5D/g, "[]")}`, headers);
    out.push(...(j.data || []));
    page = j.has_more ? j.next_page : null;
  } while (page);
  return out;
}

// ---------- 1) Anthropic API (all workspaces, all keys) ----------
const AH = { "x-api-key": AKEY, "anthropic-version": "2023-06-01" };
async function anthropicDay(d) {
  const s = new Date(d + "T00:00:00Z"), e = new Date(Math.min(now, s.getTime() + 864e5));
  const rows = await paged("https://api.anthropic.com/v1/organizations/usage_report/messages", { starting_at: iso(s), ending_at: iso(e), bucket_width: "1h", limit: "24" }, AH);
  return rows.reduce((t, b) => t + (b.results || []).reduce((a, r) => a + sumTokens(r), 0), 0);
}
async function anthropicMinutes() {
  const rows = await paged("https://api.anthropic.com/v1/organizations/usage_report/messages", { starting_at: iso(new Date(now - 36e5)), ending_at: iso(now), bucket_width: "1m", limit: "60" }, AH);
  return rows.map((b) => (b.results || []).reduce((a, r) => a + sumTokens(r), 0));
}

// ---------- 2) Claude Code (every developer, every repo) ----------
// Records with customer_type "api" already show up in source 1, so only subscription seats are added here.
async function claudeCodeDay(d) {
  const rows = await paged("https://api.anthropic.com/v1/organizations/usage_report/claude_code", { starting_at: d, limit: "1000" }, AH);
  let tokens = 0, commits = 0, prs = 0; const users = new Set();
  for (const r of rows) {
    users.add(r.actor?.email_address || r.actor?.api_key_name || "unknown");
    commits += r.core_metrics?.commits_by_claude_code || 0;
    prs += r.core_metrics?.pull_requests_by_claude_code || 0;
    if (r.customer_type !== "api") for (const m of r.model_breakdown || []) tokens += sumTokens(m);
  }
  return { tokens, commits, prs, devs: users.size };
}

// ---------- 3) OpenAI (all projects, all users) ----------
const OH = { Authorization: `Bearer ${OKEY}` };
async function openaiRange(start, end, width) {
  const rows = await paged("https://api.openai.com/v1/organization/usage/completions", { start_time: String(Math.floor(start / 1000)), end_time: String(Math.floor(end / 1000)), bucket_width: width, limit: width === "1m" ? "60" : "24" }, OH);
  return rows.map((b) => (b.results || []).reduce((a, r) => a + sumTokens(r), 0));
}
async function openaiDay(d) { const s = Date.parse(d + "T00:00:00Z"); return (await openaiRange(s, Math.min(+now, s + 864e5), "1h")).reduce((a, b) => a + b, 0); }

// ---------- build ----------
for (const d of days) {
  if (state.days[d] && !fresh.has(d)) continue;
  const row = { anthropic: 0, claudeCode: 0, openai: 0, commits: 0, prs: 0, devs: 0 };
  if (AKEY) { row.anthropic = await anthropicDay(d); const cc = await claudeCodeDay(d); Object.assign(row, { claudeCode: cc.tokens, commits: cc.commits, prs: cc.prs, devs: cc.devs }); }
  if (OKEY) row.openai = await openaiDay(d);
  state.days[d] = row;
}
writeFileSync(STATE, JSON.stringify(state, null, 1));

const all = days.map((d) => state.days[d] || {});
const sum = (k, list = all) => list.reduce((a, r) => a + (r[k] || 0), 0);
const total = sum("anthropic") + sum("claudeCode") + sum("openai");
const t = state.days[dayStr(now)] || {};
const today = (t.anthropic || 0) + (t.claudeCode || 0) + (t.openai || 0);

// live rate from 1-minute buckets (API usage lands within ~5 minutes, so skip the newest 5)
const perMin = [];
if (AKEY) perMin.push(await anthropicMinutes());
if (OKEY) perMin.push(await openaiRange(+now - 36e5, +now, "1m"));
const merged = perMin.length ? perMin[0].map((v, i) => perMin.reduce((a, s) => a + (s[i] || 0), 0)) : [];
const recent = merged.slice(-20, -5);
const avgMin = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;

const last7 = all.slice(-7);
const breakdown = [
  { name: "Claude API · all projects", tokens: sum("anthropic", last7) },
  { name: "Claude Code · all developers", tokens: sum("claudeCode", last7) },
  { name: "OpenAI / Codex · all projects", tokens: sum("openai", last7) }
].filter((x) => x.tokens > 0);

process.stdout.write(JSON.stringify({
  updatedAt: now.toISOString(),
  since: SINCE,
  total, today,
  perMinute: Math.round(avgMin),
  perSecond: Math.round(avgMin / 60),
  callsToday: null,
  commitsToday: AKEY ? (t.commits || 0) : null,     // commits made with Claude Code today, across all repos
  prsToday: AKEY ? (t.prs || 0) : null,
  developersToday: AKEY ? (t.devs || 0) : null,
  breakdown,                                         // last 7 days, by source
  sources: { anthropic: { connected: !!AKEY }, claudeCode: { connected: !!AKEY }, openai: { connected: !!OKEY } },
  recentJobs: []
}, null, 2) + "\n");
