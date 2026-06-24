# Google Gemini integration

Gemini conversations import into the same trail, the same way as ChatGPT — your
**prompts** and Gemini's **responses** become events tagged `google-gemini`,
paired into exchange cards and interleaved on the cross-tool timeline.

In Gemini, click **Share → Create public link**, then import it directly:

```bash
showtail import gemini https://gemini.google.com/share/<id>
# short share.gemini.google/<id> links work too
```

Showtail fetches the shared conversation, logs your **prompts** plus Gemini's
**answers**, and dedupes by Gemini's per-message ids so re-importing the same
link adds nothing. Options:

- `--no-responses` — log only your prompts, not Gemini's answers (responses are imported by default).
- `--date 2026-06-10` — place the conversation on the timeline (Gemini shares carry no per-message
  timestamps, so without this they land at import time, in order).
- `-s, --session <id>` — import into a specific session.

## If the link doesn't work

As a backup — your school blocks the link, or you'd rather not make a chat
public — **paste** the conversation instead:

```bash
showtail import gemini --paste         # copy the conversation first; reads your clipboard (add -y to skip the preview)
# or from a saved transcript file:
showtail import gemini --file my-chat.txt
```

A paste has no role labels, so **responses are only separated when the text
includes `You said:` / `Gemini said:` markers** — otherwise everything is
recorded as your prompts (Showtail never guesses from writing style). Showtail
prints back what it recorded so you can **skim** it; undo the whole batch with
`showtail import undo`. The share link is the better path when you can use it —
it captures your prompts and Gemini's answers exactly.

!!! warning "Privacy"
    A Gemini share link makes that conversation **public** on Google's servers.
    Create it, import it, then delete the link. The import itself stays local
    like everything else in Showtail.
