/** Mirrors the Figma collection "Rota / Dimensions" (space/*, radius/*, size/touch). */
export const space = { 4: 4, 8: 8, 12: 12, 16: 16, 24: 24, 32: 32 } as const;
export const radius = { 12: 12, 20: 20, full: 999 } as const;
/** Minimum touch target (Figma Foundations: "48 px minimum touch targets"). */
export const touchSize = 48;
