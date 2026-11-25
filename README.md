# session-hub

A side pane for Claude Code that shows what the current session is using and doing, and rewrites your prompts before they run.

Open it with `/session-hub`.

## What the pane shows

- **Usage:** context window use, token count, and cost for the session. Meters turn yellow at 70% and red at 90%.
- **Rate limits:** the 5-hour and 7-day limits, when the session reports them.
- **Working agents:** how many subagents are running.
- **Project tree:** the project's files and folders, up to three levels deep. Changed files are marked: edited files in green, deleted files in red. Folders can be collapsed or expanded, filtered with the search box, and refreshed with the Refresh button. Folders named `node_modules` and entries starting with `.` are hidden.
- **Last refined prompt:** the most recent prompt the refiner rewrote.

## Prompt refiner

Before a prompt runs, the refiner sends it to a small model (Haiku) and proceeds with the rewritten version.

- It waits until you stop typing for 3 seconds before it refines.
- Slash commands are never refined.
- Text with fewer than three words that contain letters is passed through unchanged.
- If the model fails, returns nothing usable, or returns a refusal, the original prompt is used.
- Each refinement is one short model call, so it uses a small amount of tokens.

Turn the refiner off or on with the button in the pane. Its status (Idle, Waiting, Refining, Suggestion ready, No answer) is shown next to the button.

## Project layout

- `hooks/register.tsx`: the pane, the prompt refiner, and the project tree.
- `hooks/refine.test.ts`: tests for the refiner and tree helpers.
- `hooks/hooks.json`: points the plugin at `register.tsx`.
- `types/index.d.ts`: shared types for the plugin.
- `.claude-plugin/plugin.json`: the plugin manifest (name, version, description).
- `.claude-plugin/types/`: type definitions for Claude Code, Claude Code MCP, and Claude Code tools.

## Version

0.1.0
