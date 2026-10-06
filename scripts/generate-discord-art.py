# Regenerates assets/discord/*.png (Rich Presence art assets).
# Usage: python3 scripts/generate-discord-art.py <orca>/resources/build/icon.png assets/discord
import sys
from PIL import Image, ImageDraw
src, out = sys.argv[1], sys.argv[2]
S = 4  # supersample

# Logo: crop to the fully opaque tile, dropping the soft drop shadow.
im = Image.open(src).convert('RGBA')
alpha = im.getchannel('A').point(lambda a: 255 if a >= 250 else 0)
im.crop(alpha.getbbox()).resize((1024, 1024), Image.LANCZOS).save(f'{out}/orca.png')

def badge(name, color, glyph):
    n = 512 * S
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse((0, 0, n-1, n-1), fill=color)
    glyph(d, n)
    img.resize((512, 512), Image.LANCZOS).save(f'{out}/{name}.png')

W = (255, 255, 255, 255)
def spinner(d, n):
    m, t = n*0.24, int(n*0.095)
    d.arc((m, m, n-m, n-m), start=-60, end=210, fill=W, width=t)
    # round caps
    import math
    r = (n - 2*m)/2 - t/2; c = n/2
    for a in (-60, 210):
        x = c + r*math.cos(math.radians(a)); y = c + r*math.sin(math.radians(a))
        d.ellipse((x-t/2, y-t/2, x+t/2, y+t/2), fill=W)
def bang(d, n):
    bw = n*0.11
    d.rounded_rectangle((n/2-bw/2, n*0.22, n/2+bw/2, n*0.60), radius=bw/2, fill=W)
    d.ellipse((n/2-bw*0.62, n*0.68, n/2+bw*0.62, n*0.68+bw*1.24), fill=W)
def moon(d, n, bg=None):
    r = n*0.26; c = n/2
    d.ellipse((c-r, c-r, c+r, c+r), fill=W)
    o = n*0.13
    d.ellipse((c-r+o, c-r-o*0.6, c+r+o, c+r-o*0.6), fill=(128, 132, 142, 255))

badge('working', (35, 165, 90, 255), spinner)
badge('waiting', (240, 178, 50, 255), bang)
badge('idle', (128, 132, 142, 255), moon)
