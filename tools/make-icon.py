# Draws the app icon (a red 2x2 brick seen from above) at 1024px.
# Run: python3 tools/make-icon.py && cargo tauri icon src-tauri/icons/source.png
from PIL import Image, ImageDraw, ImageFilter

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
# macOS-style rounded tile background
d.rounded_rectangle((64, 64, S - 64, S - 64), radius=200, fill=(250, 204, 21, 255))

# soft shadow under the brick
sh = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(sh).rounded_rectangle((230, 260, 820, 850), radius=40, fill=(0, 0, 0, 110))
img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(28)))

d = ImageDraw.Draw(img)
d.rounded_rectangle((212, 212, 812, 812), radius=36, fill=(201, 26, 9, 255))
d.rounded_rectangle((212, 212, 812, 790), radius=36, fill=(222, 38, 20, 255))
for cx in (362, 662):
    for cy in (362, 662):
        r = 105
        d.ellipse((cx - r, cy - r + 18, cx + r, cy + r + 18), fill=(150, 18, 6, 255))
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(236, 60, 40, 255))
        d.ellipse((cx - r + 22, cy - r + 16, cx + r - 40, cy + r - 46), fill=(246, 96, 76, 255))
img.save("src-tauri/icons/source.png")
print("wrote src-tauri/icons/source.png")
