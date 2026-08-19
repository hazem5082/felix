# Demo vehicle photography

Master copies of the photographs for the four cars `scripts/seed-demo.mjs`
puts on the demo showroom floor.

**The app never serves this folder.** `scripts/demo-photos.mjs` uploads these
files to R2 under `vehicles/demo/`, and that absolute R2 URL is what goes in
`vehicles.photos` — the same place and the same shape as a photo a real
member of staff uploads through the intake form. The folder exists so the
images have a home in version control, with their provenance and licence
attached, and so the upload is reproducible:

```bash
node --env-file=.env.local scripts/demo-photos.mjs
```

An earlier version of this stored `/demo-vehicles/<file>` and relied on
Next serving `public/`. That is wrong in a way worth recording: it makes the
demo's *content* depend on a *deployment*, and it fails silently — `Cover` in
`inventory-browser.tsx` falls back to a marque monogram when an image 404s,
so the grid reads as "no photos yet" rather than "assets not shipped". R2 has
neither problem, and photographs survive a rebuild.

## Why they are committed rather than hot-linked

Hot-linking Commons would make the demo rot the day someone else re-organises
their files, and — given the silent monogram fallback — nobody would notice
for weeks. Uploading a copy we control removes that dependency.

Sized to 1280px wide, ~250 KB each, ~2.5 MB for the folder. The largest
surface any of them is drawn at is the 4:3 grid tile; there is no lightbox,
so a bigger master would be paid for on every page load and never seen.

## Licence and attribution — read before adding more

All ten are from Wikimedia Commons under **CC BY-SA 4.0**, which requires
attribution and share-alike. That is satisfied for a demo by this file
travelling with the images. If these photos ever move to a page that is
marketed rather than demonstrated, put a visible credit line on it.

| File | Photographer | Source |
| --- | --- | --- |
| `ford-fusion-front.jpg` | Kevauto | [2018 Ford Fusion SE Hybrid, front](https://commons.wikimedia.org/wiki/File:2018_Ford_Fusion_SE_Hybrid,_front_4.4.23.jpg) |
| `ford-fusion-rear.jpg` | Kevauto | [2018 Ford Fusion SE Hybrid, rear](https://commons.wikimedia.org/wiki/File:2018_Ford_Fusion_SE_Hybrid,_rear_4.4.23.jpg) |
| `ford-fusion-interior.jpg` | deathpallie325 | [2018 Ford Fusion SE interior](https://commons.wikimedia.org/wiki/File:2018_Ford_Fusion_SE_interior.jpg) |
| `honda-civic-front.jpg` | Elise240SX | [2023 Honda Civic Sport Sedan, front right](https://commons.wikimedia.org/wiki/File:2023_Honda_Civic_Sport_Sedan_in_Rallye_Red,_front_right,_2024-09-29.jpg) |
| `honda-civic-front-left.jpg` | Elise240SX | [2023 Honda Civic Sport Sedan, front left](https://commons.wikimedia.org/wiki/File:2023_Honda_Civic_Sport_Sedan_in_Rallye_Red,_Front_Left,_04-07-2023.jpg) |
| `toyota-camry-front.jpg` | Elise240SX | [2023 Toyota Camry XSE AWD, front right](https://commons.wikimedia.org/wiki/File:2023_Toyota_Camry_XSE_AWD_in_Cavalry_Blue,_front_right,_2026-05-03.jpg) |
| `toyota-camry-rear.jpg` | Elise240SX | [2023 Toyota Camry XSE AWD, rear right](https://commons.wikimedia.org/wiki/File:2023_Toyota_Camry_XSE_AWD_in_Cavalry_Blue,_rear_right,_2026-05-03.jpg) |
| `bmw-3-series-front.jpg` | Elise240SX | [2020 BMW 330i xDrive, front right](https://commons.wikimedia.org/wiki/File:2020_BMW_330i_xDrive_in_Mineral_White,_Front_Right,_07-19-2022.jpg) |
| `bmw-3-series-rear.jpg` | Elise240SX | [2020 BMW 330i xDrive, rear right](https://commons.wikimedia.org/wiki/File:2020_BMW_330i_xDrive_in_Mineral_White,_Rear_Right,_07-19-2022.jpg) |
| `bmw-3-series-boot.jpg` | Bindydad123 | [2019 BMW 330i M Sport (48)](https://commons.wikimedia.org/wiki/File:2019_BMW_330i_M_Sport_(48).jpg) |

Every licence is <https://creativecommons.org/licenses/by-sa/4.0>.

## The cars are close, not exact

Commons has no photograph of the specific car the seed describes, because
there is no such car — the VINs are invented. Each image is the right marque
and the right generation, which is what the grid is showing off:

* **2022 Ford Fusion SE** — photographed car is a 2018 SE *Hybrid*
  (same facelift; a `Hybrid` badge is visible on the fender). Ford stopped
  building the Fusion after 2020, so a 2022 could not be photographed.
* **2023 Honda Civic Sport** — exact: an 11th-generation Civic Sport sedan.
* **2024 Toyota Camry XSE** — photographed car is a 2023 XSE AWD, the same
  XV70 facelift. The XV80 that replaced it for 2025 looks nothing like it.
* **2023 BMW 3 Series 330i** — photographed car is a 2020 330i xDrive,
  pre-LCI G20. The 2023 LCI restyled the headlights and the iDrive screen.

The two `bmw-3-series-boot.jpg` / `ford-fusion-interior.jpg` shots are seeded
into `inspection_photos`, not `photos` — that column is the intake condition
report, and the distinction is deliberate (see migration 0015). The other two
cars are seeded with no inspection photos at all, which is both realistic and
the only way to see the empty state on the vehicle detail page.
