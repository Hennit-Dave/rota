import raw from './palette.json';

/**
 * Mirrors the Figma collection "Rota / Primitives" (variables named palette/*). The values live in palette.json,
 * which app.config.ts can also load, so the only raw hex values in the project are in that one file. Everything
 * else reads a semantic colour from ./colors, which aliases these exactly as Figma's "Rota / Colour" collection does.
 */
export const palette: Readonly<Record<keyof typeof raw, string>> = raw;
