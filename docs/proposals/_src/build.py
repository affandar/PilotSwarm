import re
from pathlib import Path

HERE = Path(__file__).parent
TUI = {k: (HERE / f"tui-{k}.html").read_text() for k in ("winamp", "doom", "quake")}

# ── Reusable fragments ────────────────────────────────────────────
LOGO = {
 "winamp": """<rect x="0" y="0" width="32" height="32" fill="#000"/>
          <rect x="3" y="17" width="4" height="11" fill="#00e337"/>
          <rect x="9" y="11" width="4" height="17" fill="#7ad91e"/>
          <rect x="15" y="6" width="4" height="22" fill="#b6e000"/>
          <rect x="21" y="13" width="4" height="15" fill="#ffb400"/>
          <rect x="27" y="20" width="3" height="8" fill="#ff3b00"/>""",
 "doom": """<rect x="0" y="0" width="32" height="32" fill="#2a1d14"/>
          <rect x="6" y="6" width="20" height="21" rx="2" fill="#c89a6a"/>
          <rect x="5" y="7" width="22" height="5" rx="2" fill="#4a2f1a"/>
          <rect x="9" y="15" width="5" height="3.4" fill="#1a1008"/>
          <rect x="18" y="15" width="5" height="3.4" fill="#1a1008"/>
          <rect x="8.5" y="13" width="6" height="1.6" fill="#3a2412" transform="rotate(9 11.5 13.8)"/>
          <rect x="17.5" y="13" width="6" height="1.6" fill="#3a2412" transform="rotate(-9 20.5 13.8)"/>
          <rect x="11" y="22" width="10" height="1.8" fill="#7a3a2a"/>
          <rect x="14.5" y="18.5" width="3" height="2.4" fill="#a8734a"/>""",
 "quake": """<rect x="0" y="0" width="32" height="32" fill="#0b0a09"/>
          <circle cx="15" cy="14" r="8.6" fill="none" stroke="#6b6154" stroke-width="5.2"/>
          <rect x="17.6" y="17" width="5.4" height="12.4" rx="0.6" fill="#6b6154" transform="rotate(-38 20.3 23.2)"/>
          <circle cx="15" cy="14" r="2.7" fill="#e0952b"/>
          <circle cx="15" cy="14" r="5" fill="none" stroke="rgba(224,149,43,0.22)" stroke-width="3"/>""",
}

def mark(theme, size):
    return f'<svg class="mark mark-{size}" viewBox="0 0 32 32" aria-hidden="true">{LOGO[theme]}</svg>'

DOTS = {
 "winamp": ["#00e337", "#b6e000", "#ffb400", "#ff3b00"],
 "doom":   ["#3f9e3f", "#3050d0", "#e8c020", "#b81c1c"],
 "quake":  ["#8a7f6c", "#4a6fd4", "#e0952b", "#c4441a"],
}

def rows(theme, n=7):
    ok, run, wait, fail = DOTS[theme]
    all_rows = [
      f'<div class="row"><span class="sys">◉ PilotSwarm</span><span class="meta">[+4]</span></div>',
      f'<div class="row"><span class="fold">▣ Kit Navigator</span><span class="meta">12</span></div>',
      f'<div class="row"><span class="dot" style="--dot:{ok}"></span><span class="disc">AD</span><span class="label">Equity Fundamentals</span><span class="meta">22%</span></div>',
      f'<div class="row sel"><span class="dot"></span><span class="disc">AD</span><span class="label">regen cross-surface test</span><span class="meta">15%</span></div>',
      f'<div class="row"><span class="dot" style="--dot:{run}"></span><span class="disc">GH</span><span class="label">regen prod validation</span><span class="meta">running</span></div>',
      f'<div class="row"><span class="dot" style="--dot:{wait}"></span><span class="disc">AD</span><span class="label">Caveman Editor</span><span class="meta">waiting</span></div>',
      f'<div class="row"><span class="dot" style="--dot:{fail}"></span><span class="disc">GH</span><span class="label">Adversarial review</span><span class="meta">failed</span></div>',
    ]
    return "\n              ".join(all_rows[:n])

LOG = """<div><span class="ts">[24 Jul 09:40:29]</span> <span class="tick">✓✓</span> <span class="who-you">You:</span> You are a regen cross-surface test session. Reply "ready" and then just answer tersely.</div>
              <div><span class="ts">[24 Jul 09:40:31]</span> <span class="who-ag">Agent:</span> ready</div>
              <div><span class="ts">[24 Jul 09:41:23]</span> <span class="tick">✓✓</span> <span class="who-you">You:</span> turn A — reply "A"</div>
              <div><span class="ts">[24 Jul 09:41:24]</span> <span class="who-ag">Agent:</span> A</div>"""

LOG_M = """<div><span class="ts">[09:41:23]</span> <span class="tick">✓✓</span> <span class="who-you">You:</span> turn A — reply "A"</div>
            <div><span class="ts">[09:41:24]</span> <span class="who-ag">Agent:</span> A</div>"""

PANEL_BTNS = '<span class="p-btns"><span class="p-btn">⚲</span><span class="p-btn">▤</span><span class="p-btn">≡</span><span class="p-btn">∞</span><span class="p-btn">🗑</span></span>'

def desktop_body(theme):
    return f"""<div class="p-toolbar">
          <span class="p-tool">+</span><span class="p-tool">▼</span>
          <span class="p-tool">◐</span><span class="p-tool">≡</span><span class="p-tool">⛶</span>
        </div>
        <div class="p-body">
          <div class="p-panel">
            <div class="p-panel-bar"><span class="p-panel-title">Sessions</span>{PANEL_BTNS}</div>
            <div class="p-rows">
              {rows(theme)}
            </div>
          </div>
          <div class="p-panel p-chat">
            <div class="p-panel-bar">
              <span class="p-panel-title">regen cross-surface test</span>
              <span class="p-panel-meta">idle · claude-sonnet-5</span>
            </div>
            <div class="p-log">
              {LOG}
            </div>
            <div class="p-composer">
              <span class="p-you">YOU</span><span class="p-input">Type a message and press Enter</span><span class="p-send">›</span>
            </div>
          </div>
        </div>
        <div class="p-tabs"><span class="p-tab on">Main</span><span class="p-tab">Inspector</span><span class="p-tab">Activity</span></div>"""

def mobile_body(theme):
    return f"""<div class="m-toolbar">
          <span class="m-tool">+</span><span class="m-tool">▼</span><span class="m-tool">◐</span>
          <span class="m-tool">≡</span><span class="m-tool">⛶</span>
        </div>
        <div class="m-panel">
          <div class="p-panel-bar"><span class="p-panel-title">Sessions</span>
            <span class="p-btns"><span class="p-btn">⚲</span><span class="p-btn">▤</span><span class="p-btn">≡</span></span></div>
          <div class="p-rows">
              {rows(theme, 5)}
          </div>
        </div>
        <div class="m-panel">
          <div class="p-panel-bar"><span class="p-panel-title">regen cross-surface</span>
            <span class="p-panel-meta">idle</span></div>
          <div class="m-log">
            {LOG_M}
          </div>
          <div class="p-composer">
            <span class="p-input">Type a message…</span><span class="p-send">›</span>
          </div>
        </div>
        <div class="p-tabs"><span class="p-tab on">Main</span><span class="p-tab">Inspector</span><span class="p-tab">Activity</span></div>"""

# ── Per-theme headers, desktop and mobile ─────────────────────────
HEAD_D = {
 "winamp": f"""<div class="wa-titlebar">
          <span class="wa-word">PILOTSWARM</span><span class="wa-grip"></span>
          <span class="wa-wbtn">_</span><span class="wa-wbtn">▤</span><span class="wa-wbtn">×</span>
        </div>
        <div class="wa-display">
          <span class="wa-tile">{mark('winamp', 28)}</span>
          <span class="wa-glass">
            <span class="wa-time">16%</span>
            <span class="wa-track">
              <span class="wa-scroll">*** Ada Lovelace — ada@example.com ***</span>
              <span class="wa-kbps">7 SESSIONS · 4 RUNNING · STEREO</span>
            </span>
          </span>
          <span class="wa-right"><span class="wa-chip">v0.5.30</span><span class="wa-chip">Sign Out</span></span>
        </div>""",
 "doom": f"""<div class="doom-stbar">
          <span class="doom-cell"><span class="doom-num">7</span><span class="doom-lab">Sessions</span></span>
          <span class="doom-cell"><span class="doom-num">16%</span><span class="doom-lab">Context</span></span>
          <span class="doom-face">{mark('doom', 48)}</span>
          <span class="doom-ident">
            <span class="doom-brand">PILOTSWARM</span>
            <span class="doom-user">Ada Lovelace</span>
            <span class="doom-mail">ada@example.com</span>
          </span>
          <span class="doom-cell"><span class="doom-num">4</span><span class="doom-lab">Running</span></span>
          <span class="doom-keys">
            <span class="doom-key" style="background:#3050d0"></span>
            <span class="doom-key" style="background:#e8c020"></span>
            <span class="doom-key" style="background:#b81c1c"></span>
          </span>
          <span class="doom-exit">Sign Out</span>
        </div>""",
 "quake": f"""<div class="qk-slab">
          <span class="qk-tile">{mark('quake', 48)}</span>
          <span class="qk-ident">
            <span class="qk-brand">PILOTSWARM</span>
            <span class="qk-user">Ada Lovelace</span>
            <span class="qk-mail">ada@example.com</span>
          </span>
          <span class="qk-hud">
            <span class="qk-num">7</span><span class="qk-unit">sessions</span>
            <span class="qk-num" style="margin-left:14px">16</span><span class="qk-unit">% ctx</span>
          </span>
          <span class="qk-exit">Sign Out</span>
        </div>""",
}

HEAD_M = {
 "winamp": f"""<div class="wa-titlebar">
          <span class="wa-word">PILOTSWARM</span><span class="wa-grip"></span>
          <span class="wa-wbtn">_</span><span class="wa-wbtn">×</span>
        </div>
        <div class="wa-display" style="padding:7px 8px;gap:8px">
          <span class="wa-tile">{mark('winamp', 16)}</span>
          <span class="wa-glass" style="padding:5px 8px;gap:9px">
            <span class="wa-time" style="font-size:16px">16%</span>
            <span class="wa-track">
              <span class="wa-scroll" style="font-size:9.5px">*** Ada Lovelace ***</span>
              <span class="wa-kbps" style="font-size:8px">7 SESS · 4 RUN</span>
            </span>
          </span>
        </div>""",
 "doom": f"""<div class="doom-stbar" style="padding:5px 7px">
          <span class="doom-face" style="padding:2px">{mark('doom', 28)}</span>
          <span class="doom-cell" style="padding:0 9px"><span class="doom-num" style="font-size:19px">7</span><span class="doom-lab" style="font-size:7px">Sessions</span></span>
          <span class="doom-cell" style="padding:0 9px"><span class="doom-num" style="font-size:19px">16%</span><span class="doom-lab" style="font-size:7px">Context</span></span>
          <span class="doom-keys" style="padding:0 8px">
            <span class="doom-key" style="background:#3050d0;width:12px"></span>
            <span class="doom-key" style="background:#e8c020;width:12px"></span>
            <span class="doom-key" style="background:#b81c1c;width:12px"></span>
          </span>
        </div>
        <div class="doom-substrip"><span class="doom-user">Ada Lovelace</span><span class="doom-mail">ada@example.com</span></div>""",
 "quake": f"""<div class="qk-slab" style="padding:9px 10px;gap:10px">
          <span class="qk-tile" style="padding:3px">{mark('quake', 28)}</span>
          <span class="qk-ident">
            <span class="qk-brand" style="font-size:9.5px">PILOTSWARM</span>
            <span class="qk-user" style="font-size:10px">Ada Lovelace</span>
          </span>
          <span class="qk-hud"><span class="qk-num" style="font-size:19px">7</span><span class="qk-unit">sess</span></span>
        </div>""",
}

TEMPLATE = (HERE / "template.html").read_text()
out = TEMPLATE
for t in ("winamp", "doom", "quake"):
    out = out.replace(f"{{{{HEAD_D_{t}}}}}", HEAD_D[t])
    out = out.replace(f"{{{{HEAD_M_{t}}}}}", HEAD_M[t])
    out = out.replace(f"{{{{BODY_D_{t}}}}}", desktop_body(t))
    out = out.replace(f"{{{{BODY_M_{t}}}}}", mobile_body(t))
    out = out.replace(f"{{{{TUI_{t}}}}}", TUI[t])
    for size in (48, 28, 16):
        out = out.replace(f"{{{{MARK_{t}_{size}}}}}", mark(t, size))

leftover = re.findall(r"\{\{[A-Z_0-9]+\}\}", out)
assert not leftover, f"unsubstituted placeholders: {sorted(set(leftover))}"
(HERE / "retro-themes.html").write_text(out)
print(f"wrote retro-themes.html ({len(out):,} bytes)")
