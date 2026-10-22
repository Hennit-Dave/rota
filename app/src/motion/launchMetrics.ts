import { MARK_UNITS } from './swapTimelines';

/**
 * The launch animation has to start exactly where the native splash screen stops, or the mark visibly jumps on every
 * launch. Figma's launch frame is 180 x 120 (Motion 261:73), but the native splash shows the mark at
 * 504 / 1024 of `imageWidth` (assets/splash-icon.png: the mark is 504 px wide on a 1024 px canvas, shown 200 dp wide), which is
 * about 98 dp. Making the native mark bigger needs a native rebuild and Android 12+ would crop it, so the animation is scaled
 * down to match the native mark instead (a deviation from the spec size, agreed in the plan). A test pins both numbers to
 * app.config.ts and the splash image.
 */
export const SPLASH_IMAGE_WIDTH_DP = 200; // app.config.ts: expo-splash-screen imageWidth
export const SPLASH_CANVAS_PX = 1024; // assets/splash-icon.png
export const SPLASH_MARK_PX = 504; // the mark's width inside that canvas (measured from the PNG's opaque pixels)

export const NATIVE_SPLASH_MARK_WIDTH_DP = (SPLASH_MARK_PX / SPLASH_CANVAS_PX) * SPLASH_IMAGE_WIDTH_DP;

/** The scale for the launch variant: the mark is 144 units wide, so this makes it as wide as the native splash mark. */
export const LAUNCH_SCALE = NATIVE_SPLASH_MARK_WIDTH_DP / MARK_UNITS.width;
