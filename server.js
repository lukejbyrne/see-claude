const http = require('http');
const { execSync } = require('child_process');
const path = require('path');

const PORT = 3456;

function getClaudeSessions() {
  try {
    // Get claude PIDs
    const pids = execSync("pgrep -x claude 2>/dev/null || true", { encoding: 'utf8' }).trim();
    if (!pids) return [];

    const pidList = pids.split('\n').filter(Boolean);
    const sessions = [];

    for (const pid of pidList) {
      try {
        // Get process details
        const info = execSync(
          `ps -o pid=,tty=,%cpu=,%mem=,etime=,state= -p ${pid} 2>/dev/null`,
          { encoding: 'utf8' }
        ).trim();

        if (!info) continue;

        const parts = info.trim().split(/\s+/);
        const [pidStr, tty, cpu, mem, elapsed, state] = parts;

        // Get working directory via lsof
        let cwd = '';
        try {
          const lsofOut = execSync(`lsof -p ${pid} -Fn 2>/dev/null | grep '^n/' | head -1`, { encoding: 'utf8' }).trim();
          cwd = lsofOut.replace(/^n/, '');
        } catch {}

        if (!cwd) {
          try {
            const lsofOut = execSync(`lsof -p ${pid} 2>/dev/null | grep cwd | awk '{print $NF}'`, { encoding: 'utf8' }).trim();
            cwd = lsofOut;
          } catch {}
        }

        const projectName = cwd ? path.basename(cwd) : 'unknown';

        // Determine status
        let status = 'idle';
        if (state.includes('R')) status = 'running';
        else if (state.includes('S')) status = 'idle';
        else if (state.includes('+')) status = 'foreground';

        // Check CPU to determine if actively working
        const cpuNum = parseFloat(cpu);
        if (cpuNum > 5) status = 'working';
        else if (cpuNum > 1) status = 'thinking';

        sessions.push({
          pid: pidStr,
          tty,
          cpu: `${cpu}%`,
          mem: `${mem}%`,
          elapsed,
          state,
          cwd,
          projectName,
          status,
        });
      } catch {}
    }

    return sessions;
  } catch {
    return [];
  }
}

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
    overflow: hidden;
  }

  .room {
    position: relative;
    width: 100vw;
    height: 100vh;
    perspective: 800px;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding-top: 30px;
  }

  .header {
    text-align: center;
    margin-bottom: 30px;
    z-index: 10;
  }

  .header h1 {
    font-size: 14px;
    font-weight: 300;
    color: #555;
    letter-spacing: 4px;
    text-transform: uppercase;
  }

  .header .count {
    font-size: 48px;
    font-weight: 700;
    color: #fff;
    margin: 5px 0;
  }

  .header .subtitle {
    font-size: 12px;
    color: #444;
    letter-spacing: 2px;
  }

  .grid {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 30px;
    padding: 20px 40px;
    max-width: 1200px;
  }

  .station {
    width: 280px;
    cursor: pointer;
    transition: transform 0.3s ease, box-shadow 0.3s ease;
    position: relative;
  }

  .station:hover {
    transform: translateY(-5px) scale(1.02);
  }

  .monitor {
    background: #111;
    border: 1px solid #222;
    border-radius: 8px;
    padding: 16px;
    position: relative;
    overflow: hidden;
  }

  .monitor::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 1px;
    background: linear-gradient(90deg, transparent, #333, transparent);
  }

  .screen {
    background: #0d1117;
    border: 1px solid #1a1a2e;
    border-radius: 4px;
    padding: 12px;
    min-height: 120px;
    position: relative;
    overflow: hidden;
  }

  .screen::after {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: repeating-linear-gradient(
      0deg,
      transparent,
      transparent 2px,
      rgba(0,0,0,0.03) 2px,
      rgba(0,0,0,0.03) 4px
    );
    pointer-events: none;
  }

  .screen-header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 10px;
    padding-bottom: 8px;
    border-bottom: 1px solid #1a1a2e;
  }

  .dot { width: 6px; height: 6px; border-radius: 50%; }
  .dot.red { background: #ff5f56; }
  .dot.yellow { background: #ffbd2e; }
  .dot.green { background: #27c93f; }

  .screen-title {
    font-size: 9px;
    color: #555;
    margin-left: auto;
    text-transform: uppercase;
    letter-spacing: 1px;
  }

  .ascii-art {
    font-size: 10px;
    line-height: 1.2;
    color: #cc7832;
    white-space: pre;
    margin-bottom: 8px;
  }

  .project-name {
    font-size: 13px;
    font-weight: 500;
    color: #e0e0e0;
    margin-bottom: 4px;
  }

  .project-path {
    font-size: 9px;
    color: #444;
    word-break: break-all;
    margin-bottom: 8px;
  }

  .status-line {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
  }

  .status-indicator {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .status-indicator.working {
    background: #27c93f;
    box-shadow: 0 0 8px #27c93f88;
    animation: pulse 1s ease-in-out infinite;
  }

  .status-indicator.thinking {
    background: #ffbd2e;
    box-shadow: 0 0 8px #ffbd2e88;
    animation: pulse 2s ease-in-out infinite;
  }

  .status-indicator.idle {
    background: #555;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .status-text {
    font-size: 11px;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 1px;
  }

  .stats {
    display: flex;
    gap: 12px;
    margin-top: 8px;
    font-size: 10px;
    color: #555;
  }

  .stat-label { color: #444; }
  .stat-value { color: #777; }

  .stand {
    width: 40px;
    height: 15px;
    background: #181818;
    margin: 0 auto;
    border-radius: 0 0 4px 4px;
  }

  .base {
    width: 70px;
    height: 4px;
    background: #181818;
    margin: 0 auto;
    border-radius: 2px;
  }

  .hint {
    font-size: 9px;
    color: #333;
    text-align: center;
    margin-top: 8px;
    opacity: 0;
    transition: opacity 0.2s;
  }

  .station:hover .hint {
    opacity: 1;
  }

  .no-sessions {
    text-align: center;
    color: #333;
    font-size: 14px;
    margin-top: 100px;
  }

  .refresh-note {
    position: fixed;
    bottom: 20px;
    right: 20px;
    font-size: 10px;
    color: #333;
  }

  /* Floor reflection */
  .room::after {
    content: '';
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: 100px;
    background: linear-gradient(to bottom, transparent, rgba(20,20,20,0.5));
    pointer-events: none;
  }

  /* Ambient glow behind active stations */
  .station.working .monitor {
    box-shadow: 0 0 30px rgba(39, 201, 63, 0.05);
  }

  .station.thinking .monitor {
    box-shadow: 0 0 30px rgba(255, 189, 46, 0.05);
  }
</style>
</head>
<body>
<div class="room">
  <div class="header">
    <h1>See Claude</h1>
    <div class="count" id="count">-</div>
    <div class="subtitle">active sessions</div>
  </div>
  <div class="grid" id="grid"></div>
  <div class="refresh-note">auto-refreshes every 3s</div>
</div>

<script>
const ASCII_LOGO = \`  ╔═╗┬  ┌─┐┬ ┬┌┬┐┌─┐
  ║  │  ├─┤│ │ ││├┤
  ╚═╝┴─┘┴ ┴└─┘─┴┘└─┘\`;

const ASCII_SMALL = \`  > claude _\`;

function getStatusColor(status) {
  switch(status) {
    case 'working': return '#27c93f';
    case 'thinking': return '#ffbd2e';
    default: return '#555';
  }
}

function getStatusLabel(status) {
  switch(status) {
    case 'working': return 'Working';
    case 'thinking': return 'Thinking';
    default: return 'Idle';
  }
}

function renderSessions(sessions) {
  const grid = document.getElementById('grid');
  const count = document.getElementById('count');

  count.textContent = sessions.length;

  if (sessions.length === 0) {
    grid.innerHTML = '<div class="no-sessions">No Claude sessions detected</div>';
    return;
  }

  grid.innerHTML = sessions.map(s => \`
    <div class="station \${s.status}" onclick="openTerminal('\${s.tty}', '\${s.pid}')" title="Click to focus terminal">
      <div class="monitor">
        <div class="screen">
          <div class="screen-header">
            <div class="dot red"></div>
            <div class="dot yellow"></div>
            <div class="dot green"></div>
            <span class="screen-title">\${s.tty}</span>
          </div>
          <div class="ascii-art">\${ASCII_SMALL}</div>
          <div class="project-name">\${s.projectName}</div>
          <div class="project-path">\${s.cwd}</div>
          <div class="status-line">
            <div class="status-indicator \${s.status}"></div>
            <span class="status-text">\${getStatusLabel(s.status)}</span>
          </div>
          <div class="stats">
            <span><span class="stat-label">CPU</span> <span class="stat-value">\${s.cpu}</span></span>
            <span><span class="stat-label">MEM</span> <span class="stat-value">\${s.mem}</span></span>
            <span><span class="stat-label">UP</span> <span class="stat-value">\${s.elapsed}</span></span>
            <span><span class="stat-label">PID</span> <span class="stat-value">\${s.pid}</span></span>
          </div>
        </div>
      </div>
      <div class="stand"></div>
      <div class="base"></div>
      <div class="hint">click to focus terminal</div>
    </div>
  \`).join('');
}

async function openTerminal(tty, pid) {
  try {
    await fetch('/api/focus?tty=' + encodeURIComponent(tty) + '&pid=' + encodeURIComponent(pid));
  } catch {}
}

async function refresh() {
  try {
    const res = await fetch('/api/sessions');
    const data = await res.json();
    renderSessions(data);
  } catch(e) {
    console.error('Refresh failed', e);
  }
}

refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/api/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getClaudeSessions()));
  } else if (req.url?.startsWith('/api/focus')) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const tty = url.searchParams.get('tty');

    // Use AppleScript to focus the correct Terminal tab
    if (tty) {
      try {
        // Map tty name to tab - AppleScript to find and activate the right tab
        const script = `
          tell application "Terminal"
            activate
            set tabList to every tab of every window
            repeat with w from 1 to count of windows
              set win to window w
              repeat with t from 1 to count of tabs of win
                set theTab to tab t of win
                if tty of theTab contains "${tty.replace(/^ttys?/, '')}" then
                  set selected tab of win to theTab
                  set index of win to 1
                  return "found"
                end if
              end repeat
            end repeat
          end tell
        `;
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
