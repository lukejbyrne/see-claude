# See Claude - Improvements

## Bugs

- **CPU-based status is unreliable** - Typing in a terminal causes CPU spikes that falsely trigger "thinking"/"working". Should detect from the session file instead: if the last message is from the user with no assistant reply yet = working, last message has tool_use = thinking, last message is assistant text = idle
- **Partial JSON at buffer boundary** - When reading the tail of a session `.jsonl` file, the first line is often a partial record that silently fails to parse. Should skip to first complete line
- **Send message only works with Terminal.app** - AppleScript keystroke approach doesn't work with iTerm2 or other terminals. Should detect which terminal is running and adapt

## Performance

- **Cache between SSE broadcasts** - `getClaudeSessions()` spawns 3-5 shell commands per process every 2 seconds. Cache with a short TTL so it's not re-running constantly
- **Debounce SSE** - If data hasn't changed since last broadcast, don't send an update
- **Watch files instead of polling** - `getRecentSessions()` stats every session file every 2 seconds. Use `fs.watch()` on the projects directory and only re-scan on change

## UX - Quick Wins

- **Better status detection** - Use session file state instead of CPU (see bugs above)
- **Truncation indicator** - Messages are sliced to 300 chars silently. Add "..." when truncated
- **Loading state** - Page briefly shows "No Claude sessions" before SSE connects. Show "Loading..." instead
- **Highlight live sessions in recent table** - Cross-reference live PIDs with recent sessions, mark which ones are currently running
- **Toast duration** - 2 seconds is too fast, bump to 3

## UX - Bigger Features

- **iTerm2 support** - Detect if user runs iTerm2 and use its AppleScript API for focus + send
- **Full conversation viewer** - Click "view all" in expanded card to see the entire session history, not just last 8 messages
- **Search/filter recent sessions** - Search box filtering by project name or first message
- **Browser notifications** - Notify when a session changes from working to idle (Claude finished)
- **Multi-line message input** - Shift+Enter for newlines, Enter to send
- **Auto-resume crashed sessions** - Detect sessions that died unexpectedly and offer one-click resume

## Nice to Have

- **`PORT` env var** - Let users pick the port instead of hardcoded 3456
- **Split HTML out of server.js** - The embedded template is getting hard to maintain
- **Mobile responsive** - Cards don't wrap well on small screens
- **Session grouping** - Group by project when multiple sessions exist for the same project
