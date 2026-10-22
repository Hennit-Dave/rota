# App icon and splash assets

Final art from Figma (added 2026-10-22). Icons and splash images are compiled into the native build, so changing them needs a rebuild.

| File | Exact size | Rules |
|---|---|---|
| `icon.png` | 1024 x 1024 px | Exactly square, fills the whole square, no rounded corners, no transparent pixels |
| `adaptive-icon.png` | 1024 x 1024 px, transparent background | The foreground layer. Logo centred, at most about 626 px and at least about 455 px across (66 dp / 48 dp of the 108 dp layer). Keep the outer 171 px clear. No baked-in shadow or mask. Background colour is `palette.teal` in `app.config.ts` |
| `adaptive-icon-monochrome.png` | 1024 x 1024 px, transparent background | Same size and safe zone as the foreground. Android 13+ themed icons tint its shape and read only the alpha channel, so its colour does not matter |
| `splash-icon.png` | 1024 x 1024 px, transparent background | Shown 200 dp wide on a `palette.teal` background (light and dark alike). Keep the mark inside the central two-thirds |
| `notification-icon.png` | 96 x 96 px | All white on transparent. Android draws it as a silhouette; the colour is set in `app.config.ts` |

Sources: Expo documentation (app icons, splash screen, notifications) and Google's adaptive icon guidance, read 2026-10-21.
Details and what is not verified: `docs/decisions/0011-first-native-build-sdk-and-dependencies.md`.
