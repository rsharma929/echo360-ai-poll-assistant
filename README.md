# Echo360 AI Poll Assistant

An AI-assisted responder for **PointSolutions / TurningPoint (ttpoll.com) / Echo360** browser
polls, with an interactive on-screen **control panel**. It reads the question that's on screen
(text, and — once the AI brain lands — slide images too) and proposes a topical answer, which you
can let it submit automatically or approve yourself.

This is a **separate, standalone project** from
[`pointsolutions-poll-automation`](https://github.com/rsharma929/pointsolutions-poll-automation)
— it shares no code; it's the AI-driven successor with a real UI.

> ⚠️ **Use responsibly.** This automates graded/attendance participation. Understand your
> institution's academic-integrity policy before using it. You are responsible for how you use it.

---

## Status

**v0.1 — offline baseline.** This first version ships the panel, live question detection, and an
**offline** answer path so you can install it and confirm it reads your polls correctly. The
**AI brain (Puter.js, then an optional Groq key) arrives in Phase 3**; offline then becomes the
last-resort fallback. For safety, **auto-submit is OFF by default** in v0.1 — it detects and
*proposes* until you turn auto-submit on in Settings.

Roadmap:
- **P1–P2 (now):** panel + detection + offline answers.
- **P3:** AI brain — Puter (keyless, vision) → optional Groq key → offline fallback; session
  memory; reading slide-image questions; the hybrid auto-submit countdown.
- **P4:** direct chat, richer log, polish.

---

## Install

You need a **userscript manager**:

| Device | Browser | Use |
|---|---|---|
| Windows / macOS | Chrome, Edge, Brave, Firefox | **Tampermonkey** |
| macOS / iPad / iPhone | Safari | **Userscripts** (import the `.user.js` file) or **Stay** |

Then add **`echo360-ai-poll-assistant.user.js`** (create a new script and paste it, or import the
file in Userscripts). It runs on `ttpoll.com`, `turningtechnologies.com`, and `echo360.com`.

---

## Using it

When you join a session, a **Poll Assistant** panel appears (top-right, draggable). It shows:

- **Current question** — the type it detected, the question text (or "shown as image"), and the
  question number this session.
- **Proposed answer** — the answer and which source produced it, with **Submit / Regenerate /
  Skip** and inline editing. With auto-submit on, a countdown submits it for you unless you step in.
- **Log / Chat / Context / Settings** tabs — a history of answers, a chat box (Phase 3), a
  **topic/context** box to steer answers, and settings (theme, text size, model, optional API key,
  and the toggles).

**First run:** leave auto-submit **off**, join a session, and watch the readout to confirm it
detects your questions. Once you trust it, turn **Auto-submit** on in Settings.

Set the day's **topic** in the Context tab (e.g. `thyroid`, `cardio`) — session titles are
usually not descriptive, so this is what makes offline answers on-topic.

---

## How answering works

1. **AI first (Phase 3):** Puter.js (no API key) reads the question/slide and answers; an optional
   per-user Groq key is a faster fallback.
2. **Offline fallback (now + always):** reads the question text, classifies it (drug / histology /
   diagnosis / outcome / mechanism / yes-no / true-false) and answers from built-in preclinical
   pools or your topic bank. This runs when the AI path is blocked (e.g. the site's CSP blocks the
   AI library), rate-limited, or too slow — so the tool **never fails to answer**, and never says
   "IDK".

Answers are aimed at *plausibility and participation*, not correctness.

---

## Privacy

Everything runs in your browser. In Phase 3, the question text and slide images you choose to send
are transmitted to the AI provider (e.g. Puter and its model providers); any API key you enter is
stored **only on your device** (`localStorage`). Nothing is sent anywhere in v0.1 (offline).

## License

MIT — see [LICENSE](LICENSE).
