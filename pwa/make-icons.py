"""Generate PWA icons from the bundled panorama (run: python3 pwa/make-icons.py)."""
from PIL import Image, ImageDraw, ImageFilter

SRC = 'public/artwork/file_00000000f77881f5987cd6d628ca6347.png'
INK = (8, 10, 13)
PAPER = (223, 214, 199)
BLUE = (129, 187, 202)

def base_art(size):
    art = Image.open(SRC).convert('RGB')
    w, h = art.size
    side = min(w, h)
    left = (w - side) // 2
    art = art.crop((left, 0, left + side, side)).resize((size, size), Image.LANCZOS)
    # dark vignette so the frame mark reads at small sizes
    shade = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(shade)
    d.ellipse((-size * 0.25, -size * 0.25, size * 1.25, size * 1.25), fill=255)
    shade = shade.filter(ImageFilter.GaussianBlur(size * 0.18))
    dark = Image.new('RGB', (size, size), INK)
    return Image.composite(art, dark, shade)

def mark(size, inset):
    img = base_art(size)
    d = ImageDraw.Draw(img)
    s = size
    line = max(2, round(s * 0.018))
    a = round(s * inset)
    off = round(s * 0.06)
    # two offset frames: "between two frames"
    d.rectangle((a, a, s - a - off, s - a - off), outline=PAPER, width=line)
    d.rectangle((a + off, a + off, s - a, s - a), outline=BLUE, width=max(1, line - 1))
    return img

def write(img, size, name):
    img.resize((size, size), Image.LANCZOS).save(f'public/icons/{name}', optimize=True)

any_icon = mark(1024, 0.16)
maskable = mark(1024, 0.25)  # keep the mark inside the 80% maskable safe zone
write(any_icon, 192, 'icon-192.png')
write(any_icon, 512, 'icon-512.png')
write(maskable, 192, 'icon-maskable-192.png')
write(maskable, 512, 'icon-maskable-512.png')
write(any_icon, 180, 'apple-touch-icon.png')
print('icons written')
