"""Generates every Sandwich logo asset from one definition.

The mark is a burger seen head-on with a download arrow punched through the fillings — the
same idea the progress bar uses, where a file arrives as stacked layers. Keeping it here as
code rather than a folder of exported images means the app icon, the extension icons and the
README lockup can never drift apart, and any of them can be regenerated at any size.

    python tools/make-logo.py

Everything is drawn at 6x and box-filtered down, which is what keeps the 16px icon legible.
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SS = 6  # supersample factor

# Palette read from the supplied artwork.
CRUST = (247, 178, 106)
CRUST_DARK = (240, 160, 82)
OUTLINE = (139, 90, 60)
SEED = (245, 230, 200)
LETTUCE = (124, 179, 66)
TOMATO = (232, 65, 47)
CHEESE = (255, 212, 38)
WHITE = (255, 255, 255)
INK = (32, 32, 32)
INK_SOFT = (58, 58, 58)


def draw_mark(size: int) -> Image.Image:
    """The burger mark on a transparent square canvas."""
    s = size * SS
    image = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(image)

    def px(v: float) -> float:
        return v * s

    stroke = max(2, int(px(0.028)))
    left, right = px(0.06), px(0.94)

    # Layer bands, top to bottom. The buns carry the rounding; the fillings are slim slabs.
    top_bun = (px(0.19), px(0.45))
    lettuce = (px(0.45), px(0.565))
    tomato = (px(0.565), px(0.665))
    cheese = (px(0.665), px(0.745))
    bottom_bun = (px(0.745), px(0.90))

    # Bottom bun first so the stack overlaps downward like the real thing.
    d.rounded_rectangle(
        [left, bottom_bun[0], right, bottom_bun[1]],
        radius=px(0.10),
        fill=CRUST,
        outline=OUTLINE,
        width=stroke,
        corners=(False, False, True, True),
    )
    for band, colour in ((cheese, CHEESE), (tomato, TOMATO), (lettuce, LETTUCE)):
        d.rounded_rectangle(
            [left, band[0], right, band[1]],
            radius=px(0.035),
            fill=colour,
            outline=OUTLINE,
            width=stroke,
        )
    # Top bun: a dome, so only the upper corners are rounded and rounded hard.
    d.rounded_rectangle(
        [left, top_bun[0], right, top_bun[1]],
        radius=px(0.16),
        fill=CRUST,
        outline=OUTLINE,
        width=stroke,
        corners=(True, True, False, False),
    )

    # Sesame seeds, only once the icon is large enough for them to read as seeds rather
    # than as noise.
    if size >= 48:
        seeds = [(0.30, 0.27), (0.44, 0.245), (0.58, 0.265), (0.68, 0.31), (0.36, 0.335)]
        for cx, cy in seeds:
            rx, ry = px(0.043), px(0.028)
            d.ellipse(
                [px(cx) - rx, px(cy) - ry, px(cx) + rx, px(cy) + ry],
                fill=SEED,
            )

    # The download arrow, punched clean through the fillings.
    stem_half = px(0.075)
    head_half = px(0.185)
    stem_top = px(0.315)
    stem_bottom = px(0.60)
    tip = px(0.84)
    arrow = [
        (px(0.5) - stem_half, stem_top),
        (px(0.5) + stem_half, stem_top),
        (px(0.5) + stem_half, stem_bottom),
        (px(0.5) + head_half, stem_bottom),
        (px(0.5), tip),
        (px(0.5) - head_half, stem_bottom),
        (px(0.5) - stem_half, stem_bottom),
    ]
    d.polygon(arrow, fill=WHITE)

    return image.resize((size, size), Image.LANCZOS)


def load_font(bold: bool, size: int):
    candidates = (
        ["segoeuib.ttf", "seguisb.ttf", "arialbd.ttf"]
        if bold
        else ["segoeui.ttf", "arial.ttf"]
    )
    for name in candidates:
        path = Path("C:/Windows/Fonts") / name
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default(size)


def draw_lockup(height: int = 320) -> Image.Image:
    """Horizontal logo: mark plus the two lines of type, for the README and the site."""
    mark_size = int(height * 0.72)
    mark = draw_mark(mark_size)

    title_font = load_font(True, int(height * 0.30))
    sub_font = load_font(False, int(height * 0.175))

    probe = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    title = "Sandwich"
    sub = "Download Manager"
    title_w = probe.textlength(title, font=title_font)
    sub_w = probe.textlength(sub, font=sub_font)

    gap = int(height * 0.14)
    width = mark_size + gap + int(max(title_w, sub_w)) + int(height * 0.06)
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    image.paste(mark, (0, (height - mark_size) // 2), mark)

    d = ImageDraw.Draw(image)
    text_x = mark_size + gap
    d.text((text_x, height * 0.24), title, font=title_font, fill=INK, anchor="ls")
    d.text((text_x, height * 0.60), sub, font=sub_font, fill=INK_SOFT, anchor="ls")
    return image


def write_ico(path: Path, sizes=(16, 24, 32, 48, 64, 128, 256)) -> None:
    frames = [draw_mark(size) for size in sizes]
    frames[-1].save(path, format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[:-1])


# Installer wizard artwork. NSIS and WiX take 24-bit BMPs at fixed sizes; anything else is
# silently letterboxed or rejected, which is why the sizes are hard-coded here rather than
# parameters. The warm cream matches the app's Classic canvas, so install → first launch
# reads as one product, not a generic gray wizard handing off to a branded app.
CREAM = (251, 247, 241)

def _cream_canvas(width: int, height: int) -> Image.Image:
    return Image.new("RGB", (width, height), CREAM)


def draw_nsis_header(path: Path) -> None:
    """150x57, shown top-right of every wizard page: the mark alone, small and clean."""
    canvas = _cream_canvas(150, 57)
    mark = draw_mark(40)
    canvas.paste(mark, (150 - 40 - 12, (57 - 40) // 2), mark)
    canvas.save(path, format="BMP")


def draw_nsis_sidebar(path: Path) -> None:
    """164x314, the tall welcome/finish panel: mark over the stacked wordmark."""
    canvas = _cream_canvas(164, 314)
    mark = draw_mark(96)
    canvas.paste(mark, ((164 - 96) // 2, 52), mark)

    d = ImageDraw.Draw(canvas)
    title_font = load_font(True, 24)
    sub_font = load_font(False, 13)
    d.text((82, 196), "Sandwich", font=title_font, fill=INK, anchor="ms")
    d.text((82, 218), "Download Manager", font=sub_font, fill=INK_SOFT, anchor="ms")
    canvas.save(path, format="BMP")


def draw_wix_banner(path: Path) -> None:
    """493x58, the strip across the top of MSI dialogs."""
    canvas = _cream_canvas(493, 58)
    mark = draw_mark(40)
    canvas.paste(mark, (493 - 40 - 14, (58 - 40) // 2), mark)
    canvas.save(path, format="BMP")


def draw_wix_dialog(path: Path) -> None:
    """493x312, the welcome/finish background. Art stays in the left 164px gutter the MSI
    text layout leaves free; the rest matches the dialog body."""
    canvas = Image.new("RGB", (493, 312), (255, 255, 255))
    d = ImageDraw.Draw(canvas)
    d.rectangle([0, 0, 164, 312], fill=CREAM)
    mark = draw_mark(96)
    canvas.paste(mark, ((164 - 96) // 2, 52), mark)
    title_font = load_font(True, 24)
    sub_font = load_font(False, 13)
    d.text((82, 196), "Sandwich", font=title_font, fill=INK, anchor="ms")
    d.text((82, 218), "Download Manager", font=sub_font, fill=INK_SOFT, anchor="ms")
    canvas.save(path, format="BMP")


def main() -> None:
    icons = ROOT / "apps" / "desktop" / "icons"
    extension = ROOT / "extension"
    assets = ROOT / "assets"
    for folder in (icons, extension, assets):
        folder.mkdir(parents=True, exist_ok=True)

    write_ico(icons / "icon.ico")
    print(f"wrote {icons / 'icon.ico'}")

    # Tauri also wants PNGs for the bundle and the window.
    for size in (32, 128, 256, 512):
        target = icons / f"{size}x{size}.png"
        draw_mark(size).save(target)
        print(f"wrote {target}")
    draw_mark(128).save(icons / "128x128@2x.png")

    for size in (16, 32, 48, 128):
        target = extension / f"icon{size}.png"
        draw_mark(size).save(target)
        print(f"wrote {target}")

    lockup = draw_lockup()
    lockup.save(assets / "logo.png")
    print(f"wrote {assets / 'logo.png'}  ({lockup.width}x{lockup.height})")
    draw_mark(512).save(assets / "mark.png")
    print(f"wrote {assets / 'mark.png'}")

    installer = ROOT / "apps" / "desktop" / "installer"
    installer.mkdir(parents=True, exist_ok=True)
    for name, draw in (
        ("nsis-header.bmp", draw_nsis_header),
        ("nsis-sidebar.bmp", draw_nsis_sidebar),
        ("wix-banner.bmp", draw_wix_banner),
        ("wix-dialog.bmp", draw_wix_dialog),
    ):
        draw(installer / name)
        print(f"wrote {installer / name}")


if __name__ == "__main__":
    main()
