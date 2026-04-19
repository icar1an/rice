# Rice Field

Visualize your Claude Code sessions as little mascots working in a pixel-art rice field inside VS Code.

Every terminal running Claude Code becomes a farmer. The mascot's state mirrors what Claude is doing right now — thinking, editing files, running bash, searching the repo, waiting for your input — so you can glance at the panel and see the shape of the work across every session, across every project, at once.

![Rice Field panel](media/rice-field.html)

## Why

If you run several Claude Code sessions at the same time (one per project, or several per project), it's hard to keep track of which one is blocked on you, which one is churning, and which one just finished. Rice Field turns that state into a single ambient picture:

- **Thinking** — the farmer sits and thinks
- **Planting** — Claude is editing a file (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`)
- **Harvesting** — Claude is running a bash command
- **Walking** — Claude is reading, searching, or delegating to a subagent
- **Waiting** — Claude needs input from you (permission prompt, question)
- **Done** — the turn finished

Click a mascot to jump to its terminal. If that terminal lives in another VS Code window, Rice Field raises that window for you.

## Install

1. Install the extension from the Marketplace.
2. Run **Rice: Install Hooks** from the Command Palette. This writes `~/.claude/rice-hook.js` and wires it into `~/.claude/settings.json` so Claude Code will report session events.
3. Run **Rice: Open Field** to open the panel.
4. Start (or restart) a Claude Code session in any terminal — a mascot appears.

To remove the hooks later, run **Rice: Uninstall Hooks**. It only strips Rice Field's own entries and leaves everything else in `settings.json` intact.

## Commands

| Command | Description |
| --- | --- |
| `Rice: Open Field` | Open the Rice Field webview panel |
| `Rice: Install Hooks` | Install Claude Code hooks into `~/.claude/settings.json` |
| `Rice: Uninstall Hooks` | Remove only Rice Field's hook entries |

## How it works

Rice Field is two pieces:

- A **Claude Code hook** (`rice-hook.js`) that runs on `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, and `Notification`. For each event, it writes the current session's state to `~/.claude/rice-state/<session_id>.json`.
- A **VS Code extension** that watches that directory and renders each session as a mascot in a webview.

Because state lives on the filesystem, every VS Code window on your machine sees every Claude Code session, no matter which window launched it. Clicking a mascot drops a brief "focus request" file that the owning window's extension picks up and responds to by showing its terminal (and, on macOS, raising the window).

No network calls. No telemetry. State is local to `~/.claude/rice-state/` and is garbage-collected when the owning process exits.

## Requirements

- VS Code `1.85` or newer
- [Claude Code](https://claude.ai/claude-code) installed and runnable as `claude`
- macOS, Linux, or Windows. Cross-window raise behavior is macOS-only; clicking a mascot in a non-owning window still surfaces a helpful message on other platforms.

## Known limitations

- Mascots only appear for sessions started *after* hooks are installed. Restart any pre-existing Claude Code session after running **Rice: Install Hooks**.
- The panel is a webview, so it doesn't restore automatically across VS Code restarts — run **Rice: Open Field** again.

## License

MIT — see [LICENSE](LICENSE).
