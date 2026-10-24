# ONSEI_LRN

Learn a PDF by **explaining it out loud**. You explain a concept in your own words; if anything is wrong, the AI tells you in text **what** is wrong and **why**. You keep explaining until you get it right, and then your explanation, in your own words, becomes a flashcard.

## How it works

1. **Decks → Add PDF.** Claude reads the PDF and picks out the key concepts to explain.
2. Open a concept, press **Space**, and explain it out loud.
3. Finish by saying **"that's all"** (or **以上** in Japanese). Everything you said before it is submitted automatically.
4. If something is wrong, you see:
   - your exact words, quoted
   - why they're wrong, based on the PDF
   - the correct idea
   - any key points you missed
5. Press **Space** and explain it again. Your earlier attempts and feedback are taken into account. Repeat until it's correct.
6. When it's correct, a flashcard is created from what you said.

Other screens:

- **Board**: every concept in *New / Learning / Mastered* columns
- **Calendar**: explanations, concepts mastered, cards reviewed, and reviews due per day, plus your study streak
- **Review**: Anki-style flashcard review (*Show Answer → Again / Hard / Good / Easy*)
- **Cards**: edit or delete your flashcards
- **Settings**: language, end phrases, auto-submit

The look follows Anki desktop: same fonts, spacing, colors and backgrounds, light and dark.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Start / stop recording (when you're not typing in the text box) |
| `⌥ Option` + `R` | Start / stop recording, even while typing |
| `⌘ Cmd` + `Enter` | Submit your explanation |
| `Esc` | Stop recording without submitting |
| `Enter` | After a correct explanation, go to the next concept |
| `Space`, `1`–`4` | Review: show answer, then Again / Hard / Good / Easy |

## Setup on a Mac (one time)

You need [Node.js](https://nodejs.org) 20 or newer, and **Claude Code** logged in with your Claude Pro/Max account. Claude Code is how the app uses your subscription; no API key is needed and there is no extra cost.

```bash
# 1. Install Claude Code and log in (a browser window opens; when you're done, type /exit)
npm install -g @anthropic-ai/claude-code
claude

# 2. Get the app and set it up
git clone -b feature/onsei-lrn-app https://github.com/ou1051/ONSEI_LRN.git
cd ONSEI_LRN
npm run setup
```

`npm run setup` does three things:

- runs ONSEI_LRN **in the background**, so you never need a terminal to start it
- **starts it automatically** when you log in to your Mac
- adds an **ONSEI_LRN app** to `~/Applications`

After that, to open the app: press **⌘ Space**, type **ONSEI**, and press Return. You can also drag `~/Applications/ONSEI_LRN.app` to your Dock, or bookmark <http://localhost:3000>.

Use **Google Chrome** for the best speech recognition. The first time you record, allow the microphone.

### Everyday commands

Run these in the `ONSEI_LRN` folder:

| Command | What it does |
|---|---|
| `npm run update` | Download the latest version and restart |
| `npm run restart` | Restart the background service |
| `npm run logs` | Show the server log (press Ctrl+C to stop watching) |
| `npm run uninstall` | Remove the background service and the app. Your data is kept |

### Without the background service

- Double-click **`ONSEI_LRN.command`** in Finder. It starts the app and opens Chrome; close the Terminal window to stop it.
- Or run `npm install && npm start`, then open <http://localhost:3000>.

### Updating

`npm run update` pulls the latest version. If it reports that it can't update automatically, the branch history changed on GitHub. Your data in `data/` is not tracked by git, so you can safely reset to the GitHub version:

```bash
git fetch origin
git reset --hard origin/feature/onsei-lrn-app
npm install && npm run restart
```

## Notes

- **Usage limits.** Checking an explanation counts toward your Claude Pro/Max usage limit, which is shared with claude.ai. Longer PDFs use more. If you hit the limit, it resets after a few hours.
- **Speed.** Adding a PDF takes about 30 seconds to a couple of minutes. Checking an explanation takes about 20–60 seconds.
- **Speech recognition.** It uses the browser's Web Speech API. In Chrome, audio is sent to Google for transcription.
- **End phrase.** Only an end phrase at the very end of what you've said submits. For example, "that's all there is to it" in the middle of a sentence does not. You can change the end phrases or turn auto-submit off in **Settings**.
- **Your data.** Decks and cards are stored in `data/` (`db.json` plus the PDFs). The server only listens on your own computer (`127.0.0.1`).

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

## Project layout

- `server.js`: Express API (PDF upload, grading, cards, activity log)
- `lib/ai.js`: AI calls through the Claude Code CLI (`claude -p`) or the Claude API, with structured JSON output
- `lib/srs.js`: Anki-style spaced-repetition scheduler
- `lib/db.js`: single-file JSON store
- `public/`: front end (plain JavaScript, no build step)
- `scripts/mac/`: background service setup, update, restart and uninstall for macOS
- `ONSEI_LRN.command`: double-click launcher for macOS
