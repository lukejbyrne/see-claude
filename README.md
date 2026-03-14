# See Claude

A tiny dashboard that shows all your running [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions in one place. See which projects they're in, whether they're working or idle, and click to jump straight to that terminal.

![See Claude](https://img.shields.io/badge/Claude_Code-Monitor-orange?style=flat-square)

## What It Does

- Detects all running Claude Code sessions on your machine
- Shows each session as a little monitor with project name, path, CPU, memory, and uptime
- Status indicators: **green** = actively working, **yellow** = thinking, **grey** = idle
- Click any session to focus that Terminal tab (macOS only)
- Auto-refreshes every 3 seconds

## Requirements

- **macOS** (uses `lsof` and AppleScript for terminal focus)
- **Node.js** v18 or higher
- At least one running Claude Code session

## Quick Start

```bash
git clone https://github.com/lukejbyrne/see-claude.git
cd see-claude
node server.js
```

Then open **http://localhost:3456** in your browser.

That's it. No dependencies to install.

## How It Works

1. Uses `pgrep` to find running `claude` processes
2. Uses `ps` and `lsof` to get each session's working directory, CPU, memory, and uptime
3. Serves a single-page dashboard on port 3456
4. When you click a session, it uses AppleScript to find and focus the matching Terminal tab

## Zero Dependencies

This is a single `server.js` file using only Node.js built-in modules (`http`, `child_process`, `path`). No `npm install` needed.

## License

MIT
