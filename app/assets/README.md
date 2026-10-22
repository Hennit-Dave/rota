# Placeholder assets

These four PNGs are generated placeholders (flat shapes in palette colours). They are not brand art. Replace them with the final
art before the first EAS build: icons and splash images are compiled into the native build, so changing them later needs a rebuild.

| File | Exact size | Rules |
|---|---|---|
| `icon.png` | 1024 x 1024 px | Exactly square, fills the whole square, no rounded corners, no transparent pixels |
| `adaptive-icon.png` | 1024 x 1024 px, transparent background | Logo centred, at most about 626 px and at least about 455 px across (66 dp / 48 dp of the 108 dp layer). Keep the outer 171 px clear. No baked-in shadow or mask. Background colour is set in `app.config.ts` |
| `splash-icon.png` | 1024 x 1024 px, transparent background | Shown 200 dp wide. Keep the mark inside the central two-thirds |
| `notification-icon.png` | 96 x 96 px | All white on transparent. Android draws it as a silhouette; the colour is set in `app.config.ts` |

Sources: Expo documentation (app icons, splash screen, notifications) and Google's adaptive icon guidance, read 2026-10-21.
Details and what is not verified: `docs/decisions/0011-first-native-build-sdk-and-dependencies.md`.
