# ONSEI_LRN

Learn a PDF by **explaining it out loud**. You explain a concept in your own words; if anything is wrong, the AI tells you in text **what** is wrong and **why**. You keep explaining until you get it right, and then your explanation, in your own words, becomes a flashcard. Flashcards come back for review right before you would forget them, following the forgetting curve.

## Install (Mac, one line)

Open **Terminal**, paste this, and press Return:

```bash
curl -fsSL https://raw.githubusercontent.com/ou1051/ONSEI_LRN/feature/onsei-lrn-app/scripts/mac/bootstrap.sh | bash
```

This downloads the app to `~/ONSEI_LRN`. It also installs what's missing: Node.js (if you have Homebrew) and Claude Code. Then it sets the app up to **run in the background and start automatically when you log in**.

After that, the app is just a bookmark: **<http://localhost:3000>**. Put it on your bookmarks bar and click it whenever you want to study. You can also press ⌘ Space, type **ONSEI**, and press Return.

Two one-time steps:
- **Log in to Claude Code.** In Terminal, run `claude`, log in with your Claude Pro/Max account, then type `/exit`. The app uses your subscription through Claude Code, so there's no API key and no extra cost.
- **Use Google Chrome** for the best speech recognition, and allow the microphone the first time.

Running the same command again updates the app. Your data is kept.

## If adding a PDF says "not logged in" or shows an authentication error

The app runs in the background, and macOS often doesn't let background programs read Claude Code's login from the Keychain. You only need to fix this once:

1. Open **Settings → Claude connection** in the app.
2. In Terminal, run `claude setup-token` and approve access in the browser. Terminal prints a token that starts with `sk-ant-oat`.
3. Paste the token into Settings and press **Save & test**.

The token uses your Claude Pro/Max plan, lasts one year, and is stored only on your Mac, readable only by your user account. **Test connection** shows the exact error if something else is wrong.

## How it works

1. **Decks → Add PDF.** Claude reads the PDF and picks out the key concepts to explain.
2. Open a concept, press **Space**, and explain it out loud.
3. Finish by saying **"that's all"** (or **以上** in Japanese). Everything you said before it is submitted automatically.
4. You get feedback:
   - a **score out of 100**
   - your exact words, quoted, with **why** they're wrong and the correct idea
   - which key points you covered and which you missed
   - any jargon you should explain in plain words
5. Press **Space** and explain it again. Your earlier attempts are taken into account. Repeat until it's correct.
6. When it's correct, a flashcard is created from what you said, and its first review is scheduled.

## Review timing (forgetting curve)

Every card tracks how well you know it, using **FSRS**. FSRS is a modern, data-fitted version of Ebbinghaus's forgetting curve; Anki uses it too.

- **When a card comes back.** A card is scheduled for the moment your chance of remembering it falls to your **target retention**, 90% by default. You can change this in **Settings**.
- **How intervals grow.** Each successful review stretches the next interval: a few days, then weeks, then months. Forgetting a card shortens it again.
- **Your first review.** How many attempts the explanation took sets the first review. Right on the first try: about 4 days. Two tries: tomorrow. Three or more: a quick re-check in 10 minutes.
- **Spreading the load.** Long intervals are spread by a few percent so cards don't all pile up on the same day.

The **Cards** screen shows each card's forgetting curve, how likely you are to remember it right now, and its next review.

## Reminders and calendar

In **Settings → Review reminders**:

- **Apple Reminders**: keeps one reminder per day with reviews due ("ONSEI_LRN: review 5 cards") in its own list for the next 30 days. The reminders update automatically as you study and reach your iPhone through iCloud. The first time, macOS asks to let ONSEI_LRN control Reminders.
- **Calendar**: subscribe to the review schedule in Apple Calendar, or download an `.ics` file.

## Other screens

- **Board**: every concept in *New / Learning / Mastered* columns
- **Calendar**: explanations, concepts mastered, and cards reviewed per day, plus the reviews coming up
- **Stats**: today, the last 7 days and all time, with explanations, concepts mastered, cards reviewed, study time, your streak, average score, and daily charts
- **Review**: Anki-style flashcard review (*Show Answer → Again / Hard / Good / Easy*, with Undo)
- **Cards**: edit or delete flashcards, and export them to Anki (File → Import in Anki)
- **Settings**: language, end phrases, target retention, keyboard shortcuts, reminders

The look follows Anki desktop: same fonts, spacing, colors and backgrounds, light and dark.

## Keyboard shortcuts

All of them can be changed in **Settings → Keyboard shortcuts**. The defaults:

| Key | Action |
|---|---|
| `Space` | Start / stop recording (when you're not typing in the text box) |
| `⌥ Option` + `R` | Start / stop recording, even while typing |
| `⌘ Cmd` + `Return` | Submit your explanation |
| `Esc` | Stop recording without submitting |
| `Return` | After a correct explanation, go to the next concept |
| `Space` | Review: show the answer (press again for Good) |
| `1` – `4` | Review: Again / Hard / Good / Easy |
| `⌘ Cmd` + `Z` | Review: undo the last review |

## Everyday commands

You won't usually need these. Run them in the `~/ONSEI_LRN` folder:

| Command | What it does |
|---|---|
| `npm run update` | Get the latest version and restart |
| `npm run restart` | Restart the background service |
| `npm run logs` | Show the server log (press Ctrl+C to stop watching) |
| `npm run uninstall` | Remove the background service and the app. Your data is kept |

Without the background service, you can start it by hand. Either double-click **`ONSEI_LRN.command`** in Finder, or run `npm install && npm start`.

## Notes

- **Usage limits.** Checking an explanation counts toward your Claude Pro/Max usage limit, which is shared with claude.ai. Longer PDFs use more. If you hit the limit, it resets after a few hours.
- **Speed.** Adding a PDF takes about 30 seconds to a couple of minutes. Checking an explanation takes about 20–60 seconds.
- **Speech recognition.** It uses the browser's Web Speech API. In Chrome, audio is sent to Google for transcription.
- **End phrase.** It only submits when it's the very last thing you said. For example, "that's all there is to it" in the middle of a sentence does not count. You can change the end phrases or turn auto-submit off in **Settings**.
- **Your data.** Decks, cards and settings are stored in `data/` (`db.json` plus the PDFs). The server only listens on your own computer (`127.0.0.1`).

## Configuration

Environment variables (optional):

| Variable | Default | Description |
|---|---|---|
| `ONSEI_PROVIDER` | auto | `claude-code` (Pro/Max subscription) or `api`. If unset, `api` is used when `ANTHROPIC_API_KEY` is set |
| `ANTHROPIC_API_KEY` | – | Claude API key, for the pay-as-you-go `api` provider |
| `PORT` | `3000` | Port |
| `HOST` | `127.0.0.1` | Address to listen on |
| `ONSEI_MODEL` | Claude Code's default / `claude-opus-5-5` for the API | Model |
| `ONSEI_CLAUDE_BIN` | `claude` | Path to the Claude Code executable |
| `ONSEI_EFFORT` | `medium` | Reasoning effort, API only (`low` … `max`) |
| `ONSEI_FALLBACKS` | `1` | `0` disables server-side refusal fallbacks, API only |
| `ONSEI_DATA_DIR` | `./data` | Where decks and cards are stored |
| `ONSEI_MOCK` | – | `1` runs without AI (fake grading), for trying out the UI |

## Development

```bash
npm test           # unit and API tests (no AI calls, no network)
npm run test:e2e   # browser tests (needs Playwright with Chromium)
```

Project layout:

- `server.js`: Express API (PDFs, grading, cards, settings, reminders, stats)
- `lib/ai.js`: AI calls through the Claude Code CLI (`claude -p`) or the Claude API, with structured JSON output, error diagnosis and a connection test
- `lib/secrets.js`: the Claude Code token saved from Settings (file mode 0600)
- `lib/srs.js`: forgetting-curve scheduler (FSRS-4.5 with interval fuzz)
- `lib/reminders.js`: Apple Reminders sync (JavaScript for Automation) and the iCalendar feed
- `lib/stats.js`, `lib/settings.js`, `lib/db.js`: stats, validated settings, and the JSON store
- `public/`: front end (plain JavaScript, no build step); `keys.js` and `text.js` are shared with the tests
- `scripts/mac/`: one-line installer, background service, update, restart and uninstall for macOS
- `test/`: unit, API, and end-to-end tests
