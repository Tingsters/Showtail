# ChatGPT integration

Students using ChatGPT can import selected conversations into the same trail.
ChatGPT cannot run commands on your machine, so this integration is
import-based.

In ChatGPT, click **Share** on a conversation, then run:

```bash
showtail import chatgpt https://chatgpt.com/share/<id>
```

Showtail fetches the shared page, logs your prompts as `prompt` events tagged
`chatgpt`, and stamps each one with its original time. This keeps the timeline
accurate even if you import at the end of a work session.

Example timeline:

```text
brainstormed in ChatGPT -> built with Copilot -> debugged in Claude Code
```

Options:

- `--no-responses` logs only your prompts. ChatGPT's answers are imported as
  `ai_output` by default.
- `--file <path>` imports from a saved share page or saved transcript instead of
  fetching the page. This is useful offline or if the share format changes.

Re-importing the same link is safe. Showtail skips messages it has already
imported by message id.

## If the share link does not work

A share link may not work if your school blocks public links, you do not want to
make the conversation public, or the fetch is blocked. In that case, copy the
conversation and import it from your clipboard:

```bash
showtail import chatgpt --paste     # reads your clipboard, shows a preview to confirm
```

Copy the conversation first, then run the command — Showtail reads it from your
clipboard and prints back what it recorded so you can skim it. Add `-y` to skip
the confirmation prompt. (Piping still works for scripts:
`cat my-chat.txt | showtail import chatgpt --paste`.)

You can also import from a saved text file:

```bash
showtail import chatgpt --file my-chat.txt
```

You do not need to clean up the pasted text first. Showtail strips common ChatGPT
interface text such as `Thought for 12s`, `Edit`, and attachment chips. It
records your prompts and prints them back so you can skim them.

If something was imported by mistake, undo the whole import in one step:

```bash
showtail import undo
```

Because pasted text does not always identify who wrote each line, responses are
only captured when the copy includes `You said:` and `ChatGPT said:` markers.
Otherwise, Showtail records the pasted text as your prompts. Showtail never
guesses based on writing style.

If the paste has no timestamps, add a date:

```bash
showtail import chatgpt --paste --date 2026-06-10
```

Imported prompts appear under **Imported from ChatGPT** in your report.

Share links are still the best option when you can use them, because they
capture responses and exact times automatically.

Import is deliberate and per conversation. Showtail does not read your full
ChatGPT history.

!!! warning "Privacy"
    A ChatGPT share link makes that conversation public on OpenAI's servers.
    Create the link, import it, then delete the link. The import itself stays
    local like everything else in Showtail.
