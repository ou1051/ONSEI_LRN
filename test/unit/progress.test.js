import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { useTempData, tempDir } from "../helpers.js";

useTempData();
const progress = await import("../../lib/progress.js");
const { updateSettings } = await import("../../lib/settings.js");
const { db } = await import("../../lib/db.js");

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trim();

// A "GitHub" (bare repo) and your local clone of it
function setupRepos() {
  const root = tempDir("onsei-git-");
  const remote = path.join(root, "remote.git");
  const local = path.join(root, "local");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "clone", "-q", remote, local);
  git(local, "config", "user.email", "me@example.com");
  git(local, "config", "user.name", "Me");
  fs.writeFileSync(path.join(local, "app.txt"), "app\n");
  git(local, "add", ".");
  git(local, "commit", "-q", "-m", "app");
  git(local, "push", "-q", "-u", "origin", "HEAD");
  return { root, remote, local };
}

function addActivity() {
  const t = new Date().toISOString();
  db.concepts.push({ id: `c${db.concepts.length}`, status: "mastered" });
  db.attempts.push({ conceptId: `c${db.concepts.length - 1}`, createdAt: t, durationMs: 300000, result: { verdict: "correct", score: 88 } });
  db.reviews.push({ createdAt: t, durationMs: 20000, rating: "good" });
  db.cards.push({ stability: 5, lastReview: t });
}

test("renders a readable summary and JSON", () => {
  const files = progress.renderProgress({
    today: { explained: 1, mastered: 1, reviewed: 0, minutes: 5 },
    total: { conceptsMastered: 3, concepts: 10, cards: 3, remembered: 2, explained: 7, reviewed: 12, minutes: 75, averageScore: 81 },
    streak: 4,
    series: [{ day: "2026-01-01", explained: 2, mastered: 1, reviewed: 3, minutes: 10 }],
  });
  assert.match(files["README.md"], /Concepts mastered \| 3 \/ 10/);
  assert.match(files["README.md"], /Study time \| 1 h 15 min/);
  assert.match(files["README.md"], /\| 2026-01-01 \| 2 \| 1 \| 3 \| 10 \|/);
  assert.equal(JSON.parse(files["stats.json"]).streak, 4);
});

test("commits only progress/, pushes, and does nothing when unchanged", async () => {
  const { remote, local } = setupRepos();
  // Something else you have staged must not be swept into the progress commit
  fs.writeFileSync(path.join(local, "notes.txt"), "mine\n");
  git(local, "add", "notes.txt");
  updateSettings({ progress: { enabled: true, repo: local, push: true } });
  addActivity();

  const s = await progress.runNow();
  assert.equal(s.ok, true);
  assert.match(s.message, /Committed and pushed/);
  const files = git(local, "show", "--name-only", "--format=", "HEAD").split("\n").sort();
  assert.deepEqual(files, ["progress/README.md", "progress/stats.json"]);
  assert.match(git(local, "log", "-1", "--format=%s"), /^Study log \d{4}-\d{2}-\d{2}: 1 concept mastered, 1 card reviewed/);
  assert.equal(git(local, "diff", "--cached", "--name-only"), "notes.txt", "your staged file is still staged");
  assert.equal(git(remote, "rev-parse", "main"), git(local, "rev-parse", "HEAD"), "pushed");

  const again = await progress.runNow();
  assert.match(again.message, /Up to date|Nothing new/);
  assert.equal(git(remote, "rev-list", "--count", "main"), "2");
});

test("rebases onto new commits from GitHub before pushing", async () => {
  const { root, remote, local } = setupRepos();
  // Someone (e.g. an app update) pushes to GitHub in the meantime
  const other = path.join(root, "other");
  git(root, "clone", "-q", remote, other);
  git(other, "config", "user.email", "o@example.com");
  git(other, "config", "user.name", "O");
  fs.writeFileSync(path.join(other, "update.txt"), "new version\n");
  git(other, "add", ".");
  git(other, "commit", "-q", "-m", "app update");
  git(other, "push", "-q");

  updateSettings({ progress: { repo: local } });
  addActivity();
  const s = await progress.runNow();
  assert.equal(s.ok, true);
  assert.equal(git(remote, "rev-list", "--count", "main"), "3");
  assert.ok(fs.existsSync(path.join(local, "update.txt")), "local copy now has the update too");
});

test("commit-only mode does not push", async () => {
  const { remote, local } = setupRepos();
  updateSettings({ progress: { repo: local, push: false } });
  addActivity();
  const s = await progress.runNow();
  assert.match(s.message, /^Committed your progress/);
  assert.notEqual(git(remote, "rev-parse", "main"), git(local, "rev-parse", "HEAD"));
  updateSettings({ progress: { push: true } });
});

test("clear errors: not a repository, and push without credentials", async () => {
  updateSettings({ progress: { repo: tempDir("onsei-nogit-") } });
  await assert.rejects(progress.runNow(), /not a git repository/);
  assert.equal(progress.status.ok, false);

  const { local } = setupRepos();
  git(local, "remote", "set-url", "origin", "https://127.0.0.1:9/nobody/nothing.git");
  updateSettings({ progress: { repo: local } });
  addActivity();
  await assert.rejects(progress.runNow());
  assert.match(git(local, "log", "-1", "--format=%s"), /^Study log/, "the commit is kept even if the push fails");
});
