# See Claude — Setup Guide for Beginners

## What is this?

If you use **Claude Code** (the AI coding assistant in your terminal), you've probably had the problem of opening a bunch of sessions across different projects and losing track of what's running where.

**See Claude** is a tiny app that gives you a dashboard showing all your Claude Code sessions in one place — which projects they're in, whether they're actively working, and lets you click to jump to that terminal.

---

## Before You Start

You need two things installed on your Mac:

### 1. Node.js

Node.js runs the dashboard. Check if you already have it:

1. Open **Terminal** (press `Cmd + Space`, type "Terminal", hit Enter)
2. Type this and press Enter:
   ```
   node --version
   ```
3. If you see something like `v18.0.0` or higher, you're good — skip to step 2
4. If you see "command not found", install Node.js:
   - Go to **https://nodejs.org**
   - Click the big green **LTS** download button
   - Open the downloaded file and follow the installer
   - Close and reopen Terminal, then try `node --version` again

### 2. Git

Git lets you download the code. Check if you have it:

1. In Terminal, type:
   ```
   git --version
   ```
2. If you see a version number, you're good
3. If not, macOS will prompt you to install the Command Line Tools — click **Install** and wait for it to finish

---

## Installation (2 minutes)

Open Terminal and run these three commands, one at a time:

```bash
git clone https://github.com/lukejbyrne/see-claude.git
```

This downloads the code to your computer.

```bash
cd see-claude
```

This moves into the project folder.

```bash
node server.js
```

This starts the dashboard. You should see:

```
  See Claude running at http://localhost:3456
```

Now open your browser and go to **http://localhost:3456**

---

## What You'll See

A dark screen with a count of your active Claude Code sessions. Each session shows up as a little computer monitor displaying:

- **Project name** — the folder Claude is working in
- **Status** — green (actively working), yellow (thinking), grey (idle)
- **Stats** — CPU usage, memory, how long it's been running

**Click any session** to jump straight to that Terminal tab.

The dashboard refreshes automatically every 3 seconds, so you can leave it open.

---

## Stopping the Dashboard

To stop it, go to the Terminal where you ran `node server.js` and press `Ctrl + C`.

## Running It Again Later

Whenever you want to use it again:

```bash
cd see-claude
node server.js
```

Then open **http://localhost:3456** in your browser.

---

## Troubleshooting

**"command not found: node"**
→ You need to install Node.js (see the "Before You Start" section above)

**"address already in use"**
→ The dashboard is already running somewhere. Either find that Terminal tab or run: `kill $(lsof -ti:3456)` then try again.

**No sessions showing up**
→ Make sure you have at least one Claude Code session running in a Terminal tab. The dashboard only detects the CLI version of Claude Code (not the desktop app).

**Click doesn't switch Terminal tabs**
→ The click-to-focus feature uses AppleScript and only works with the built-in macOS Terminal app. If you use iTerm2 or another terminal, it won't switch tabs automatically (but the dashboard still works for monitoring).

---

That's it. No accounts, no API keys, no dependencies to install. Just clone, run, and see all your Claudes.
