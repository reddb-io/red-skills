/**
 * React Native adaptation of the vendored reddb.io Tokens, Application Theme,
 * dark Color Scheme, and compact Density stop.
 *
 * Values are checked against vendor/design-system by the adoption test. Keep
 * this file value-only: components own meaning, while the vendored CSS remains
 * the source of truth.
 */
export const colors = {
  background: "#12141b",
  surface: "#12141b",
  surfaceRaised: "#1e222d",
  surfaceSunken: "#07080a",
  border: "#333949",
  borderStrong: "#4a5162",
  foreground: "#f4f5f7",
  muted: "#b3b8c4",
  mutedStrong: "#8b91a1",
  primary: "#ff2056",
  primaryPressed: "#d11a46",
  onPrimary: "#07080a",
  danger: "#ff6389",
} as const;

export const spacing = {
  hairline: 1,
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  huge: 40,
} as const;

export const density = {
  controlHeightSm: 22,
  controlHeightMd: 28,
  controlHeightLg: 36,
  gapSm: 3,
  gapMd: 6,
  gapLg: 10,
  insetSm: 10,
  insetMd: 14,
  insetLg: 22,
} as const;

export const radii = {
  sm: 2,
  md: 6,
  lg: 8,
  xl: 12,
  full: 9_999,
} as const;

export const type = {
  family: {
    sans: "SpaceGrotesk",
    mono: "JetBrainsMono",
  },
  size: {
    xs: 12,
    sm: 14,
    base: 16,
    lg: 18,
    xl: 20,
    xxl: 24,
    display: 30,
  },
  weight: {
    regular: "400" as const,
    medium: "500" as const,
    bold: "700" as const,
  },
} as const;
