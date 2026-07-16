from __future__ import annotations

import base64
import json
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

PROJECT_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_PATH = PROJECT_ROOT / 'server-assets' / 'glyph-masks.json'
MASK_WIDTH = 86
MASK_HEIGHT = 104
SUPERSAMPLE = 4
CHARACTER_SET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
FONT_PATHS = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'
]
ROTATIONS = [-10, -5, 0, 5, 10]
SAFE_DECOY_KINDS = [
    'star',
    'triangle_dot',
    'diamond_dot',
    'square_dot',
    'dot_cluster',
    'hexagon_dot',
    'heart',
    'double_triangle'
]


def encode_alpha(alpha: bytes) -> str:
    return base64.b64encode(alpha).decode('ascii')


def fit_font(font_path: str, character: str) -> ImageFont.FreeTypeFont:
    font_size = 92 * SUPERSAMPLE

    while font_size >= 60 * SUPERSAMPLE:
        font = ImageFont.truetype(font_path, font_size)
        bounds = font.getbbox(character)
        width = bounds[2] - bounds[0]
        height = bounds[3] - bounds[1]

        if width <= (MASK_WIDTH - 12) * SUPERSAMPLE and height <= (MASK_HEIGHT - 12) * SUPERSAMPLE:
            return font

        font_size -= 2 * SUPERSAMPLE

    return ImageFont.truetype(font_path, font_size)


def render_character(character: str, font_path: str, rotation: int) -> bytes:
    width = MASK_WIDTH * SUPERSAMPLE
    height = MASK_HEIGHT * SUPERSAMPLE
    image = Image.new('L', (width, height), 0)
    draw = ImageDraw.Draw(image)
    font = fit_font(font_path, character)
    bounds = draw.textbbox((0, 0), character, font=font)
    text_width = bounds[2] - bounds[0]
    text_height = bounds[3] - bounds[1]
    x = (width - text_width) / 2 - bounds[0]
    y = (height - text_height) / 2 - bounds[1]
    draw.text((x, y), character, fill=255, font=font)

    if rotation != 0:
        image = image.rotate(rotation, resample=Image.Resampling.BICUBIC, expand=False, fillcolor=0)

    image = image.filter(ImageFilter.GaussianBlur(0.25 * SUPERSAMPLE))
    image = image.resize((MASK_WIDTH, MASK_HEIGHT), Image.Resampling.LANCZOS)
    return image.tobytes()


def polygon_points(center_x: float, center_y: float, radius: float, sides: int, phase: float) -> list[tuple[float, float]]:
    return [
        (
            center_x + math.cos(phase + index * math.tau / sides) * radius,
            center_y + math.sin(phase + index * math.tau / sides) * radius
        )
        for index in range(sides)
    ]


def star_points(center_x: float, center_y: float, outer_radius: float, inner_radius: float) -> list[tuple[float, float]]:
    points: list[tuple[float, float]] = []

    for index in range(10):
        radius = outer_radius if index % 2 == 0 else inner_radius
        angle = -math.pi / 2 + index * math.pi / 5
        points.append((center_x + math.cos(angle) * radius, center_y + math.sin(angle) * radius))

    return points


def render_decoy(kind: str, seed: int) -> bytes:
    random_source = random.Random(seed)
    width = MASK_WIDTH * SUPERSAMPLE
    height = MASK_HEIGHT * SUPERSAMPLE
    image = Image.new('L', (width, height), 0)
    draw = ImageDraw.Draw(image)
    center_x = width / 2
    center_y = height / 2
    stroke_width = random_source.randint(7, 11) * SUPERSAMPLE
    padding = random_source.randint(14, 19) * SUPERSAMPLE
    radius = min(width, height) / 2 - padding
    fill = 255

    if kind == 'star':
        draw.polygon(star_points(center_x, center_y, radius, radius * 0.44), fill=fill)
    elif kind == 'triangle_dot':
        points = polygon_points(center_x, center_y + 4 * SUPERSAMPLE, radius, 3, -math.pi / 2)
        draw.line(points + [points[0]], fill=fill, width=stroke_width, joint='curve')
        dot_radius = 6 * SUPERSAMPLE
        draw.ellipse((center_x - dot_radius, center_y - dot_radius, center_x + dot_radius, center_y + dot_radius), fill=fill)
    elif kind == 'diamond_dot':
        points = polygon_points(center_x, center_y, radius, 4, math.pi / 4)
        draw.line(points + [points[0]], fill=fill, width=stroke_width, joint='curve')
        dot_radius = 6 * SUPERSAMPLE
        draw.ellipse((center_x - dot_radius, center_y - dot_radius, center_x + dot_radius, center_y + dot_radius), fill=fill)
    elif kind == 'square_dot':
        inset = padding + 2 * SUPERSAMPLE
        draw.rounded_rectangle((inset, inset, width - inset, height - inset), radius=8 * SUPERSAMPLE, outline=fill, width=stroke_width)
        dot_radius = 6 * SUPERSAMPLE
        draw.ellipse((center_x - dot_radius, center_y - dot_radius, center_x + dot_radius, center_y + dot_radius), fill=fill)
    elif kind == 'dot_cluster':
        dot_radius = random_source.randint(6, 9) * SUPERSAMPLE
        for angle in [0, math.tau / 3, 2 * math.tau / 3]:
            x = center_x + math.cos(angle) * radius * 0.62
            y = center_y + math.sin(angle) * radius * 0.62
            draw.ellipse((x - dot_radius, y - dot_radius, x + dot_radius, y + dot_radius), fill=fill)
        draw.ellipse((center_x - dot_radius, center_y - dot_radius, center_x + dot_radius, center_y + dot_radius), fill=fill)
    elif kind == 'hexagon_dot':
        points = polygon_points(center_x, center_y, radius, 6, math.pi / 6)
        draw.line(points + [points[0]], fill=fill, width=stroke_width, joint='curve')
        dot_radius = 6 * SUPERSAMPLE
        draw.ellipse((center_x - dot_radius, center_y - dot_radius, center_x + dot_radius, center_y + dot_radius), fill=fill)
    elif kind == 'heart':
        heart_points: list[tuple[float, float]] = []
        scale = radius / 18
        for step in range(180):
            t = math.tau * step / 179
            x = 16 * math.sin(t) ** 3
            y = 13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)
            heart_points.append((center_x + x * scale, center_y - y * scale * 0.9))
        draw.polygon(heart_points, fill=fill)
    elif kind == 'double_triangle':
        outer = polygon_points(center_x, center_y + 3 * SUPERSAMPLE, radius, 3, -math.pi / 2)
        inner = polygon_points(center_x, center_y + 3 * SUPERSAMPLE, radius * 0.48, 3, -math.pi / 2)
        draw.line(outer + [outer[0]], fill=fill, width=stroke_width, joint='curve')
        draw.line(inner + [inner[0]], fill=fill, width=max(4 * SUPERSAMPLE, stroke_width // 2), joint='curve')
    else:
        raise ValueError(f'Unsupported decoy kind: {kind}')

    rotation = random_source.choice([-14, -9, -5, 0, 5, 9, 14])
    image = image.rotate(rotation, resample=Image.Resampling.BICUBIC, expand=False, fillcolor=0)
    image = image.filter(ImageFilter.GaussianBlur(0.25 * SUPERSAMPLE))
    image = image.resize((MASK_WIDTH, MASK_HEIGHT), Image.Resampling.LANCZOS)
    return image.tobytes()


def main() -> None:
    character_masks: dict[str, list[str]] = {}

    for character in CHARACTER_SET:
        character_masks[character] = [
            encode_alpha(render_character(character, font_path, rotation))
            for font_path in FONT_PATHS
            for rotation in ROTATIONS
        ]

    decoy_masks = [
        encode_alpha(render_decoy(SAFE_DECOY_KINDS[index % len(SAFE_DECOY_KINDS)], 1000 + index))
        for index in range(48)
    ]

    payload = {
        'width': MASK_WIDTH,
        'height': MASK_HEIGHT,
        'characters': character_masks,
        'decoys': decoy_masks,
        'characterSet': CHARACTER_SET,
        'variantCount': len(FONT_PATHS) * len(ROTATIONS)
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(payload, separators=(',', ':')), encoding='utf-8')
    print(f'Wrote {OUTPUT_PATH} ({OUTPUT_PATH.stat().st_size} bytes)')


if __name__ == '__main__':
    main()
