"""
Generate the TUI specimen as exactly-aligned box-drawing text.

Hand-padding 14 lines × 3 themes is how alignment bugs get into a specimen,
so the frame is computed instead. Content is identical across themes — only
the logo glyphs and the CSS colour classes differ — so the geometry is solved
once here and reused.
"""

W_LEFT, W_RIGHT = 25, 32
W = W_LEFT + 1 + W_RIGHT          # 58 interior columns


def pad(s, n):
    """Pad to n display columns. Every glyph used here is single-width."""
    assert len(s) <= n, f"overflow ({len(s)}/{n}): {s!r}"
    return s + " " * (n - len(s))


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def span(cls, text):
    return f'<span class="{cls}">{esc(text)}</span>' if cls else esc(text)


def row(left_parts, right_parts):
    """One body line: │ left │ right │ — each side a list of (cls, text)."""
    lw = sum(len(t) for _, t in left_parts)
    rw = sum(len(t) for _, t in right_parts)
    left = "".join(span(c, t) for c, t in left_parts) + " " * (W_LEFT - lw)
    right = "".join(span(c, t) for c, t in right_parts) + " " * (W_RIGHT - rw)
    return f'<span class="fr">│</span>{left}<span class="fr">│</span>{right}<span class="fr">│</span>'


def full(parts):
    """One full-width line spanning both panes."""
    w = sum(len(t) for _, t in parts)
    return (f'<span class="fr">│</span>'
            + "".join(span(c, t) for c, t in parts) + " " * (W - w)
            + '<span class="fr">│</span>')


def build(logo):
    L = []
    A = L.append
    A(f'<span class="fr">┌{"─" * W}┐</span>')
    A(full([("acc", f" {logo}  "), ("hdr", "PILOTSWARM"),
            (None, " " * 19), ("dim", "v0.5.30"), (None, "  "), ("hdr", "[Sign Out]")]))
    A(full([(None, " " * 8), ("hdr", "Ada Lovelace"), ("dim", " · ada@example.com")]))
    A(f'<span class="fr">├{"─" * W_LEFT}┬{"─" * W_RIGHT}┤</span>')
    A(row([("hdr", " SESSIONS"), (None, " " * 12), ("dim", "[7]")],
          [("hdr", " regen cross-surface test")]))
    A(row([("acc", " ⚙ PilotSwarm"), (None, "      "), ("dim", "[+4]")],
          [("dim", " idle · claude-sonnet-5")]))
    A(row([("fold", " ▣ Kit Navigator"), (None, "     "), ("dim", "12")], []))
    A(row([(None, " "), ("ok", "○"), (None, " "), ("disc", "AD"), (None, " Equity Fund    "), ("dim", "22%")],
          [("dim", " [09:40:29] "), ("ok", "✓✓"), (None, " "), ("you", "You:"), (None, " You are a")]))
    A(row([("sel", " ▶ AD regen cross    15% ")],
          [(None, " " * 12), (None, "regen cross-surface")]))
    A(row([(None, " "), ("run", "○"), (None, " "), ("disc", "GH"), (None, " regen prod     "), ("dim", "run")],
          [("dim", " [09:40:31] "), ("ag", "Agent:"), (None, " ready")]))
    A(row([(None, " "), ("wait", "○"), (None, " "), ("disc", "AD"), (None, " Caveman Ed     "), ("dim", "wai")],
          [("dim", " [09:41:23] "), ("ok", "✓✓"), (None, " "), ("you", "You:"), (None, " turn A")]))
    A(row([(None, " "), ("fail", "○"), (None, " "), ("disc", "GH"), (None, " Adversarial    "), ("dim", "fai")],
          [("dim", " [09:41:24] "), ("ag", "Agent:"), (None, " A")]))
    A(f'<span class="fr">├{"─" * W_LEFT}┴{"─" * W_RIGHT}┤</span>')
    A(full([("dim", " YOU "), ("acc", "▶"), ("dim", " Type a message and press Enter"),
            (None, " " * 17), ("hdr", "[→]")]))
    A(f'<span class="fr">└{"─" * W}┘</span>')
    A(f'  <span class="sel"> Main </span><span class="dim"> │ Inspector │ Activity</span>'
      f'{" " * 19}<span class="dim">^K commands</span>')
    return "\n".join(L)


for name, logo in [("winamp", "▂▄█▅▂"), ("doom", "[▀▄▀]"), ("quake", "─[Q]─")]:
    with open(f"tui-{name}.html", "w") as f:
        f.write(build(logo))
    print(f"tui-{name}.html")
