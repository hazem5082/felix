# Brand logos (optional)

`BrandMark` (src/components/ui/brand-mark.tsx) looks for `<slug>.svg` in this
folder and falls back to a coloured monogram when the file is absent. Nothing
breaks while the folder is empty, so logos can be added a few at a time.

The slug is the make name lowercased with every run of non-alphanumeric
characters collapsed to a single `-`:

    Toyota          -> toyota.svg
    Mercedes-Benz   -> mercedes-benz.svg
    Land Rover      -> land-rover.svg
    BMW             -> bmw.svg

Square artwork, ideally SVG, transparent background. They render as small as
15px in the inventory grid, so heavily detailed marks will not read — use the
roundel/emblem rather than a full wordmark where a marque has both.

## Before you add any

These are registered trademarks. Manufacturer press/media kits normally permit
depicting a marque to identify a vehicle you are actually selling, but the
terms differ per brand and per territory, and none of them is a blanket
licence. Whoever operates the showroom should confirm they hold the right to
display each mark before dropping the file in. That decision is deliberately
left outside the codebase, which is why nothing here hot-links a logo CDN.
