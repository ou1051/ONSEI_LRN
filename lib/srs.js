// Spaced repetition based on the forgetting curve.
//
// Each card has a memory *stability* S (days) and *difficulty* D (1-10). The chance you still
// remember it t days after the last review follows a forgetting curve:
//     R(t) = (1 + F * t / S) ^ C        (R = 90% when t = S)
// A review is scheduled for the moment R is predicted to drop to your target retention, so you
// review right before you would forget. Every successful review makes the memory more stable and
// stretches the next interval (the "spacing effect"); forgetting shrinks it again.
//
// This is FSRS-4.5 (Free Spaced Repetition Scheduler, also used by Anki) with its default
// parameters, a modern, data-fitted version of Ebbinghaus's forgetting curve.

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const W = [0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755];
const DECAY = -0.5;
const FACTOR = 19 / 81;
const MAX_INTERVAL_DAYS = 36500;
const RELEARN_DELAY = 10 * MIN;

export const RATINGS = ["again", "hard", "good", "easy"];
const GRADE = { again: 1, hard: 2, good: 3, easy: 4 };
export const DEFAULT_RETENTION = 0.9;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Predicted probability of recalling the card after `days` days
export const retrievability = (days, stability) => Math.pow(1 + (FACTOR * Math.max(0, days)) / stability, DECAY);

// Days until retrievability falls to `retention`
const intervalDays = (stability, retention) => (stability / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1);

const initDifficulty = (g) => clamp(W[4] - (g - 3) * W[5], 1, 10);
const nextDifficulty = (d, g) => clamp(W[7] * initDifficulty(4) + (1 - W[7]) * (d - W[6] * (g - 3)), 1, 10);

function recallStability(d, s, r, g) {
  const hard = g === 2 ? W[15] : 1;
  const easy = g === 4 ? W[16] : 1;
  return s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp((1 - r) * W[10]) - 1) * hard * easy);
}

const forgetStability = (d, s, r) =>
  Math.min(s, W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp((1 - r) * W[14]));

const startOfDay = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

// Spreads longer intervals by a few percent so cards learned together do not all come due on
// the same day (the "fuzz" used by Anki and FSRS). It is deterministic per card and review, so the
// interval shown on a button is exactly the one you get.
const FUZZ_RANGES = [
  { start: 2.5, end: 7, factor: 0.15 },
  { start: 7, end: 20, factor: 0.1 },
  { start: 20, end: Infinity, factor: 0.05 },
];

function seededRandom(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function fuzzDays(days, seed) {
  if (days < 2.5 || seed == null) return days;
  const delta = FUZZ_RANGES.reduce((sum, r) => sum + r.factor * Math.max(Math.min(days, r.end) - r.start, 0), 1);
  const lo = Math.max(2, Math.round(days - delta));
  const hi = Math.min(MAX_INTERVAL_DAYS, Math.round(days + delta));
  return Math.floor(seededRandom(seed) * (hi - lo + 1) + lo);
}

// Turns an interval into a due time. Intervals of a day or more land at the start of that day
// (so they show up in that day's reminder); shorter ones are exact.
function dueAfter(days, at) {
  if (days < 1) return new Date(at + Math.max(days * DAY, RELEARN_DELAY)).toISOString();
  const whole = Math.min(MAX_INTERVAL_DAYS, Math.round(days));
  const d = new Date(startOfDay(at));
  d.setDate(d.getDate() + whole);
  return d.toISOString();
}

const elapsedDays = (card, at) => (card.lastReview ? Math.max(0, (at - Date.parse(card.lastReview)) / DAY) : 0);

// Upgrades cards saved by the earlier SM-2 style scheduler
export function migrateCard(card) {
  if (card.stability) return card;
  card.stability = Math.max(card.interval || 0, W[2]);
  card.difficulty = 5;
  card.state = card.interval > 0 ? "review" : "learning";
  card.lastReview = card.updatedAt || card.createdAt;
  delete card.interval;
  delete card.ease;
  return card;
}

// Computes the next state for each rating without changing the card.
// `seed` (normally the card id) makes the fuzz deterministic; without one there is no fuzz.
export function preview(card, retention = DEFAULT_RETENTION, at = Date.now(), seed = card.id) {
  const out = {};
  const isNew = !card.stability;
  const r = isNew ? 1 : retrievability(elapsedDays(card, at), card.stability);

  const days = {};
  for (const rating of RATINGS) {
    const g = GRADE[rating];
    let stability;
    let difficulty;
    if (isNew) {
      stability = W[g - 1];
      difficulty = initDifficulty(g);
    } else {
      difficulty = nextDifficulty(card.difficulty, g);
      stability = g === 1 ? forgetStability(card.difficulty, card.stability, r) : recallStability(card.difficulty, card.stability, r, g);
    }
    stability = clamp(stability, 0.01, MAX_INTERVAL_DAYS);
    days[rating] = g === 1 ? 0 : fuzzDays(intervalDays(stability, retention), seed == null ? null : `${seed}:${card.reps || 0}:${rating}`);
    out[rating] = { stability, difficulty };
  }

  // Keep the buttons in order: Hard <= Good < Easy (whole days once intervals reach a day)
  const whole = (d) => (d < 1 ? d : Math.min(MAX_INTERVAL_DAYS, Math.round(d)));
  for (const r of ["hard", "good", "easy"]) days[r] = whole(days[r]);
  days.hard = Math.min(days.hard, days.good);
  if (days.good >= 1) days.easy = Math.max(days.easy, days.good + 1);

  for (const rating of RATINGS) {
    const again = rating === "again";
    out[rating] = {
      ...out[rating],
      days: again ? RELEARN_DELAY / DAY : days[rating],
      state: again ? (isNew ? "learning" : "relearning") : "review",
      due: again ? new Date(at + RELEARN_DELAY).toISOString() : dueAfter(days[rating], at),
      lastReview: new Date(at).toISOString(),
      reps: (card.reps || 0) + 1,
      lapses: (card.lapses || 0) + (again && card.state === "review" ? 1 : 0),
    };
  }
  return out;
}

// The new card fields after answering with `rating`
export function schedule(card, rating, retention = DEFAULT_RETENTION, at = Date.now(), seed = card.id) {
  const { days, ...fields } = preview(card, retention, at, seed)[rating];
  return fields;
}

// New due date for a card after the target retention changes (cards still in a short
// learning/relearning step keep theirs)
export function rescheduleDue(card, retention) {
  if (card.state !== "review" || !card.stability || !card.lastReview) return card.due;
  const days = fuzzDays(intervalDays(card.stability, retention), card.id == null ? null : `${card.id}:${card.reps || 0}:good`);
  return dueAfter(days < 1 ? days : Math.round(days), Date.parse(card.lastReview));
}

// A brand-new card is scheduled as if its first review just happened, graded by how many
// attempts it took to explain the concept correctly (1 = good, 2 = hard, 3+ = again).
export const gradeFromAttempts = (attempts) => (attempts <= 1 ? "good" : attempts === 2 ? "hard" : "again");

// Anki-style label for an interval in days ("10m", "5h", "3d", "1.5mo", "2.1y")
export function describeInterval(days) {
  const ms = Math.max(0, days) * DAY;
  if (ms < 60 * MIN) return `${Math.max(1, Math.round(ms / MIN))}m`;
  if (ms < DAY) return `${Math.round(ms / (60 * MIN))}h`;
  const d = Math.round(days);
  if (d < 30) return `${d}d`;
  if (d < 365) return `${(d / 30).toFixed(1)}mo`;
  return `${(d / 365).toFixed(1)}y`;
}

// Memory info shown in the UI
export function memoryInfo(card, at = Date.now()) {
  if (!card.stability) return null;
  return {
    retention: retrievability(elapsedDays(card, at), card.stability),
    stability: card.stability,
    difficulty: card.difficulty,
  };
}
