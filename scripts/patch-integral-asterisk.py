"""Replace only U+002A in the supplied Integral CF CFF fonts.

Requires fontTools. The polygon follows the user's 950x840 raster reference.
Keep originals as input: the replacement is intentionally an idempotent asset
generation step, not a change to font names or unrelated demo characters.
"""
import argparse
from pathlib import Path

from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.ttLib import TTFont

POINTS = [
    (365, 0), (585, 0), (585, 230), (784, 115), (894, 305),
    (696, 420), (894, 535), (784, 725), (585, 610), (585, 840),
    (365, 840), (365, 610), (166, 725), (56, 535), (254, 420),
    (56, 305), (166, 115), (365, 230),
]


def outlines(font):
    glyphs = font.getGlyphSet()
    result = {}
    for name in font.getGlyphOrder():
        pen = RecordingPen()
        glyphs[name].draw(pen)
        result[name] = pen.value
    return result


def patch(source, destination):
    font = TTFont(source, recalcTimestamp=False)
    if "CFF " not in font:
        raise ValueError(f"{source}: expected an OpenType CFF font")
    name = font.getBestCmap()[ord("*")]
    original_outlines = outlines(font)
    original_metrics = dict(font["hmtx"].metrics)
    original_names = font["name"].compile(font)
    original_cmap = font["cmap"].compile(font)
    cap_height = font["OS/2"].sCapHeight
    scale = cap_height / 840
    width = round(950 * scale)
    points = [(round(x * scale), round((840 - y) * scale)) for x, y in POINTS]
    char_strings = font["CFF "].cff.topDictIndex[0].CharStrings
    previous = char_strings[name]
    pen = T2CharStringPen(width, font.getGlyphSet())
    pen.moveTo(points[0])
    for point in points[1:]:
        pen.lineTo(point)
    pen.closePath()
    char_strings[name] = pen.getCharString(
        private=previous.private, globalSubrs=previous.globalSubrs
    )
    font["hmtx"].metrics[name] = (width, min(x for x, _ in points))
    destination.parent.mkdir(parents=True, exist_ok=True)
    font.save(destination)
    verified = TTFont(destination, recalcTimestamp=False)
    actual = outlines(verified)
    assert actual[name] != original_outlines[name], "Original demo glyph was not replaced"
    for other in original_outlines:
        if other != name:
            assert actual[other] == original_outlines[other], f"Changed unrelated glyph {other}"
            assert verified["hmtx"][other] == original_metrics[other]
    assert verified["name"].compile(verified) == original_names, "Font identities changed"
    assert verified["cmap"].compile(verified) == original_cmap, "Character mappings changed"
    assert verified["hmtx"][name] == (width, min(x for x, _ in points))
    print(f"{source.name}: replaced {name}; preserved all {len(actual) - 1} other glyphs")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Folder containing original IntegralCF-*.otf")
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    fonts = sorted(args.source.glob("IntegralCF-*.otf"))
    if len(fonts) != 6:
        raise ValueError(f"Expected the six supplied Integral CF faces; found {len(fonts)}")
    for source in fonts:
        patch(source, args.destination / source.name)
