# -*- coding: utf-8 -*-
"""生成扩展图标：纸色底 + 校样批注（朱砂竖线 + 墨/朱砂交替的文本行）。"""
import os
from PIL import Image, ImageDraw

SS = 1024  # 超采样尺寸
PAPER = (251, 250, 247, 255)
PAPER_EDGE = (231, 226, 214, 255)
INK = (27, 26, 23, 255)
VERMILION = (194, 65, 12, 255)
VERMILION_SOFT = (222, 106, 55, 255)
SHADOW = (0, 0, 0, 28)

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "assets")


def rounded_rect(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def build():
    img = Image.new("RGBA", (SS, SS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    margin = int(SS * 0.055)
    radius = int(SS * 0.21)
    # 纸卡
    rounded_rect(draw, (margin, margin + int(SS * 0.012), SS - margin, SS - margin + int(SS * 0.012)), radius, SHADOW)
    rounded_rect(draw, (margin, margin, SS - margin, SS - margin), radius, PAPER)
    draw.rounded_rectangle(
        (margin, margin, SS - margin, SS - margin), radius=radius, outline=PAPER_EDGE, width=max(1, int(SS * 0.012))
    )

    # 朱砂校样竖线
    bar_x0 = int(SS * 0.215)
    bar_w = int(SS * 0.055)
    bar_y0 = int(SS * 0.255)
    bar_y1 = int(SS * 0.745)
    draw.rounded_rectangle((bar_x0, bar_y0, bar_x0 + bar_w, bar_y1), radius=bar_w // 2, fill=VERMILION)

    # 四行文本：墨 / 朱砂交替，长度不一，模拟双语对照
    text_x0 = int(SS * 0.325)
    line_h = int(SS * 0.078)
    gap = int(SS * 0.062)
    length_ratios = [0.66, 0.52, 0.62, 0.40]
    colors = [INK, VERMILION_SOFT, INK, VERMILION_SOFT]
    y = int(SS * 0.262)
    for ratio, color in zip(length_ratios, colors):
        line_w = int((SS - margin * 2 - int(SS * 0.36)) * ratio)
        draw.rounded_rectangle(
            (text_x0, y, text_x0 + line_w, y + line_h), radius=line_h // 2, fill=color
        )
        y += line_h + gap

    return img


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    base = build()
    for size in (16, 32, 48, 128):
        resized = base.resize((size, size), Image.LANCZOS)
        path = os.path.join(OUT_DIR, "icon%d.png" % size)
        resized.save(path, "PNG")
        print("wrote", path)
    # 预览用大图
    preview = base.resize((256, 256), Image.LANCZOS)
    preview.save(os.path.join(OUT_DIR, "icon-preview.png"), "PNG")
    print("wrote preview")


if __name__ == "__main__":
    main()
