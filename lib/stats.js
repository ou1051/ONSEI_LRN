// Learning-volume numbers for the Stats page and the progress log
import { retrievability } from "./srs.js";

const DAY = 24 * 60 * 60 * 1000;
const pad = (n) => String(n).padStart(2, "0");
export const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const startOfDay = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const emptyDay = () => ({ explained: 0, mastered: 0, reviewed: 0, minutes: 0 });

function addUp(days, keyFilter) {
  const out = emptyDay();
  for (const [k, v] of Object.entries(days)) {
    if (!keyFilter(k)) continue;
    for (const f of Object.keys(out)) out[f] += v[f];
  }
  out.minutes = Math.round(out.minutes);
  return out;
}

// db: { docs, concepts, attempts, cards, reviews }
export function computeStats(db, { now = Date.now(), days = 30 } = {}) {
  const perDay = {};
  const day = (ms) => (perDay[dayKey(ms)] ||= emptyDay());

  for (const a of db.attempts) {
    const t = Date.parse(a.createdAt);
    const d = day(t);
    d.explained += 1;
    if (a.result?.verdict === "correct") d.mastered += 1;
    d.minutes += (a.durationMs || 0) / 60000;
  }
  for (const r of db.reviews) {
    if (r.source === "explanation") continue; // already counted as an explanation
    const d = day(Date.parse(r.createdAt));
    d.reviewed += 1;
    d.minutes += (r.durationMs || 0) / 60000;
  }

  const today = dayKey(now);
  const weekStart = dayKey(startOfDay(now) - 6 * DAY);
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(startOfDay(now));
    d.setDate(d.getDate() - i);
    const k = dayKey(d.getTime());
    const v = perDay[k] || emptyDay();
    series.push({ day: k, ...v, minutes: Math.round(v.minutes * 10) / 10 });
  }

  const scores = db.attempts.map((a) => a.result?.score).filter((s) => Number.isFinite(s));
  const remembered = db.cards.filter(
    (c) => c.stability && c.lastReview && retrievability((now - Date.parse(c.lastReview)) / DAY, c.stability) >= 0.9,
  ).length;

  // Consecutive days with any study, ending today (or yesterday if nothing yet today)
  let streak = 0;
  for (let t = startOfDay(now); ; t -= DAY) {
    const v = perDay[dayKey(t + DAY / 2)];
    if (v && (v.explained || v.reviewed)) streak++;
    else if (dayKey(t + DAY / 2) !== today) break;
  }

  return {
    today: addUp(perDay, (k) => k === today),
    week: addUp(perDay, (k) => k >= weekStart && k <= today),
    total: {
      ...addUp(perDay, () => true),
      concepts: db.concepts.length,
      // Concepts you have explained correctly at least once
      conceptsMastered: new Set(db.attempts.filter((a) => a.result?.verdict === "correct").map((a) => a.conceptId)).size,
      cards: db.cards.length,
      remembered,
      decks: db.docs.length,
      averageScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    },
    streak,
    series,
  };
}
