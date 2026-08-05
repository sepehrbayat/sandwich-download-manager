"""WCAG contrast gate for every Sandwich theme.

Each theme recolors only the canvas tokens; the orange brand and status colors are fixed.
This script is the reason a theme cannot ship pretty-but-unreadable: it computes the WCAG
relative-luminance contrast ratio for the pairs that carry information and exits non-zero
if any theme misses AA. Run it whenever a theme hex changes.

  python tools/check-contrast.py
"""

import sys

# Keep in lockstep with the [data-theme] blocks in src/styles.css.
THEMES = {
    "classic":   {"bg": "fbf7f1", "surface": "ffffff", "sunk": "f6efe5", "ink": "2a1f17", "soft": "5d4c3e"},
    "rye":       {"bg": "14100c", "surface": "1d1712", "sunk": "241d16", "ink": "f6efe4", "soft": "b8a692"},
    "sesame":    {"bg": "f4f4f2", "surface": "ffffff", "sunk": "ebebe7", "ink": "1f1f1c", "soft": "54544c"},
    "pistachio": {"bg": "f0f4ea", "surface": "fbfdf8", "sunk": "e5ecdc", "ink": "1f2619", "soft": "4c5a42"},
    "toast":     {"bg": "1a130b", "surface": "241a10", "sunk": "2c2013", "ink": "f7ecdd", "soft": "c2ab8f"},
}

# The fixed accent, checked against every canvas it sits on.
CRUST_DEEP_LIGHT = "c97b29"   # used on light canvases
CRUST_LIGHT_DARK = "f0ae4a"   # used on dark canvases (existing dark values)
DARK_THEMES = {"rye", "toast"}


def luminance(hex_color):
    channels = []
    for i in (0, 2, 4):
        value = int(hex_color[i:i + 2], 16) / 255
        channels.append(value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4)
    r, g, b = channels
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(a, b):
    la, lb = luminance(a), luminance(b)
    lighter, darker = max(la, lb), min(la, lb)
    return (lighter + 0.05) / (darker + 0.05)


def main():
    failures = []
    for name, tokens in THEMES.items():
        accent = CRUST_LIGHT_DARK if name in DARK_THEMES else CRUST_DEEP_LIGHT
        checks = [
            # (label, foreground, background, minimum)
            ("ink on bg", tokens["ink"], tokens["bg"], 4.5),
            ("ink on surface", tokens["ink"], tokens["surface"], 4.5),
            ("ink on sunk", tokens["ink"], tokens["sunk"], 4.5),
            ("soft ink on bg", tokens["soft"], tokens["bg"], 4.5),
            ("soft ink on surface", tokens["soft"], tokens["surface"], 4.5),
            ("soft ink on sunk", tokens["soft"], tokens["sunk"], 4.5),
            # Accent is used for large/bold text and UI marks: 3.0 is the AA bar there.
            ("accent on surface", accent, tokens["surface"], 3.0),
        ]
        for label, fg, bg, minimum in checks:
            value = ratio(fg, bg)
            status = "ok " if value >= minimum else "FAIL"
            print(f"  [{status}] {name:9s} {label:18s} {value:5.2f} (needs {minimum})")
            if value < minimum:
                failures.append(f"{name}: {label} = {value:.2f} < {minimum}")

    if failures:
        print("\nContrast gate FAILED:")
        for failure in failures:
            print(f"  {failure}")
        return 1
    print("\nAll themes pass WCAG AA.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
