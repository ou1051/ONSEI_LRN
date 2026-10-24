// Progress log: after a study session, writes your learning numbers to `progress/` in a git
// repository (by default this app's own folder), commits, and pushes, so your study shows up
// on GitHub.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./db.js";
import { getSettings } from "./settings.js";
import { computeStats, dayKey } from "./stats.js";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IDLE_MS = 15 * 60 * 1000; // a session ends after 15 minutes without activity
const GIT_TIMEOUT_MS = 90 * 1000;
const DIR = "progress";

export const repoDir = () => getSettings().progress.repo || APP_DIR;

export class ProgressError extends Error {}

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    // Never wait for a password prompt; fail with a message instead
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" };
    const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ProgressError(e.code === "ENOENT" ? "git is not installed." : e.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(Object.assign(new ProgressError((err || out).trim() || `git ${args[0]} failed`), { git: true }));
    });
  });
}

const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${Math.round(m % 60)} min` : `${Math.round(m)} min`);

// The files written to progress/ (pure, for testing)
export function renderProgress(stats) {
  const t = stats.total;
  const active = stats.series.filter((d) => d.explained || d.reviewed);
  const lines = [
    "# Study progress",
    "",
    "Updated automatically by ONSEI_LRN.",
    "",
    "| | Total |",
    "|---|---|",
    `| Concepts mastered | ${t.conceptsMastered} / ${t.concepts} |`,
    `| Flashcards | ${t.cards} (${t.remembered} remembered right now) |`,
    `| Explanations given | ${t.explained} |`,
    `| Cards reviewed | ${t.reviewed} |`,
    `| Study time | ${fmtMin(t.minutes)} |`,
    `| Current streak | ${stats.streak} day${stats.streak === 1 ? "" : "s"} |`,
    ...(t.averageScore == null ? [] : [`| Average explanation score | ${t.averageScore} / 100 |`]),
    "",
    "## Last 30 days",
    "",
    "| Day | Explained | Mastered | Reviewed | Minutes |",
    "|---|---|---|---|---|",
    ...active.reverse().map((d) => `| ${d.day} | ${d.explained} | ${d.mastered} | ${d.reviewed} | ${Math.round(d.minutes)} |`),
    "",
  ];
  const json = { updatedAt: new Date().toISOString().slice(0, 10), streak: stats.streak, total: t, last30Days: stats.series };
  return { "README.md": lines.join("\n"), "stats.json": JSON.stringify(json, null, 2) + "\n" };
}

export function commitMessage(stats) {
  const d = stats.today;
  const parts = [];
  if (d.mastered) parts.push(`${d.mastered} concept${d.mastered === 1 ? "" : "s"} mastered`);
  if (d.reviewed) parts.push(`${d.reviewed} card${d.reviewed === 1 ? "" : "s"} reviewed`);
  if (d.explained && !d.mastered) parts.push(`${d.explained} explanation${d.explained === 1 ? "" : "s"}`);
  if (d.minutes) parts.push(`${fmtMin(d.minutes)}`);
  const summary = parts.length ? parts.join(", ") : "progress update";
  return `Study log ${dayKey(Date.now())}: ${summary}\n\nTotal: ${stats.total.conceptsMastered} concepts mastered, ${stats.total.cards} flashcards, ${stats.total.reviewed} reviews.`;
}

export const status = { lastRun: null, ok: null, message: "", lastCommit: null };
let running = null;
let idleTimer = null;

function explain(err) {
  const m = err.message;
  if (/not a git repository/i.test(m)) return "That folder is not a git repository.";
  if (/please tell me who you are|user\.email|user\.name/i.test(m)) {
    return 'git does not know your name/email. Run once in Terminal: git config --global user.name "Your Name" && git config --global user.email "you@example.com" (use your GitHub email so it counts on your profile).';
  }
  if (/could not read Username|Authentication failed|terminal prompts disabled|Permission denied|403/i.test(m)) {
    return "Committed, but pushing failed: GitHub needs your login. In Terminal, run `gh auth login` (or push once by hand from this folder), then press Commit & push now.";
  }
  if (/CONFLICT|could not apply|rebase/i.test(m)) return "Committed, but GitHub has conflicting changes in progress/. Pull and resolve them in Terminal.";
  return m.slice(0, 400);
}

async function run({ push }) {
  const cwd = repoDir();
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const target = path.join(top, DIR);
  fs.mkdirSync(target, { recursive: true });
  const stats = computeStats(db);
  for (const [name, text] of Object.entries(renderProgress(stats))) {
    fs.writeFileSync(path.join(target, name), text);
  }

  await git(top, ["add", "--", DIR]);
  const changed = await git(top, ["diff", "--cached", "--name-only", "--", DIR]);
  let committed = false;
  if (changed) {
    // Commit only progress/, leaving anything else you have staged untouched
    await git(top, ["commit", "-m", commitMessage(stats), "--only", "--", DIR]);
    committed = true;
  }
  if (!push) return { committed, pushed: false };

  const ahead = await git(top, ["rev-list", "--count", "@{upstream}..HEAD"]).catch(() => null);
  if (ahead === null) {
    await git(top, ["push", "-u", "origin", "HEAD"]);
  } else if (Number(ahead) > 0) {
    await git(top, ["pull", "--rebase", "--autostash"]).catch(async (err) => {
      await git(top, ["rebase", "--abort"]).catch(() => {});
      throw err;
    });
    await git(top, ["push"]);
  }
  return { committed, pushed: true };
}

export async function runNow({ push = getSettings().progress.push } = {}) {
  if (running) return running;
  running = run({ push })
    .then((r) => {
      const message = r.committed ? (r.pushed ? "Committed and pushed your progress." : "Committed your progress.") : r.pushed ? "Up to date on GitHub." : "Nothing new to commit.";
      Object.assign(status, { lastRun: new Date().toISOString(), ok: true, message });
      if (r.committed) status.lastCommit = status.lastRun;
      return status;
    })
    .catch((err) => {
      Object.assign(status, { lastRun: new Date().toISOString(), ok: false, message: explain(err) });
      throw new ProgressError(status.message);
    })
    .finally(() => (running = null));
  return running;
}

// Called after each explanation or review: commits once you have been idle for a while
export function noteActivity() {
  if (!getSettings().progress.enabled) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => runNow().catch((err) => console.error(`Progress log: ${err.message}`)), IDLE_MS);
  idleTimer.unref?.();
}
