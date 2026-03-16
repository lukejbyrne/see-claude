const http = require('http');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 3456;
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

// --- Live sessions ---

function getClaudeSessions() {
  try {
    const pids = execSync("pgrep -x claude 2>/dev/null || true", { encoding: 'utf8' }).trim();
    if (!pids) return [];

    return pids.split('\n').filter(Boolean).map(pid => {
      try {
        const info = execSync(`ps -o pid=,tty=,%cpu=,%mem=,etime=,state= -p ${pid} 2>/dev/null`, { encoding: 'utf8' }).trim();
        if (!info) return null;
        const [pidStr, tty, cpu, mem, elapsed, state] = info.split(/\s+/);

        let cwd = '';
        try { cwd = execSync(`lsof -p ${pid} 2>/dev/null | grep cwd | awk '{print $NF}'`, { encoding: 'utf8' }).trim(); } catch {}
        if (!cwd) try { cwd = execSync(`lsof -p ${pid} -Fn 2>/dev/null | grep '^n/' | head -1`, { encoding: 'utf8' }).trim().replace(/^n/, ''); } catch {}

        // Get recent messages from session file
        const messages = getSessionMessages(cwd, 20);

        // Determine status from session file + CPU
        let status = 'idle';
        const cpuNum = parseFloat(cpu);
        if (messages.length) {
          const last = messages[messages.length - 1];
          if (last.role === 'user') status = 'working'; // waiting for Claude to respond
          else if (last.hasToolUse) status = 'thinking'; // Claude is using tools
        }
        // If file says idle but CPU is high, Claude is actively working
        // (mid-response, or file hasn't been flushed yet)
        if (status === 'idle' && cpuNum > 10) status = 'working';

        return {
          pid: pidStr, tty, cpu: `${cpu}%`, mem: `${mem}%`, elapsed, cwd,
          projectName: cwd ? path.basename(cwd) : 'unknown',
          status,
          messages,
        };
      } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function getSessionMessages(cwd, count = 20) {
  if (!cwd) return [];
  const projKey = cwd.replace(/\//g, '-');
  const projDir = path.join(PROJECTS_DIR, projKey);
  try {
    if (!fs.existsSync(projDir)) return [];
    const files = fs.readdirSync(projDir)
      .filter(f => f.endsWith('.jsonl') && !f.includes('subagent'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(projDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return [];

    const filePath = path.join(projDir, files[0].name);
    const stat = fs.statSync(filePath);
    // Read last 64KB to get enough messages
    const readSize = Math.min(stat.size, 65536);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
    fs.closeSync(fd);

    const msgs = [];
    for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
      try {
        const d = JSON.parse(line);
        const role = d.message?.role;
        if (role !== 'user' && role !== 'assistant') continue;
        const content = d.message.content;
        let text = '';
        let hasToolUse = false;
        let hasToolResult = false;
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content)) {
          for (const c of content) {
            if (c.type === 'text' && c.text?.trim() && !text) text = c.text.trim();
            if (c.type === 'tool_use') hasToolUse = true;
            if (c.type === 'tool_result') hasToolResult = true;
          }
        }
        // Always track the message for status, even without display text
        if (text) {
          msgs.push({ role, text: text.slice(0, 300), hasToolUse, hasToolResult });
        } else if (hasToolUse || hasToolResult) {
          // Tool messages without visible text - still track for status
          msgs.push({ role, text: hasToolUse ? '(using tools...)' : '(tool result)', hasToolUse, hasToolResult });
        }
      } catch {}
    }
    return msgs.slice(-count);
  } catch { return []; }
}

// --- Recent sessions ---

function getRecentSessions(limit = 20) {
  try {
    if (!fs.existsSync(PROJECTS_DIR)) return [];
    const sessions = [];
    for (const projDir of fs.readdirSync(PROJECTS_DIR)) {
      const projPath = path.join(PROJECTS_DIR, projDir);
      if (!fs.statSync(projPath).isDirectory()) continue;
      for (const file of fs.readdirSync(projPath).filter(f => f.endsWith('.jsonl') && !f.includes('subagent'))) {
        const filePath = path.join(projPath, file);
        const stat = fs.statSync(filePath);
        let projectName = projDir.replace(/-Users-[^-]+-Documents-/, '').replace(/-Users-[^-]+-Downloads-?/, '~/Downloads/').replace(/-Users-[^-]+-/, '~/').replace(/^-Users-[^-]+$/, '~');
        let firstMessage = '';
        try {
          const fd = fs.openSync(filePath, 'r');
          const buf = Buffer.alloc(8192);
          const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
          fs.closeSync(fd);
          for (const line of buf.toString('utf8', 0, bytesRead).split('\n').filter(Boolean)) {
            try {
              const d = JSON.parse(line);
              if (d.type === 'user' && d.message?.role === 'user') {
                const content = d.message.content;
                if (typeof content === 'string') firstMessage = content.slice(0, 120);
                else if (Array.isArray(content)) { for (const c of content) { if (c.type === 'text') { firstMessage = c.text.slice(0, 120); break; } } }
                break;
              }
            } catch {}
          }
        } catch {}
        sessions.push({
          sessionId: path.basename(file, '.jsonl'), projectName, cwd: projDir.replace(/-/g, '/'),
          lastModified: stat.mtimeMs, lastModifiedStr: formatTimeAgo(stat.mtime), firstMessage: firstMessage || '(no message)',
        });
      }
    }
    return sessions.sort((a, b) => b.lastModified - a.lastModified).slice(0, limit);
  } catch { return []; }
}

// --- Project roster ---

function getProjectRoster() {
  try {
    if (!fs.existsSync(PROJECTS_DIR)) return [];
    const projects = [];
    for (const projDir of fs.readdirSync(PROJECTS_DIR)) {
      const projPath = path.join(PROJECTS_DIR, projDir);
      if (!fs.statSync(projPath).isDirectory()) continue;
      const files = fs.readdirSync(projPath)
        .filter(f => f.endsWith('.jsonl') && !f.includes('subagent'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(projPath, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (!files.length) continue;

      // Reconstruct the real path from the dir name
      const cwd = projDir.replace(/-/g, '/');
      let projectName = projDir
        .replace(/-Users-[^-]+-Documents-/, '')
        .replace(/-Users-[^-]+-Downloads-?/, '~/Downloads/')
        .replace(/-Users-[^-]+-/, '~/')
        .replace(/^-Users-[^-]+$/, '~');

      // Get latest session ID and first message
      const latestSession = path.basename(files[0].name, '.jsonl');
      let firstMessage = '';
      try {
        const fd = fs.openSync(path.join(projPath, files[0].name), 'r');
        const buf = Buffer.alloc(8192);
        const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
        fs.closeSync(fd);
        for (const line of buf.toString('utf8', 0, bytesRead).split('\n').filter(Boolean)) {
          try {
            const d = JSON.parse(line);
            if (d.type === 'user' && d.message?.role === 'user') {
              const content = d.message.content;
              if (typeof content === 'string') firstMessage = content.slice(0, 120);
              else if (Array.isArray(content)) { for (const c of content) { if (c.type === 'text') { firstMessage = c.text.slice(0, 120); break; } } }
              break;
            }
          } catch {}
        }
      } catch {}

      projects.push({
        dirKey: projDir,
        cwd,
        projectName,
        latestSession,
        sessionCount: files.length,
        lastModified: files[0].mtime,
        lastModifiedStr: formatTimeAgo(new Date(files[0].mtime)),
        firstMessage: firstMessage || '(no message)',
      });
    }
    return projects.sort((a, b) => b.lastModified - a.lastModified);
  } catch { return []; }
}

function formatTimeAgo(date) {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// --- SSE ---
const sseClients = new Set();
setInterval(() => {
  const data = JSON.stringify({ live: getClaudeSessions(), recent: getRecentSessions(), roster: getProjectRoster() });
  for (const res of sseClients) {
    try { res.write(`data: ${data}\n\n`); } catch { sseClients.delete(res); }
  }
}, 2000);

// --- HTML ---
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>See Claude</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background: #0a0a0a;
    color: #e0e0e0;
    font-family: 'JetBrains Mono', monospace;
    min-height: 100vh;
  }

  .container {
    display: flex;
    flex-direction: column;
    align-items: center;
    min-height: 100vh;
    padding: 30px 40px;
    max-width: 1400px;
    margin: 0 auto;
  }

  .header { text-align: center; margin-bottom: 24px; }
  .header h1 { font-size: 14px; font-weight: 300; color: #555; letter-spacing: 4px; text-transform: uppercase; }
  .header .count { font-size: 48px; font-weight: 700; color: #fff; margin: 5px 0; }
  .header .subtitle { font-size: 12px; color: #444; letter-spacing: 2px; }

  .live-dot {
    display: inline-block; width: 6px; height: 6px; background: #27c93f;
    border-radius: 50%; margin-right: 6px; animation: pulse 2s ease-in-out infinite;
  }
  .live-badge {
    display: inline-block; font-size: 9px; color: #27c93f;
    border: 1px solid #27c93f33; padding: 2px 8px; border-radius: 10px; margin-left: 8px; letter-spacing: 1px;
  }

  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

  .section-title {
    font-size: 11px; font-weight: 300; color: #444; letter-spacing: 3px;
    text-transform: uppercase; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 1px solid #1a1a1a;
    display: flex; align-items: center; justify-content: space-between;
  }
  .new-session-btn {
    font-family: 'JetBrains Mono', monospace; font-size: 10px;
    background: transparent; border: 1px dashed #333; color: #555;
    padding: 4px 12px; border-radius: 4px; cursor: pointer;
    transition: all 0.2s; letter-spacing: 1px;
  }
  .new-session-btn:hover { border-color: #cc7832; color: #cc7832; }

  #live-section { width: 100%; }

  .grid {
    display: flex; flex-wrap: wrap; justify-content: center;
    gap: 20px; margin-bottom: 40px; width: 100%;
  }

  /* --- Station card --- */
  .station {
    width: 260px; cursor: pointer; transition: transform 0.2s; position: relative;
  }
  .station:hover { transform: translateY(-3px); }
  .station.expanded {
    width: 500px; cursor: default;
  }
  .station.expanded:hover { transform: none; }

  @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  .station.entering { animation: fadeIn 0.3s ease forwards; }

  .monitor {
    background: #111; border: 1px solid #222; border-radius: 8px;
    padding: 12px; position: relative; overflow: hidden;
  }
  .monitor::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px;
    background: linear-gradient(90deg, transparent, #333, transparent);
  }

  .station.working .monitor { border-color: #27c93f22; }
  .station.thinking .monitor { border-color: #ffbd2e22; }

  .screen {
    background: #0d1117; border: 1px solid #1a1a2e; border-radius: 4px;
    padding: 10px; position: relative;
  }

  .screen-header {
    display: flex; align-items: center; gap: 6px;
    margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid #1a1a2e;
  }
  .dot { width: 6px; height: 6px; border-radius: 50%; }
  .dot.red { background: #ff5f56; }
  .dot.yellow { background: #ffbd2e; }
  .dot.green { background: #27c93f; }
  .screen-status {
    font-size: 9px; margin-left: auto; text-transform: uppercase; letter-spacing: 1px;
  }

  .project-name { font-size: 14px; font-weight: 500; color: #e0e0e0; margin-bottom: 2px; }
  .project-path { font-size: 9px; color: #393939; word-break: break-all; margin-bottom: 4px; }
  .first-prompt {
    font-size: 9px; color: #666; font-style: italic; margin-bottom: 6px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  /* Last message preview (collapsed) */
  .last-msg-preview {
    font-size: 11px; color: #888; margin: 6px 0; line-height: 1.5;
    max-height: 52px; overflow: hidden; display: -webkit-box;
    -webkit-line-clamp: 3; -webkit-box-orient: vertical;
  }
  .msg-label {
    font-size: 8px; text-transform: uppercase; letter-spacing: 1px; margin-right: 4px;
  }
  .msg-label.claude { color: #cc7832; }
  .msg-label.you { color: #6a9eff; }

  .stats {
    display: flex; gap: 10px; margin-top: 6px; font-size: 9px; color: #444;
    padding-top: 6px; border-top: 1px solid #1a1a2e;
  }
  .stat-label { color: #333; }
  .stat-value { color: #555; }

  .stand { width: 40px; height: 10px; background: #181818; margin: 0 auto; border-radius: 0 0 4px 4px; }
  .base { width: 60px; height: 3px; background: #181818; margin: 0 auto; border-radius: 2px; }

  .quick-terminal {
    background: #1a2e1a; border: 1px solid #2a3e2a; color: #4a4;
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px; padding: 4px 10px;
    border-radius: 4px; cursor: pointer; transition: all 0.2s;
    display: block; margin: 6px auto 0; text-align: center;
    opacity: 0.5;
  }
  .station:hover .quick-terminal { opacity: 1; }
  .quick-terminal:hover { background: #2a3e2a; color: #27c93f; border-color: #27c93f; }

  /* --- Expanded view --- */
  .expanded-content { display: none; }
  .station.expanded .expanded-content { display: block; }
  .station.expanded .last-msg-preview { display: none; }
  .station.expanded .stand, .station.expanded .base { display: none; }

  .msg-history {
    margin: 8px 0; max-height: 300px; overflow-y: auto;
    scrollbar-width: thin; scrollbar-color: #333 transparent;
  }
  .msg-history::-webkit-scrollbar { width: 4px; }
  .msg-history::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }

  .msg-bubble {
    margin-bottom: 8px; font-size: 11px; line-height: 1.5;
  }
  .msg-bubble .msg-role {
    font-size: 8px; text-transform: uppercase; letter-spacing: 1px;
    margin-bottom: 2px; display: block;
  }
  .msg-bubble .msg-text {
    color: #999; padding: 6px 8px; background: #0a0e14; border-radius: 4px;
    white-space: pre-wrap; word-break: break-word;
  }
  .msg-bubble.assistant .msg-role { color: #cc7832; }
  .msg-bubble.user .msg-role { color: #6a9eff; }
  .msg-bubble.user .msg-text { background: #0d1220; color: #8ab4f8; }

  .expanded-actions {
    display: flex; gap: 6px; margin-top: 8px; align-items: center;
  }

  .chat-input {
    flex: 1; background: #0d1117; border: 1px solid #2a2a3e; color: #e0e0e0;
    font-family: 'JetBrains Mono', monospace; font-size: 11px;
    padding: 8px 10px; border-radius: 4px; outline: none;
  }
  .chat-input:focus { border-color: #cc7832; }
  .chat-input::placeholder { color: #333; }

  .btn {
    font-family: 'JetBrains Mono', monospace; font-size: 10px;
    padding: 8px 12px; border-radius: 4px; cursor: pointer;
    transition: all 0.2s; border: 1px solid; white-space: nowrap;
  }
  .btn-send {
    background: #1a1a2e; border-color: #2a2a3e; color: #cc7832;
  }
  .btn-send:hover { background: #2a2a3e; border-color: #cc7832; }
  .btn-terminal {
    background: #1a2e1a; border-color: #2a3e2a; color: #6a6;
  }
  .btn-terminal:hover { background: #2a3e2a; border-color: #27c93f; color: #27c93f; }
  .btn-close {
    background: transparent; border-color: #222; color: #444;
  }
  .btn-close:hover { border-color: #444; color: #888; }

  .sent-flash {
    font-size: 9px; color: #27c93f; margin-left: 8px;
    opacity: 0; transition: opacity 0.3s;
  }
  .sent-flash.visible { opacity: 1; }

  .recent-section { margin-top: auto; padding-top: 20px; width: 100%; max-height: 350px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: #333 transparent; }
  .recent-section::-webkit-scrollbar { width: 4px; }
  .recent-section::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
  .recent-live td { color: #888 !important; }
  .recent-table { width: 100%; border-collapse: collapse; }
  .recent-table th {
    font-size: 9px; font-weight: 400; color: #444; text-transform: uppercase;
    letter-spacing: 2px; text-align: left; padding: 8px 12px; border-bottom: 1px solid #1a1a1a;
  }
  .recent-table td {
    font-size: 12px; padding: 10px 12px; border-bottom: 1px solid #111; color: #666; vertical-align: top;
  }
  .recent-row { cursor: pointer; transition: background 0.15s; }
  .recent-row:hover { background: #111; }
  .recent-row:hover td { color: #999; }
  .recent-project { color: #aaa; font-weight: 500; }
  .recent-message { color: #555; font-size: 11px; max-width: 500px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .recent-time { color: #444; font-size: 11px; white-space: nowrap; }
  .btn-group { display: flex; gap: 4px; }

  .resume-btn, .launch-btn {
    font-family: 'JetBrains Mono', monospace; font-size: 10px;
    padding: 4px 10px; border-radius: 4px; cursor: pointer; transition: all 0.2s; white-space: nowrap;
  }
  .resume-btn { background: #1a1a2e; border: 1px solid #2a2a3e; color: #888; }
  .resume-btn:hover { background: #2a2a3e; color: #cc7832; border-color: #cc7832; }
  .launch-btn { background: #1a2e1a; border: 1px solid #2a3e2a; color: #6a6; margin-left: 4px; }
  .launch-btn:hover { background: #2a3e2a; color: #27c93f; border-color: #27c93f; }

  .copy-toast {
    position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%) translateY(20px);
    background: #1a1a2e; border: 1px solid #cc7832; color: #cc7832;
    padding: 8px 20px; border-radius: 6px; font-size: 12px;
    font-family: 'JetBrains Mono', monospace; opacity: 0;
    transition: all 0.3s ease; pointer-events: none; z-index: 100;
  }
  .copy-toast.visible { opacity: 1; transform: translateX(-50%) translateY(0); }

  /* New session card */
  .new-screen {
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; min-height: 120px;
  }
  .new-plus {
    font-size: 36px; font-weight: 200; color: #333;
    transition: color 0.2s;
  }
  .new-label {
    font-size: 10px; color: #333; text-transform: uppercase;
    letter-spacing: 2px; margin-top: 4px; transition: color 0.2s;
  }
  .station.new-session:hover .new-plus { color: #cc7832; }
  .station.new-session:hover .new-label { color: #cc7832; }
  .station.new-session .monitor { border-style: dashed; }

  /* New session modal */
  .modal-overlay {
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.7); z-index: 200;
    display: flex; align-items: center; justify-content: center;
    opacity: 0; pointer-events: none; transition: opacity 0.2s;
  }
  .modal-overlay.visible { opacity: 1; pointer-events: all; }
  .modal {
    background: #111; border: 1px solid #222; border-radius: 8px;
    padding: 24px; width: 420px; max-width: 90vw;
  }
  .modal h2 {
    font-size: 14px; font-weight: 400; color: #ccc;
    margin-bottom: 16px; letter-spacing: 1px;
  }
  .modal-field { margin-bottom: 12px; }
  .modal-field label {
    display: block; font-size: 10px; color: #555;
    text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px;
  }
  .modal-input {
    width: 100%; background: #0d1117; border: 1px solid #2a2a3e; color: #e0e0e0;
    font-family: 'JetBrains Mono', monospace; font-size: 12px;
    padding: 10px 12px; border-radius: 4px; outline: none;
  }
  .modal-input:focus { border-color: #cc7832; }
  .modal-input::placeholder { color: #333; }
  .modal-actions { display: flex; gap: 8px; margin-top: 16px; justify-content: flex-end; }
  .dir-browser {
    max-height: 180px; overflow-y: auto; margin-top: 6px;
    background: #0a0e14; border: 1px solid #1a1a2e; border-radius: 4px;
    scrollbar-width: thin; scrollbar-color: #333 transparent;
  }
  .dir-browser::-webkit-scrollbar { width: 4px; }
  .dir-browser::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
  .dir-entry {
    padding: 6px 10px; font-size: 11px; color: #888; cursor: pointer;
    display: flex; align-items: center; gap: 6px; transition: background 0.1s;
  }
  .dir-entry:hover { background: #1a1a2e; color: #cc7832; }
  .dir-icon { color: #555; font-size: 10px; }
  .dir-up { color: #666; font-style: italic; }
  .modal-check {
    display: flex; align-items: center; gap: 8px; margin-top: 4px;
  }
  .modal-check input[type="checkbox"] { accent-color: #cc7832; }
  .modal-check label { font-size: 10px; color: #555; cursor: pointer; }

  /* View toggle */
  .view-toggle {
    position: fixed; top: 16px; right: 20px; z-index: 50;
    display: flex; gap: 0;
  }
  .view-btn {
    background: #111; border: 1px solid #222; color: #444;
    font-family: 'JetBrains Mono', monospace; font-size: 10px;
    padding: 6px 14px; cursor: pointer; transition: all 0.2s;
  }
  .view-btn:first-child { border-radius: 4px 0 0 4px; }
  .view-btn:last-child { border-radius: 0 4px 4px 0; border-left: none; }
  .view-btn.active { background: #1a1a2e; color: #cc7832; border-color: #cc783244; }

  /* Pixel art view */
  .pixel-view { display: none; width: 100%; }
  .pixel-view.active { display: block; }
  .pixel-office {
    position: relative;
    background: linear-gradient(180deg, #1a1a2e 0%, #16213e 40%, #1a1a2a 40.1%, #151520 100%);
    border-radius: 8px; overflow: hidden; padding: 0;
    min-height: 200px;
  }
  .office-wall {
    position: absolute; top: 0; left: 0; right: 0; height: 40%;
    pointer-events: none; z-index: 0;
  }
  .office-window {
    position: absolute; top: 12%; left: 50%; transform: translateX(-50%);
    border: 3px solid #333; border-radius: 2px; overflow: hidden;
    width: 120px; height: 60px; z-index: 1;
  }
  .office-window-sky {
    width: 100%; height: 100%;
    transition: background 2s;
  }
  .office-window-frame {
    position: absolute; top: 0; left: 50%; width: 3px; height: 100%;
    background: #333; transform: translateX(-50%);
  }
  .office-window-frame-h {
    position: absolute; top: 50%; left: 0; width: 100%; height: 3px;
    background: #333; transform: translateY(-50%);
  }
  .office-floor-line {
    position: absolute; top: 40%; left: 0; right: 0; height: 2px;
    background: #2a2a3a; z-index: 0;
  }
  .pixel-floor {
    display: flex; flex-wrap: wrap; justify-content: center;
    gap: 40px; padding: 80px 20px 20px;
    position: relative; z-index: 2;
  }
  .office-clock {
    position: absolute; top: 8%; right: 15%; font-size: 10px;
    color: #555; font-family: 'JetBrains Mono', monospace; z-index: 1;
    background: #1a1a28; border: 1px solid #2a2a3a; padding: 2px 6px; border-radius: 2px;
  }
  .office-poster {
    position: absolute; top: 10%; left: 12%; width: 40px; height: 50px;
    background: #222; border: 2px solid #333; border-radius: 1px; z-index: 1;
    display: flex; align-items: center; justify-content: center;
    font-size: 16px; color: #cc7832;
  }
  .pixel-station {
    display: flex; flex-direction: column; align-items: center;
    cursor: pointer; transition: transform 0.2s;
  }
  .pixel-station:hover { transform: translateY(-4px); }
  .pixel-label {
    font-size: 11px; color: #888; margin-top: 8px; text-align: center;
  }
  .pixel-status {
    font-size: 9px; text-transform: uppercase; letter-spacing: 1px; margin-top: 2px;
  }
  .pixel-station.offline { opacity: 0.5; }
  .pixel-station.offline:hover { opacity: 0.8; }
  .pixel-last-active {
    font-size: 8px; color: #444; margin-top: 2px;
  }

  /* Pixel modal overlay */
  .pixel-modal-overlay {
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.75); z-index: 150;
    display: flex; align-items: center; justify-content: center;
    opacity: 0; pointer-events: none; transition: opacity 0.2s;
  }
  .pixel-modal-overlay.visible { opacity: 1; pointer-events: all; }
  .pixel-dialog {
    background: #111; border: 1px solid #222; border-radius: 8px;
    padding: 16px; width: 460px; max-width: 90vw; max-height: 80vh;
    display: flex; flex-direction: column;
  }
  .pixel-dialog-header {
    display: flex; align-items: center; gap: 10px; margin-bottom: 10px;
    padding-bottom: 8px; border-bottom: 1px solid #1a1a1a;
  }
  .pixel-dialog-header .project-name { font-size: 14px; font-weight: 500; }
  .pixel-dialog-header .screen-status { font-size: 9px; text-transform: uppercase; letter-spacing: 1px; margin-left: auto; }

  /* Recent section collapse */
  .recent-toggle {
    cursor: pointer; display: flex; align-items: center; gap: 8px;
    user-select: none;
  }
  .recent-toggle .arrow {
    font-size: 10px; color: #444; transition: transform 0.2s;
    display: inline-block;
  }
  .recent-toggle .arrow.collapsed { transform: rotate(-90deg); }
  .recent-body-wrap { overflow: hidden; max-height: 600px; transition: max-height 0.3s ease; }
  .recent-body-wrap.collapsed { max-height: 0 !important; overflow: hidden; }

  /* Skip perms toggle */
  .skip-perms-bar {
    display: flex; align-items: center; gap: 8px;
    margin-bottom: 8px; justify-content: flex-end;
  }
  .skip-perms-bar input[type="checkbox"] { accent-color: #cc7832; }
  .skip-perms-bar label { font-size: 10px; color: #555; cursor: pointer; }

  .footer { text-align: center; padding: 20px; font-size: 10px; color: #222; }
</style>
</head>
<body>

<div class="container">
  <div class="header">
    <h1>See Claude</h1>
    <div class="count" id="count">-</div>
    <div class="subtitle"><span class="live-dot"></span>active sessions <span class="live-badge">LIVE</span></div>
  </div>

  <div class="view-toggle">
    <button class="view-btn active" id="vbtn-terminal" onclick="setView('terminal')">terminals</button>
    <button class="view-btn" id="vbtn-pixel" onclick="setView('pixel')">pixel</button>
  </div>

  <div id="live-section">
    <div class="section-title"><span>Running Now</span><button class="new-session-btn" onclick="showNewSession(event)">+ NEW SESSION</button></div>
    <div class="grid" id="grid"></div>
  </div>

  <div class="pixel-view" id="pixel-view">
    <div class="section-title"><span>Running Now</span><button class="new-session-btn" onclick="showNewSession(event)">+ NEW SESSION</button></div>
    <div class="pixel-office">
      <div class="office-wall"></div>
      <div class="office-poster">~</div>
      <div class="office-window">
        <div class="office-window-sky" id="office-sky"></div>
        <div class="office-window-frame"></div>
        <div class="office-window-frame-h"></div>
      </div>
      <div class="office-clock" id="office-clock"></div>
      <div class="office-floor-line"></div>
      <div class="pixel-floor" id="pixel-floor"></div>
    </div>
  </div>

  <div class="recent-section">
    <div class="section-title recent-toggle" onclick="toggleRecent()">
      <span class="arrow collapsed" id="recent-arrow">&#9660;</span>
      Recent Sessions
    </div>
    <div class="recent-body-wrap collapsed" id="recent-wrap">
      <div class="skip-perms-bar">
        <input type="checkbox" id="skip-perms-toggle">
        <label for="skip-perms-toggle">--dangerously-skip-permissions</label>
      </div>
      <table class="recent-table">
        <thead><tr><th>Project</th><th>First Message</th><th>Last Active</th><th></th></tr></thead>
        <tbody id="recent-body"></tbody>
      </table>
    </div>
  </div>

  <div class="footer">auto-updates via server-sent events</div>
</div>

<div class="modal-overlay" id="new-modal" onclick="if(event.target===this)closeNewSession()">
  <div class="modal">
    <h2>New Claude Session</h2>
    <div class="modal-field">
      <label>Project directory</label>
      <input class="modal-input" id="new-dir" value="${os.homedir()}/Documents/">
      <div class="dir-browser" id="dir-browser"></div>
      <div style="margin-top:6px;display:flex;gap:6px">
        <input class="modal-input" id="new-folder-name" placeholder="new folder name" style="font-size:11px;padding:6px 8px">
        <button class="btn btn-send" onclick="createFolder()" style="padding:6px 10px;font-size:9px">create</button>
      </div>
    </div>
    <div class="modal-field">
      <label>First message to Claude (optional - leave blank for empty session)</label>
      <input class="modal-input" id="new-prompt" placeholder="e.g. fix the failing tests">
    </div>
    <div class="modal-check">
      <input type="checkbox" id="new-skip-perms">
      <label for="new-skip-perms">--dangerously-skip-permissions</label>
    </div>
    <div class="modal-actions">
      <button class="btn btn-close" onclick="closeNewSession()">cancel</button>
      <button class="btn btn-terminal" onclick="launchNewSession()">launch</button>
    </div>
  </div>
</div>

<div class="pixel-modal-overlay" id="pixel-modal" onclick="if(event.target===this)closePixelDialog()">
  <div class="pixel-dialog">
    <div class="pixel-dialog-header">
      <div class="project-name" id="pxd-project"></div>
      <span class="screen-status" id="pxd-status"></span>
    </div>
    <div class="msg-history" id="pxd-history" style="flex:1;max-height:350px"></div>
    <div class="expanded-actions" style="margin-top:8px">
      <input class="chat-input" id="pxd-input" placeholder="send a message..." onkeydown="if(event.key==='Enter')sendPixelMsg(event)">
      <button class="btn btn-send" onclick="sendPixelMsg(event)">send</button>
      <button class="btn btn-terminal" onclick="pixelOpenTerminal(event)">terminal</button>
      <button class="btn btn-close" onclick="closePixelDialog()">close</button>
      <span class="sent-flash" id="pxd-sent">sent!</span>
    </div>
  </div>
</div>

<div class="copy-toast" id="toast">Copied</div>

<script>
let previousPids = new Set();
let expandedPid = null;

function getStatusLabel(s) { return s === 'working' ? 'Working' : s === 'thinking' ? 'Thinking' : 'Idle'; }
function getStatusColor(s) { return s === 'working' ? '#27c93f' : s === 'thinking' ? '#ffbd2e' : '#555'; }

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function renderLive(sessions) {
  const grid = document.getElementById('grid');
  document.getElementById('count').textContent = sessions.length;

  if (!sessions.length) {
    grid.innerHTML = '<div style="color:#333;font-size:13px;padding:30px;text-align:center">No Claude sessions running</div>';
    previousPids = new Set();
    return;
  }

  const currentPids = new Set(sessions.map(s => s.pid));
  const newPids = sessions.filter(s => !previousPids.has(s.pid)).map(s => s.pid);

  grid.innerHTML = sessions.map(s => {
    const isNew = newPids.includes(s.pid);
    const isExpanded = expandedPid === s.pid;
    const lastMsg = s.messages?.length ? s.messages[s.messages.length - 1] : null;

    // Build message history for expanded view
    let msgHtml = '';
    if (s.messages?.length) {
      msgHtml = s.messages.map(m => \`
        <div class="msg-bubble \${m.role}">
          <span class="msg-role">\${m.role === 'assistant' ? 'Claude' : 'You'}</span>
          <div class="msg-text">\${escapeHtml(m.text)}</div>
        </div>
      \`).join('');
    }

    return \`
    <div class="station \${s.status} \${isNew ? 'entering' : ''} \${isExpanded ? 'expanded' : ''}" data-pid="\${s.pid}" onclick="handleClick('\${s.pid}', '\${s.tty}', event)">
      <div class="monitor">
        <div class="screen">
          <div class="screen-header">
            <div class="dot red"></div>
            <div class="dot yellow"></div>
            <div class="dot green"></div>
            <span class="screen-status" style="color:\${getStatusColor(s.status)}">\${getStatusLabel(s.status)}</span>
          </div>
          <div class="project-name">\${escapeHtml(s.projectName)}</div>
          <div class="project-path">\${escapeHtml(s.cwd)}</div>
          \${s.messages?.length && s.messages[0].role === 'user' ? \`<div class="first-prompt">\${escapeHtml(s.messages[0].text.slice(0, 80))}</div>\` : ''}
          \${lastMsg ? \`<div class="last-msg-preview"><span class="msg-label \${lastMsg.role === 'assistant' ? 'claude' : 'you'}">\${lastMsg.role === 'assistant' ? 'Claude:' : 'You:'}</span> \${escapeHtml(lastMsg.text)}</div>\` : ''}
          <div class="expanded-content">
            <div class="msg-history" id="history-\${s.pid}">\${msgHtml}</div>
            <div class="expanded-actions">
              <input class="chat-input" id="input-\${s.pid}" placeholder="send a message..." onkeydown="if(event.key==='Enter')sendMsg('\${s.tty}','\${s.pid}',event)" onclick="event.stopPropagation()">
              <button class="btn btn-send" onclick="sendMsg('\${s.tty}','\${s.pid}',event)" onmousedown="event.preventDefault()">send</button>
              <button class="btn btn-terminal" onclick="openTerminal('\${s.tty}','\${s.pid}',event)">terminal</button>
              <button class="btn btn-close" onclick="collapseCard(event)">close</button>
              <span class="sent-flash" id="sent-\${s.pid}">sent!</span>
            </div>
          </div>
          <div class="stats">
            <span><span class="stat-label">CPU</span> <span class="stat-value">\${s.cpu}</span></span>
            <span><span class="stat-label">MEM</span> <span class="stat-value">\${s.mem}</span></span>
            <span><span class="stat-label">UP</span> <span class="stat-value">\${s.elapsed}</span></span>
          </div>
        </div>
      </div>
      <div class="stand"></div>
      <div class="base"></div>
      <button class="quick-terminal" onclick="openTerminal('\${s.tty}','\${s.pid}',event)">&gt;_ terminal</button>
    </div>
  \`}).join('');

  // Scroll message history to bottom for expanded card
  if (expandedPid) {
    const hist = document.getElementById('history-' + expandedPid);
    if (hist) hist.scrollTop = hist.scrollHeight;
    // Restore focus on input if it was focused
    const input = document.getElementById('input-' + expandedPid);
    if (input && document.activeElement?.tagName !== 'INPUT') {
      // Don't steal focus, but keep it if it was there
    }
  }

  previousPids = currentPids;
}

function handleClick(pid, tty, event) {
  // Don't expand/collapse if clicking interactive elements
  if (event.target.closest('.expanded-content') || event.target.closest('.btn') || event.target.closest('.quick-terminal') || event.target.closest('button') || event.target.closest('input')) return;

  if (expandedPid === pid) {
    // Already expanded, clicking header area - go to terminal
    expandedPid = null;
  } else {
    expandedPid = pid;
  }
  // Re-render will pick up expandedPid
  if (lastData) {
    renderLive(lastData.live);
    // Scroll history and focus input
    setTimeout(() => {
      if (expandedPid) {
        const hist = document.getElementById('history-' + expandedPid);
        if (hist) hist.scrollTop = hist.scrollHeight;
        const input = document.getElementById('input-' + expandedPid);
        if (input) input.focus();
      }
    }, 50);
  }
}

function collapseCard(event) {
  event.stopPropagation();
  expandedPid = null;
  if (lastData) renderLive(lastData.live);
}

async function sendMsg(tty, pid, event) {
  event.stopPropagation();
  const input = document.getElementById('input-' + pid);
  const msg = input.value.trim();
  if (!msg) return;

  try {
    const res = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tty, message: msg }),
    });
    const data = await res.json();
    if (data.ok) {
      input.value = '';
      const sent = document.getElementById('sent-' + pid);
      sent.textContent = 'sent to terminal!';
      sent.classList.add('visible');
      setTimeout(() => sent.classList.remove('visible'), 2500);
    } else {
      showToast('Failed to send: ' + (data.error || 'unknown'));
    }
  } catch { showToast('Failed to send'); }
}

async function openTerminal(tty, pid, event) {
  event.stopPropagation();
  try { await fetch('/api/focus?tty=' + encodeURIComponent(tty) + '&pid=' + encodeURIComponent(pid)); } catch {}
}

function renderRecent(sessions) {
  const tbody = document.getElementById('recent-body');
  if (!tbody) return;
  // Get live session project dirs to mark which recent ones are active
  const liveDirs = new Set((lastData?.live || []).map(l => l.cwd));

  tbody.innerHTML = sessions.map(s => {
    const isLive = liveDirs.has(s.cwd);
    return \`
    <tr class="recent-row \${isLive ? 'recent-live' : ''}">
      <td class="recent-project">\${isLive ? '<span style="color:#27c93f;margin-right:4px">\\u25cf</span>' : ''}\${escapeHtml(s.projectName)}</td>
      <td class="recent-message">\${escapeHtml(s.firstMessage)}</td>
      <td class="recent-time">\${s.lastModifiedStr}</td>
      <td><div class="btn-group">
        <button class="resume-btn" onclick="copyResume('\${s.sessionId}',event)" title="Copy claude --resume command to clipboard">copy cmd</button>
        <button class="launch-btn" onclick="launchResume('\${s.sessionId}','\${escapeHtml(s.cwd)}',event)" title="Open in a new Terminal tab">resume</button>
      </div></td>
    </tr>
  \`}).join('');
}

function getResumeCmd(id) {
  let cmd = 'claude --resume ' + id;
  if (document.getElementById('skip-perms-toggle')?.checked) cmd += ' --dangerously-skip-permissions';
  return cmd;
}
function copyResume(id, e) {
  e.stopPropagation();
  const cmd = getResumeCmd(id);
  navigator.clipboard.writeText(cmd).then(() => showToast('Copied: ' + cmd)).catch(() => showToast('Copy failed'));
}
async function launchResume(id, cwd, e) {
  e.stopPropagation();
  const skip = document.getElementById('skip-perms-toggle')?.checked;
  try {
    const r = await fetch('/api/launch', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({sessionId:id,cwd,skipPerms:skip}) });
    const d = await r.json();
    showToast(d.ok ? 'Launched in new Terminal tab' : 'Launch failed');
  } catch { showToast('Launch failed'); }
}

function showNewSession(event) {
  event.stopPropagation();
  document.getElementById('new-modal').classList.add('visible');
  const dirInput = document.getElementById('new-dir');
  dirInput.focus();
  dirInput.setSelectionRange(dirInput.value.length, dirInput.value.length);
  browseDir(dirInput.value);
}

let cachedDir = '';
let cachedEntries = [];

async function browseDir(inputVal) {
  // Split into parent dir and partial typed name
  const lastSlash = inputVal.lastIndexOf('/');
  const parentDir = inputVal.substring(0, lastSlash + 1);
  const filter = inputVal.substring(lastSlash + 1).toLowerCase();

  // Only re-fetch if parent dir changed
  if (parentDir !== cachedDir) {
    try {
      const r = await fetch('/api/ls?dir=' + encodeURIComponent(parentDir));
      const d = await r.json();
      cachedDir = parentDir;
      cachedEntries = d.ok ? d.entries : [];
    } catch { cachedEntries = []; }
  }

  // Filter entries by what's typed after the last /
  const filtered = filter
    ? cachedEntries.filter(e => e.toLowerCase().startsWith(filter))
    : cachedEntries;

  const browser = document.getElementById('dir-browser');
  if (!filtered.length) {
    browser.innerHTML = '<div class="dir-entry dir-up" onclick="goUpDir()"><span class="dir-icon">..</span> up</div>'
      + (filter ? '<div class="dir-entry" style="color:#333;cursor:default">no matches</div>' : '<div class="dir-entry" style="color:#333;cursor:default">no subdirectories</div>');
    return;
  }
  browser.innerHTML = '<div class="dir-entry dir-up" onclick="goUpDir()"><span class="dir-icon">..</span> up</div>'
    + filtered.map(e => \`<div class="dir-entry" onclick="selectDir('\${escapeHtml(parentDir + e)}')"><span class="dir-icon">+</span> \${escapeHtml(e)}</div>\`).join('');
}

function selectDir(dir) {
  const input = document.getElementById('new-dir');
  input.value = dir + '/';
  input.focus();
  browseDir(dir);
}

function goUpDir() {
  const input = document.getElementById('new-dir');
  let dir = input.value.replace(/\\/+$/, '');
  const parent = dir.substring(0, dir.lastIndexOf('/'));
  if (parent) {
    input.value = parent + '/';
    input.focus();
    browseDir(parent);
  }
}

async function createFolder() {
  const dirInput = document.getElementById('new-dir');
  const nameInput = document.getElementById('new-folder-name');
  const name = nameInput.value.trim();
  if (!name) { showToast('Enter a folder name'); return; }
  let parent = dirInput.value.replace(/\\/+$/, '');
  const newPath = parent + '/' + name;
  try {
    const r = await fetch('/api/mkdir', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ path: newPath }) });
    const d = await r.json();
    if (d.ok) {
      nameInput.value = '';
      selectDir(newPath);
      showToast('Created ' + name);
    } else {
      showToast('Failed: ' + (d.error || 'unknown'));
    }
  } catch { showToast('Failed to create folder'); }
}

// Browse as user types
let browseTimeout;
document.addEventListener('DOMContentLoaded', () => {
  const dirInput = document.getElementById('new-dir');
  dirInput.addEventListener('input', () => {
    clearTimeout(browseTimeout);
    browseTimeout = setTimeout(() => browseDir(dirInput.value), 300);
  });
});

function closeNewSession() {
  document.getElementById('new-modal').classList.remove('visible');
  document.getElementById('new-dir').value = '';
  document.getElementById('new-prompt').value = '';
  document.getElementById('new-skip-perms').checked = false;
}

async function launchNewSession() {
  const dir = document.getElementById('new-dir').value.trim();
  if (!dir) { showToast('Enter a directory'); return; }
  const prompt = document.getElementById('new-prompt').value.trim();
  const skip = document.getElementById('new-skip-perms').checked;
  try {
    const r = await fetch('/api/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir, prompt, skipPerms: skip }),
    });
    const d = await r.json();
    if (d.ok) {
      closeNewSession();
      showToast('Launched new Claude session');
    } else {
      showToast('Launch failed: ' + (d.error || 'unknown'));
    }
  } catch { showToast('Launch failed'); }
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('visible');
  setTimeout(() => t.classList.remove('visible'), 3000);
}


// --- Recent section toggle ---
function toggleRecent() {
  const wrap = document.getElementById('recent-wrap');
  const arrow = document.getElementById('recent-arrow');
  wrap.classList.toggle('collapsed');
  arrow.classList.toggle('collapsed');
}

// --- Pixel dialog ---
let pixelDialogPid = null;
let pixelDialogTty = null;

function openPixelDialog(pid, tty) {
  pixelDialogPid = pid;
  pixelDialogTty = tty;
  const session = lastData?.live?.find(s => s.pid === pid);
  if (!session) return;

  document.getElementById('pxd-project').textContent = getDisplayName(session.cwd, session.projectName);
  const statusEl = document.getElementById('pxd-status');
  statusEl.textContent = getStatusLabel(session.status);
  statusEl.style.color = getStatusColor(session.status);

  const hist = document.getElementById('pxd-history');
  hist.innerHTML = (session.messages || []).map(m => \`
    <div class="msg-bubble \${m.role}">
      <span class="msg-role">\${m.role === 'assistant' ? 'Claude' : 'You'}</span>
      <div class="msg-text">\${escapeHtml(m.text)}</div>
    </div>
  \`).join('');
  hist.scrollTop = hist.scrollHeight;

  document.getElementById('pxd-input').value = '';
  document.getElementById('pixel-modal').classList.add('visible');
  setTimeout(() => document.getElementById('pxd-input').focus(), 100);
}

function closePixelDialog() {
  document.getElementById('pixel-modal').classList.remove('visible');
  pixelDialogPid = null;
  pixelDialogTty = null;
}

async function sendPixelMsg(event) {
  event.stopPropagation();
  const input = document.getElementById('pxd-input');
  const msg = input.value.trim();
  if (!msg || !pixelDialogTty) return;
  try {
    const res = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tty: pixelDialogTty, message: msg }),
    });
    const data = await res.json();
    if (data.ok) {
      input.value = '';
      const sent = document.getElementById('pxd-sent');
      sent.textContent = 'sent to terminal!';
      sent.classList.add('visible');
      setTimeout(() => sent.classList.remove('visible'), 2500);
    } else {
      showToast('Failed to send: ' + (data.error || 'unknown'));
    }
  } catch { showToast('Failed to send'); }
}

async function pixelOpenTerminal(event) {
  event.stopPropagation();
  if (!pixelDialogTty) return;
  try { await fetch('/api/focus?tty=' + encodeURIComponent(pixelDialogTty) + '&pid=' + encodeURIComponent(pixelDialogPid)); } catch {}
}

// --- Wake offline project ---
async function wakeProject(cwd, sessionId) {
  try {
    const r = await fetch('/api/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, cwd, skipPerms: true }),
    });
    const d = await r.json();
    showToast(d.ok ? 'Waking up session in new Terminal tab' : 'Launch failed');
  } catch { showToast('Launch failed'); }
}

// --- View toggle ---
let currentView = localStorage.getItem('see-claude-view') || 'terminal';

function setView(view) {
  currentView = view;
  localStorage.setItem('see-claude-view', view);
  document.getElementById('live-section').style.display = view === 'terminal' ? 'block' : 'none';
  document.getElementById('pixel-view').classList.toggle('active', view === 'pixel');
  document.getElementById('vbtn-terminal').classList.toggle('active', view === 'terminal');
  document.getElementById('vbtn-pixel').classList.toggle('active', view === 'pixel');
  if (view === 'pixel' && lastData) renderPixel(lastData.live);
}

setTimeout(() => { if (currentView === 'pixel') setView('pixel'); }, 0);

// --- Office environment ---
function getSkyColor() {
  const h = new Date().getHours();
  if (h >= 6 && h < 8) return 'linear-gradient(180deg, #2d1b4e 0%, #e8846b 50%, #f4c27f 100%)'; // sunrise
  if (h >= 8 && h < 12) return 'linear-gradient(180deg, #4a90d9 0%, #87ceeb 50%, #b8e0f0 100%)'; // morning
  if (h >= 12 && h < 17) return 'linear-gradient(180deg, #2d7dd2 0%, #87ceeb 100%)'; // afternoon
  if (h >= 17 && h < 20) return 'linear-gradient(180deg, #1a1a3e 0%, #d4556b 50%, #f4a742 100%)'; // sunset
  if (h >= 20 && h < 22) return 'linear-gradient(180deg, #0a0a2e 0%, #1a1a4e 50%, #2d1b4e 100%)'; // dusk
  return 'linear-gradient(180deg, #050510 0%, #0a0a2e 50%, #111133 100%)'; // night
}

function updateOffice() {
  const sky = document.getElementById('office-sky');
  const clock = document.getElementById('office-clock');
  if (sky) sky.style.background = getSkyColor();
  if (clock) {
    const now = new Date();
    clock.textContent = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
  }
}
updateOffice();
setInterval(updateOffice, 30000);

// --- Desktop notifications ---
let prevStatuses = {};

function checkNotifications(sessions) {
  if (Notification.permission !== 'granted') return;
  sessions.forEach(s => {
    const prev = prevStatuses[s.pid];
    if (prev && (prev === 'working' || prev === 'thinking') && s.status === 'idle') {
      new Notification('Claude finished', {
        body: s.projectName + ' is now idle',
        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🖥️</text></svg>',
        silent: false,
      });
    }
    prevStatuses[s.pid] = s.status;
  });
}

// Request notification permission
if ('Notification' in window && Notification.permission === 'default') {
  // Show a subtle prompt
  setTimeout(() => {
    Notification.requestPermission();
  }, 3000);
}

// --- Custom project names ---
let customNames = JSON.parse(localStorage.getItem('see-claude-names') || '{}');

function getDisplayName(cwd, fallback) {
  return customNames[cwd] || fallback;
}

function renameProject(cwd, fallback, el) {
  const current = customNames[cwd] || fallback;
  const input = document.createElement('input');
  input.className = 'chat-input';
  input.value = customNames[cwd] || '';
  input.placeholder = fallback;
  input.style.cssText = 'width:100%;font-size:11px;padding:2px 6px;text-align:center;margin-top:8px';
  el.replaceWith(input);
  input.focus();
  input.select();
  const save = () => {
    const val = input.value.trim();
    if (val) customNames[cwd] = val;
    else delete customNames[cwd];
    localStorage.setItem('see-claude-names', JSON.stringify(customNames));
    const label = document.createElement('div');
    label.className = 'pixel-label';
    label.textContent = val || fallback;
    label.ondblclick = (e) => { e.stopPropagation(); renameProject(cwd, fallback, label); };
    input.replaceWith(label);
  };
  input.addEventListener('blur', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = ''; input.blur(); }
  });
  input.addEventListener('click', (e) => e.stopPropagation());
}

// --- Drag to reorder (pixel view) ---
let rosterOrder = JSON.parse(localStorage.getItem('see-claude-roster-order') || '[]');

function applyRosterOrder(items) {
  if (!rosterOrder.length) return items;
  const orderMap = {};
  rosterOrder.forEach((key, i) => { orderMap[key] = i; });
  return items.sort((a, b) => {
    const keyA = a.type === 'live' ? a.session.cwd : a.project.cwd;
    const keyB = b.type === 'live' ? b.session.cwd : b.project.cwd;
    const oA = orderMap[keyA] !== undefined ? orderMap[keyA] : 9999;
    const oB = orderMap[keyB] !== undefined ? orderMap[keyB] : 9999;
    if (oA !== oB) return oA - oB;
    // Live before offline if no saved order
    if (a.type !== b.type) return a.type === 'live' ? -1 : 1;
    return 0;
  });
}

let dragSrcEl = null;

function initDrag(floor) {
  const stations = floor.querySelectorAll('.pixel-station');
  stations.forEach(el => {
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', (e) => {
      dragSrcEl = el;
      el.style.opacity = '0.4';
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => { el.style.opacity = ''; });
    el.addEventListener('dragover', (e) => {
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      // Show insert line on left or right side based on mouse position
      const rect = el.getBoundingClientRect();
      const mid = rect.left + rect.width / 2;
      if (e.clientX < mid) {
        el.style.borderLeft = '3px solid #cc7832'; el.style.borderRight = '';
      } else {
        el.style.borderRight = '3px solid #cc7832'; el.style.borderLeft = '';
      }
    });
    el.addEventListener('dragleave', () => { el.style.borderLeft = ''; el.style.borderRight = ''; });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.style.borderLeft = ''; el.style.borderRight = '';
      if (dragSrcEl !== el) {
        const parent = el.parentNode;
        const rect = el.getBoundingClientRect();
        const mid = rect.left + rect.width / 2;
        if (e.clientX < mid) parent.insertBefore(dragSrcEl, el);
        else parent.insertBefore(dragSrcEl, el.nextSibling);
        // Save order
        const newOrder = [...parent.querySelectorAll('.pixel-station')].map(s => s.dataset.cwd).filter(Boolean);
        rosterOrder = newOrder;
        localStorage.setItem('see-claude-roster-order', JSON.stringify(newOrder));
      }
    });
  });
}

// --- Pixel art renderer ---
const PX = 4; // pixel scale
let pixelAnimFrame = 0;
setInterval(() => { pixelAnimFrame++; }, 400);

// Character variety - seeded from PID
const HAIR_COLORS = ['#6b4226','#2a1a0a','#d4a44a','#c24a2a','#8a2a4a','#f5f5dc','#1a1a2e','#ff6b35'];
const SKIN_COLORS = ['#f0c090','#d4a070','#8d5524','#c68642','#f1c27d','#e0ac69','#503335','#ffdbac'];
const SHIRT_COLORS = ['#5b8dd9','#d95b5b','#5bd98a','#d9b95b','#9b5bd9','#d95bba','#5bd9d9','#ff6b35'];
const PANTS_COLORS = ['#3b4a6b','#4a3b6b','#3b6b4a','#6b4a3b','#2d2d3d','#3d2d2d','#2d3d2d','#444'];
const HAIR_STYLES = ['short','spiky','long','ponytail','mohawk','bun','curly','buzzcut'];
const DESK_ITEMS = ['coffee','plant','cat','book','headphones','duck'];
const CHAIR_COLORS = ['#444','#6b2222','#22446b','#226b44','#6b4422','#4a2266'];

function hashPid(pid) {
  let h = 0;
  for (let i = 0; i < pid.length; i++) h = ((h << 5) - h + pid.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function getCharTraits(pid) {
  const h = hashPid(pid);
  return {
    hair: HAIR_COLORS[h % HAIR_COLORS.length],
    skin: SKIN_COLORS[(h >> 3) % SKIN_COLORS.length],
    shirt: SHIRT_COLORS[(h >> 6) % SHIRT_COLORS.length],
    pants: PANTS_COLORS[(h >> 9) % PANTS_COLORS.length],
    hairStyle: HAIR_STYLES[(h >> 12) % HAIR_STYLES.length],
    deskItem: DESK_ITEMS[(h >> 15) % DESK_ITEMS.length],
    chairColor: CHAIR_COLORS[(h >> 18) % CHAIR_COLORS.length],
  };
}

function drawPixelCharacter(canvas, status, frame, pid) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, w, h);

  const p = PX;
  const cx = Math.floor(w / 2);
  const t = getCharTraits(pid || '0');

  const screenGlow = status === 'working' ? '#27c93f' : status === 'thinking' ? '#ffbd2e' : '#334';
  const desk = '#8b6914';
  const deskDark = '#6b4f10';

  // === DESK ===
  ctx.fillStyle = desk;
  ctx.fillRect(cx - 22*p, 26*p, 44*p, 3*p);
  ctx.fillStyle = deskDark;
  ctx.fillRect(cx - 22*p, 29*p, 44*p, p);
  ctx.fillRect(cx - 20*p, 30*p, 2*p, 8*p);
  ctx.fillRect(cx + 18*p, 30*p, 2*p, 8*p);

  // === MONITOR ===
  ctx.fillStyle = '#222';
  ctx.fillRect(cx - 8*p, 16*p, 16*p, 10*p);
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(cx - 7*p, 17*p, 14*p, 8*p);
  ctx.fillStyle = screenGlow;
  ctx.fillRect(cx - 6*p, 18*p, 12*p, 6*p);

  // Screen lines
  ctx.fillStyle = status === 'working' ? '#4ae84a' : status === 'thinking' ? '#ffe066' : '#445';
  const lo = frame % 3;
  for (let i = 0; i < 3; i++) {
    ctx.fillRect(cx - 5*p, (19 + i*2)*p, ((i + lo) % 3 === 0 ? 8 : (i + lo) % 3 === 1 ? 6 : 10)*p, p);
  }

  // Monitor stand
  ctx.fillStyle = '#333';
  ctx.fillRect(cx - 2*p, 26*p, 4*p, p);
  ctx.fillRect(cx - p, 25*p, 2*p, p);

  // === CHAIR ===
  ctx.fillStyle = t.chairColor;
  ctx.fillRect(cx + 14*p, 22*p, 6*p, 2*p);
  ctx.fillRect(cx + 18*p, 16*p, 2*p, 6*p);
  ctx.fillRect(cx + 15*p, 24*p, p, 6*p);
  ctx.fillRect(cx + 19*p, 24*p, p, 6*p);
  ctx.fillStyle = '#333';
  ctx.fillRect(cx + 14*p, 30*p, 2*p, p);
  ctx.fillRect(cx + 19*p, 30*p, 2*p, p);

  // === CHARACTER ===
  const charX = cx + 12*p;
  const charY = 8*p;
  const bobY = status === 'working' ? (frame % 2 === 0 ? 0 : -p) : 0;

  // Head
  ctx.fillStyle = t.skin;
  ctx.fillRect(charX, charY + bobY, 4*p, 4*p);

  // Hair by style
  ctx.fillStyle = t.hair;
  if (t.hairStyle === 'short') {
    ctx.fillRect(charX - p, charY + bobY - p, 6*p, 2*p);
    ctx.fillRect(charX - p, charY + bobY, p, 2*p);
  } else if (t.hairStyle === 'spiky') {
    ctx.fillRect(charX - p, charY + bobY - p, 6*p, p);
    ctx.fillRect(charX, charY + bobY - 2*p, p, p);
    ctx.fillRect(charX + 2*p, charY + bobY - 2*p, p, p);
    ctx.fillRect(charX + 4*p, charY + bobY - 2*p, p, p);
    ctx.fillRect(charX - p, charY + bobY, p, p);
  } else if (t.hairStyle === 'long') {
    ctx.fillRect(charX - p, charY + bobY - p, 6*p, 2*p);
    ctx.fillRect(charX - 2*p, charY + bobY, p, 5*p);
    ctx.fillRect(charX + 4*p, charY + bobY, p, 5*p);
  } else if (t.hairStyle === 'ponytail') {
    ctx.fillRect(charX - p, charY + bobY - p, 6*p, 2*p);
    ctx.fillRect(charX + 4*p, charY + bobY + p, p, p);
    ctx.fillRect(charX + 5*p, charY + bobY + 2*p, p, 3*p);
  } else if (t.hairStyle === 'mohawk') {
    ctx.fillRect(charX + p, charY + bobY - 3*p, 2*p, 3*p);
    ctx.fillRect(charX, charY + bobY - p, 4*p, p);
  } else if (t.hairStyle === 'bun') {
    ctx.fillRect(charX - p, charY + bobY - p, 6*p, 2*p);
    ctx.fillRect(charX + p, charY + bobY - 3*p, 2*p, 2*p);
  } else if (t.hairStyle === 'curly') {
    ctx.fillRect(charX - 2*p, charY + bobY - p, 7*p, 2*p);
    ctx.fillRect(charX - 2*p, charY + bobY, p, 3*p);
    ctx.fillRect(charX + 4*p, charY + bobY, p, 3*p);
    ctx.fillRect(charX - 2*p, charY + bobY + 3*p, p, p);
  } else { // buzzcut
    ctx.fillRect(charX, charY + bobY - p, 4*p, p);
  }

  // Eyes
  ctx.fillStyle = '#222';
  if (status === 'idle') {
    ctx.fillRect(charX + p, charY + bobY + p, p, p);
    ctx.fillRect(charX + 2*p, charY + bobY + p, p, p);
  } else {
    ctx.fillRect(charX, charY + bobY + p, p, p);
    ctx.fillRect(charX + 2*p, charY + bobY + p, p, p);
  }

  // Mouth
  ctx.fillStyle = '#222';
  if (status === 'working') {
    ctx.fillRect(charX + p, charY + bobY + 3*p, p, p); // focused
  }

  // Body
  ctx.fillStyle = t.shirt;
  ctx.fillRect(charX - p, charY + bobY + 4*p, 6*p, 5*p);

  // Arms
  if (status === 'working') {
    const armOff = frame % 2 === 0 ? 0 : -p;
    ctx.fillStyle = t.shirt;
    ctx.fillRect(charX - 3*p, charY + bobY + 5*p, 2*p, 4*p);
    ctx.fillRect(charX + 5*p, charY + bobY + 5*p, 2*p, 4*p);
    ctx.fillStyle = t.skin;
    ctx.fillRect(charX - 3*p + armOff, charY + bobY + 9*p, 2*p, p);
    ctx.fillRect(charX + 5*p - armOff, charY + bobY + 9*p, 2*p, p);
  } else if (status === 'thinking') {
    ctx.fillStyle = t.shirt;
    ctx.fillRect(charX - 3*p, charY + bobY + 5*p, 2*p, 3*p);
    ctx.fillRect(charX + 5*p, charY + bobY + 5*p, 2*p, 4*p);
    ctx.fillStyle = t.skin;
    ctx.fillRect(charX - 2*p, charY + bobY + 3*p, 2*p, p);
    ctx.fillRect(charX + 5*p, charY + bobY + 9*p, 2*p, p);
  } else {
    ctx.fillStyle = t.shirt;
    ctx.fillRect(charX - 2*p, charY + bobY + 5*p, 2*p, 4*p);
    ctx.fillRect(charX + 4*p, charY + bobY + 5*p, 2*p, 4*p);
    ctx.fillStyle = t.skin;
    ctx.fillRect(charX - 2*p, charY + bobY + 9*p, 2*p, p);
    ctx.fillRect(charX + 4*p, charY + bobY + 9*p, 2*p, p);
  }

  // Pants
  ctx.fillStyle = t.pants;
  ctx.fillRect(charX - p, charY + bobY + 9*p, 6*p, 3*p);
  ctx.fillRect(charX - 2*p, charY + bobY + 12*p, 3*p, p);
  ctx.fillRect(charX + 3*p, charY + bobY + 12*p, 3*p, p);

  // === THOUGHT BUBBLE ===
  if (status === 'thinking') {
    const bx = charX - 12*p;
    const by = charY + bobY - 4*p;
    ctx.fillStyle = '#fff';
    ctx.fillRect(bx, by, 8*p, 4*p);
    ctx.fillRect(bx + p, by - p, 6*p, p);
    ctx.fillRect(bx + p, by + 4*p, 6*p, p);
    ctx.fillStyle = '#666';
    const dotAnim = frame % 4;
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = i <= dotAnim ? '#444' : '#ccc';
      ctx.fillRect(bx + (1 + i*2)*p, by + p, p, p);
    }
    ctx.fillStyle = '#fff';
    ctx.fillRect(charX - 3*p, charY + bobY - p, 2*p, p);
    ctx.fillRect(charX - 5*p, charY + bobY - 2*p, p, p);
  }

  // === KEYBOARD ===
  ctx.fillStyle = '#2a2a2a';
  ctx.fillRect(cx - 4*p, 25*p, 8*p, 2*p);
  ctx.fillStyle = '#3a3a3a';
  for (let i = 0; i < 3; i++) ctx.fillRect(cx - 3*p + i*3*p, 25*p, 2*p, p);

  // === DESK ITEM (varies per character) ===
  const ix = cx - 17*p;
  const iy = 23*p;

  if (t.deskItem === 'coffee') {
    ctx.fillStyle = '#ddd';
    ctx.fillRect(ix, iy + p, 3*p, 3*p);
    ctx.fillRect(ix + 3*p, iy + 2*p, p, p);
    if (status !== 'idle' && frame % 3 < 2) {
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.fillRect(ix + p, iy - p + (frame % 2)*p, p, p);
      ctx.fillRect(ix + 2*p, iy - 2*p + (frame % 2)*p, p, p);
    }
  } else if (t.deskItem === 'plant') {
    ctx.fillStyle = '#8b4513';
    ctx.fillRect(ix, iy + 2*p, 3*p, 2*p);
    ctx.fillStyle = '#27a33f';
    ctx.fillRect(ix + p, iy, p, 2*p);
    ctx.fillRect(ix, iy - p, p, 2*p);
    ctx.fillRect(ix + 2*p, iy - p, p, 2*p);
  } else if (t.deskItem === 'cat') {
    ctx.fillStyle = '#ff9944';
    ctx.fillRect(ix, iy + p, 3*p, 2*p); // body
    ctx.fillRect(ix + 3*p, iy, 2*p, 2*p); // head
    ctx.fillRect(ix + 3*p, iy - p, p, p); // ear
    ctx.fillRect(ix + 4*p, iy - p, p, p); // ear
    ctx.fillStyle = '#222';
    ctx.fillRect(ix + 3*p, iy + p, p, p); // eye
    // tail wag
    ctx.fillStyle = '#ff9944';
    ctx.fillRect(ix - p, iy + (frame % 2)*p, p, 2*p);
  } else if (t.deskItem === 'book') {
    ctx.fillStyle = '#cc3333';
    ctx.fillRect(ix, iy + p, 3*p, 3*p);
    ctx.fillStyle = '#fff';
    ctx.fillRect(ix + p, iy + 2*p, p, p);
  } else if (t.deskItem === 'headphones') {
    ctx.fillStyle = '#333';
    ctx.fillRect(ix, iy + 2*p, p, 2*p);
    ctx.fillRect(ix + 3*p, iy + 2*p, p, 2*p);
    ctx.fillRect(ix, iy + p, 4*p, p);
    ctx.fillStyle = '#666';
    ctx.fillRect(ix - p, iy + 2*p, 2*p, p);
    ctx.fillRect(ix + 3*p, iy + 2*p, 2*p, p);
  } else if (t.deskItem === 'duck') {
    ctx.fillStyle = '#ffd700';
    ctx.fillRect(ix, iy + p, 3*p, 2*p); // body
    ctx.fillRect(ix + 2*p, iy, 2*p, 2*p); // head
    ctx.fillStyle = '#ff8c00';
    ctx.fillRect(ix + 4*p, iy + p, p, p); // beak
  }
}

function drawSleepingCharacter(canvas, frame, dirKey) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, w, h);

  const p = PX;
  const cx = Math.floor(w / 2);
  const t = getCharTraits(dirKey || '0');

  const desk = '#5a4410';
  const deskDark = '#4a3a0d';

  // === DESK (dimmed) ===
  ctx.fillStyle = desk;
  ctx.fillRect(cx - 22*p, 26*p, 44*p, 3*p);
  ctx.fillStyle = deskDark;
  ctx.fillRect(cx - 22*p, 29*p, 44*p, p);
  ctx.fillRect(cx - 20*p, 30*p, 2*p, 8*p);
  ctx.fillRect(cx + 18*p, 30*p, 2*p, 8*p);

  // === MONITOR OFF ===
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(cx - 8*p, 16*p, 16*p, 10*p);
  ctx.fillStyle = '#111';
  ctx.fillRect(cx - 7*p, 17*p, 14*p, 8*p);
  // Standby dot
  ctx.fillStyle = '#333';
  ctx.fillRect(cx, 20*p, p, p);
  // Stand
  ctx.fillStyle = '#222';
  ctx.fillRect(cx - 2*p, 26*p, 4*p, p);
  ctx.fillRect(cx - p, 25*p, 2*p, p);

  // === CHAIR ===
  ctx.fillStyle = '#2a2a2a';
  ctx.fillRect(cx + 14*p, 22*p, 6*p, 2*p);
  ctx.fillRect(cx + 18*p, 16*p, 2*p, 6*p);
  ctx.fillRect(cx + 15*p, 24*p, p, 6*p);
  ctx.fillRect(cx + 19*p, 24*p, p, 6*p);
  ctx.fillStyle = '#222';
  ctx.fillRect(cx + 14*p, 30*p, 2*p, p);
  ctx.fillRect(cx + 19*p, 30*p, 2*p, p);

  // === SLEEPING CHARACTER (head on desk) ===
  const charX = cx + 4*p;
  const charY = 22*p;

  // Body slumped forward
  ctx.fillStyle = t.shirt;
  ctx.globalAlpha = 0.6;
  ctx.fillRect(charX, charY - 4*p, 6*p, 5*p);

  // Arms on desk
  ctx.fillRect(charX - 2*p, charY - 2*p, 2*p, 3*p);
  ctx.fillRect(charX + 6*p, charY - 2*p, 2*p, 3*p);
  ctx.fillStyle = t.skin;
  ctx.fillRect(charX - 3*p, charY, 3*p, p);
  ctx.fillRect(charX + 6*p, charY, 3*p, p);

  // Head resting on arms
  ctx.fillStyle = t.skin;
  ctx.fillRect(charX + p, charY - 6*p, 4*p, 3*p);

  // Hair
  ctx.fillStyle = t.hair;
  ctx.fillRect(charX, charY - 7*p, 6*p, 2*p);

  // ZZZ
  ctx.fillStyle = '#555';
  const zOff = frame % 3;
  ctx.fillRect(charX + 8*p, charY - (8 + zOff)*p, 2*p, p);
  if (zOff > 0) ctx.fillRect(charX + 10*p, charY - (10 + zOff)*p, 3*p, p);
  if (zOff > 1) ctx.fillRect(charX + 13*p, charY - (12 + zOff)*p, 3*p, p);

  // Legs under desk
  ctx.fillStyle = t.pants;
  ctx.fillRect(charX, charY + p, 3*p, 4*p);
  ctx.fillRect(charX + 3*p, charY + p, 3*p, 4*p);

  ctx.globalAlpha = 1.0;

  // Keyboard
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(cx - 4*p, 25*p, 8*p, 2*p);
}

function renderPixel(sessions) {
  const floor = document.getElementById('pixel-floor');
  if (!floor) return;
  document.getElementById('count').textContent = sessions.length;

  // Build roster: merge known projects with live sessions
  const roster = lastData?.roster || [];
  const liveByCwd = {};
  sessions.forEach(s => { liveByCwd[s.cwd] = s; });

  // Build items: live sessions first, then offline projects
  const items = [];
  const shownCwds = new Set();

  // Live sessions always show
  sessions.forEach(s => {
    items.push({ type: 'live', session: s });
    shownCwds.add(s.cwd);
  });

  // Offline projects from roster (most recent first, capped)
  let offlineCount = 0;
  roster.forEach(r => {
    if (!shownCwds.has(r.cwd) && offlineCount < 12) {
      items.push({ type: 'offline', project: r });
      shownCwds.add(r.cwd);
      offlineCount++;
    }
  });

  // Apply saved drag order
  const ordered = applyRosterOrder(items);

  floor.innerHTML = ordered.map((item, i) => {
    if (item.type === 'live') {
      const s = item.session;
      return \`
        <div class="pixel-station" data-cwd="\${escapeHtml(s.cwd)}" onclick="openPixelDialog('\${s.pid}', '\${s.tty}')">
          <canvas id="pxc-\${s.pid}" width="200" height="160" style="image-rendering:pixelated"></canvas>
          <div class="pixel-label" ondblclick="event.stopPropagation();renameProject('\${escapeHtml(s.cwd)}','\${escapeHtml(s.projectName)}',this)">\${escapeHtml(getDisplayName(s.cwd, s.projectName))}</div>
          <div class="pixel-status" style="color:\${getStatusColor(s.status)}">\${getStatusLabel(s.status)}</div>
          <button class="quick-terminal" onclick="event.stopPropagation();openTerminal('\${s.tty}','\${s.pid}',event)" style="margin-top:4px">&gt;_ terminal</button>
        </div>
      \`;
    } else {
      const r = item.project;
      return \`
        <div class="pixel-station offline" data-cwd="\${escapeHtml(r.cwd)}" onclick="wakeProject('\${escapeHtml(r.cwd)}', '\${escapeHtml(r.latestSession)}')">
          <canvas id="pxr-\${r.dirKey}" width="200" height="160" style="image-rendering:pixelated"></canvas>
          <div class="pixel-label" ondblclick="event.stopPropagation();renameProject('\${escapeHtml(r.cwd)}','\${escapeHtml(r.projectName)}',this)">\${escapeHtml(getDisplayName(r.cwd, r.projectName))}</div>
          <div class="pixel-status" style="color:#444">offline</div>
          <div class="pixel-last-active">\${r.lastModifiedStr}</div>
        </div>
      \`;
    }
  }).join('');

  // Enable drag to reorder
  initDrag(floor);

  // Draw live characters
  sessions.forEach(s => {
    const canvas = document.getElementById('pxc-' + s.pid);
    if (canvas) drawPixelCharacter(canvas, s.status, pixelAnimFrame, s.pid);
  });

  // Draw sleeping characters for offline projects
  roster.forEach(r => {
    if (!liveByCwd[r.cwd]) {
      const canvas = document.getElementById('pxr-' + r.dirKey);
      if (canvas) drawSleepingCharacter(canvas, pixelAnimFrame, r.dirKey);
    }
  });
}

// Animate pixel view
setInterval(() => {
  if (currentView === 'pixel' && lastData) {
    const liveCwds = new Set(lastData.live.map(s => s.cwd));
    lastData.live.forEach(s => {
      const canvas = document.getElementById('pxc-' + s.pid);
      if (canvas) drawPixelCharacter(canvas, s.status, pixelAnimFrame, s.pid);
    });
    // Animate sleeping characters (ZZZ floats)
    (lastData.roster || []).forEach(r => {
      if (!liveCwds.has(r.cwd)) {
        const canvas = document.getElementById('pxr-' + r.dirKey);
        if (canvas) drawSleepingCharacter(canvas, pixelAnimFrame, r.dirKey);
      }
    });
  }
}, 400);

// --- SSE ---
let lastData = null;

function connectSSE() {
  const src = new EventSource('/api/stream');
  src.onmessage = (e) => {
    try {
      lastData = JSON.parse(e.data);
      // Don't re-render if user is interacting with expanded card
      const inputFocused = expandedPid && document.activeElement?.id === 'input-' + expandedPid;
      const pixelDialogOpen = !!pixelDialogPid;
      if (!inputFocused && !pixelDialogOpen) {
        if (currentView === 'terminal') renderLive(lastData.live);
        else renderPixel(lastData.live);
      }
      // Update pixel dialog messages if open
      if (pixelDialogOpen) {
        const session = lastData.live.find(s => s.pid === pixelDialogPid);
        if (session) {
          const statusEl = document.getElementById('pxd-status');
          statusEl.textContent = getStatusLabel(session.status);
          statusEl.style.color = getStatusColor(session.status);
          const hist = document.getElementById('pxd-history');
          hist.innerHTML = (session.messages || []).map(m => \`
            <div class="msg-bubble \${m.role}">
              <span class="msg-role">\${m.role === 'assistant' ? 'Claude' : 'You'}</span>
              <div class="msg-text">\${escapeHtml(m.text)}</div>
            </div>
          \`).join('');
          hist.scrollTop = hist.scrollHeight;
        } else {
          closePixelDialog(); // session ended
        }
      }
      renderRecent(lastData.recent);
      checkNotifications(lastData.live);
    } catch {}
  };
  src.onerror = () => { src.close(); setTimeout(connectSSE, 3000); };
}

fetch('/api/sessions').then(r => r.json()).then(data => {
  lastData = data;
  if (currentView === 'terminal') renderLive(data.live);
  else renderPixel(data.live);
  renderRecent(data.recent);
  connectSSE();
}).catch(connectSSE);
</script>
</body>
</html>`;

// --- Server ---
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ live: getClaudeSessions(), recent: getRecentSessions(), roster: getProjectRoster() }));

  } else if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write('\n');
    sseClients.add(res);
    const data = JSON.stringify({ live: getClaudeSessions(), recent: getRecentSessions(), roster: getProjectRoster() });
    res.write(`data: ${data}\n\n`);
    req.on('close', () => sseClients.delete(res));

  } else if (url.pathname === '/api/ls') {
    const dir = url.searchParams.get('dir') || os.homedir();
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => e.name)
        .sort();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, dir, entries }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, dir, entries: [], error: String(e) }));
    }
    return;

  } else if (url.pathname === '/api/mkdir' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { path: dirPath } = JSON.parse(body);
        fs.mkdirSync(dirPath, { recursive: true });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;

  } else if (url.pathname === '/api/new' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { dir, prompt, skipPerms } = JSON.parse(body);
        let cmd = 'claude';
        if (skipPerms) cmd += ' --dangerously-skip-permissions';
        if (prompt) cmd += ` "${prompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
        const dirPath = dir.replace(/"/g, '\\"');
        const script = `tell application "Terminal"\nactivate\ndo script "cd \\"${dirPath}\\" && ${cmd}"\nend tell`;
        execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, { encoding: 'utf8' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;

  } else if (url.pathname === '/api/send' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { tty, message } = JSON.parse(body);
        const ttyNum = tty.replace(/^ttys?0*/, '');

        // Write message to temp file to avoid all quoting issues
        const tmpFile = `/tmp/see-claude-msg-${Date.now()}.txt`;
        fs.writeFileSync(tmpFile, message);

        // AppleScript: find tab, type message from file, press enter
        const script = [
          'tell application "Terminal"',
          '  repeat with w from 1 to count of windows',
          '    set win to window w',
          '    repeat with t from 1 to count of tabs of win',
          '      set theTab to tab t of win',
          `      if tty of theTab contains "${ttyNum}" then`,
          '        set selected tab of win to theTab',
          '        delay 0.2',
          '        tell application "System Events"',
          '          tell process "Terminal"',
          `            set msgText to (read POSIX file "${tmpFile}")`,
          '            keystroke msgText',
          '            keystroke return',
          '          end tell',
          '        end tell',
          '        return "sent"',
          '      end if',
          '    end repeat',
          '  end repeat',
          'end tell',
        ].join('\n');

        execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, { encoding: 'utf8', timeout: 5000 });
        try { fs.unlinkSync(tmpFile); } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;

  } else if (url.pathname === '/api/launch' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { sessionId, cwd, skipPerms } = JSON.parse(body);
        let cmd = `claude --resume ${sessionId}`;
        if (skipPerms) cmd += ' --dangerously-skip-permissions';
        const dirPath = cwd.startsWith('/') ? cwd : `/${cwd}`;
        const script = `tell application "Terminal"\ndo script "cd ${dirPath.replace(/"/g, '\\"')} && ${cmd}"\nend tell`;
        execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, { encoding: 'utf8' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;

  } else if (url.pathname === '/api/focus') {
    const tty = url.searchParams.get('tty');
    if (tty) {
      try {
        const ttyNum = tty.replace(/^ttys?0*/, '');
        const script = `tell application "Terminal"\nactivate\nrepeat with w from 1 to count of windows\nset win to window w\nrepeat with t from 1 to count of tabs of win\nset theTab to tab t of win\nif tty of theTab contains "${ttyNum}" then\nset selected tab of win to theTab\nset index of win to 1\nreturn "found"\nend if\nend repeat\nend repeat\nend tell`;
        execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, { encoding: 'utf8' });
      } catch {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));

  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
  }
});

server.listen(PORT, () => {
  console.log(`\n  See Claude running at http://localhost:${PORT}\n`);
});
