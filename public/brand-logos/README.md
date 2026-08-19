# Brand logos (optional)

`BrandMark` (src/components/ui/brand-mark.tsx) renders `<slug>.svg` from this
folder for every slug listed in `manifest.json`, and a coloured monogram for
everything else. Nothing breaks while the folder is empty, so logos can be
added a few at a time.

## Adding one — two steps, both required

1. Drop the file in as `<slug>.svg`.
2. Add `"<slug>"` to the array in `manifest.json`.

The manifest is not decoration and it is not generated. Without it the
component would have to probe for each file and take a 404 when it is missing,
which — with ~400 makes in the picker — meant 400+ failed requests in the
console on every deployment that had not added logos yet. The manifest is one
request that answers for all of them.

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
