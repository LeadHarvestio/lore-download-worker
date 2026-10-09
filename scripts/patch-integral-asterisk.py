"""Repair censored asterisks and apostrophes in the supplied Integral CF fonts.

Requires fontTools. The polygon follows the user's 950x840 raster reference.
Keep originals as input: the replacement is intentionally an idempotent asset
generation step, not a change to font names or unrelated demo characters.
"""
import argparse
from pathlib import Path

from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.transformPen import TransformPen
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
    apostrophe = font.getBestCmap()[ord("'")]
    comma = font.getBestCmap()[ord(",")]
    original_outlines = outlines(font)
    original_metrics = dict(font["hmtx"].metrics)
    original_names = font["name"].compile(font)
    original_cmap = dict(font.getBestCmap())
    cap_height = font["OS/2"].sCapHeight
    # Keep the original advance and sidebearings. The supplied star is an inline
    # replacement mark, not a full-cap-height letter with a 950-unit advance.
    width, bearing = original_metrics[name]
    scale = (width - 2 * bearing) / (894 - 56)
    bottom = (cap_height - 840 * scale) / 2
    points = [(round(bearing + (x - 56) * scale), round(bottom + (840 - y) * scale)) for x, y in POINTS]
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
    glyphs = font.getGlyphSet()
    bounds = BoundsPen(glyphs)
    glyphs[comma].draw(bounds)
    comma_top = bounds.bounds[3]
    quote_width, quote_bearing = original_metrics[comma]
    quote_pen = T2CharStringPen(quote_width, glyphs)
    glyphs[comma].draw(TransformPen(quote_pen, (1, 0, 0, 1, 0, cap_height - comma_top)))
    previous_quote = char_strings[apostrophe]
    char_strings[apostrophe] = quote_pen.getCharString(
        private=previous_quote.private, globalSubrs=previous_quote.globalSubrs
    )
    font["hmtx"].metrics[apostrophe] = (quote_width, quote_bearing)
    for table in font["cmap"].tables:
        if table.isUnicode():
            table.cmap[0x2018] = apostrophe
            table.cmap[0x2019] = apostrophe
    destination.parent.mkdir(parents=True, exist_ok=True)
    font.save(destination)
    verified = TTFont(destination, recalcTimestamp=False)
    actual = outlines(verified)
    assert actual[name] != original_outlines[name], "Original demo glyph was not replaced"
    for other in original_outlines:
        if other not in {name, apostrophe}:
            assert actual[other] == original_outlines[other], f"Changed unrelated glyph {other}"
            assert verified["hmtx"][other] == original_metrics[other]
    assert verified["name"].compile(verified) == original_names, "Font identities changed"
    assert all(verified.getBestCmap()[code] == glyph for code, glyph in original_cmap.items()), "Existing character mappings changed"
    assert verified.getBestCmap()[0x2019] == apostrophe
    assert verified["hmtx"][name] == (width, min(x for x, _ in points))
    assert actual[apostrophe] != original_outlines[apostrophe]
    print(f"{source.name}: compact star and raised-comma apostrophe; preserved {len(actual) - 2} other glyphs")


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
