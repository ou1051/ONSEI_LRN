// Simple spaced-repetition scheduler modeled on Anki (SM-2 family)
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

export const RATINGS = ["again", "hard", "good", "easy"];

export function newCardState() {
  return { due: new Date().toISOString(), interval: 0, ease: 2.5, reps: 0, lapses: 0 };
}

// Returns the next state (interval is in days; 0 means still learning)
export function schedule(card, rating, at = Date.now()) {
  let { interval, ease, reps, lapses } = card;
  let delay;
  if (rating === "again") {
    lapses += interval > 0 ? 1 : 0;
    interval = 0;
    ease = Math.max(1.3, ease - 0.2);
    delay = 10 * MIN;
  } else if (rating === "hard") {
    interval = interval === 0 ? 0 : Math.max(1, Math.round(interval * 1.2));
    ease = Math.max(1.3, ease - 0.15);
    delay = interval === 0 ? 6 * MIN : interval * DAY;
  } else if (rating === "good") {
    interval = interval === 0 ? 1 : Math.max(interval + 1, Math.round(interval * ease));
    delay = interval * DAY;
  } else {
    interval = interval === 0 ? 4 : Math.max(interval + 1, Math.round(interval * ease * 1.3));
    ease += 0.15;
    delay = interval * DAY;
  }
  return { interval, ease, reps: reps + 1, lapses, due: new Date(at + delay).toISOString() };
}

// Anki-style interval label shown above each answer button ("10m", "1d", "1.5mo", "2.1y")
export function describeDelay(card, rating) {
  const next = schedule(card, rating, 0);
  const ms = Date.parse(next.due);
  if (ms < DAY) return `${Math.round(ms / MIN)}m`;
  const d = Math.round(ms / DAY);
  if (d < 30) return `${d}d`;
  if (d < 365) return `${(d / 30).toFixed(1)}mo`;
  return `${(d / 365).toFixed(1)}y`;
}
