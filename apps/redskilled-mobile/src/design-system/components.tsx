import type { PropsWithChildren, ReactNode } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type PressableProps,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from "react-native";

import { colors, density, radii, spacing, type } from "./tokens";

export function BrandMark({ size = 48 }: { size?: number }) {
  return (
    <Image
      accessibilityIgnoresInvertColors
      accessibilityLabel="RedDB"
      source={require("../../vendor/design-system/platform/icon-512.png")}
      style={{ borderRadius: radii.md, height: size, width: size }}
    />
  );
}

export function Card({
  children,
  style,
}: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionHeading({
  actions,
  description,
  eyebrow,
  title,
}: {
  actions?: ReactNode;
  description?: string;
  eyebrow: string;
  title?: string;
}) {
  return (
    <View style={styles.sectionHeading}>
      <View style={styles.sectionHeadingText}>
        <Text style={styles.eyebrow}>{eyebrow}</Text>
        {title == null ? null : <Text style={styles.sectionTitle}>{title}</Text>}
        {description == null ? null : (
          <Text style={styles.description}>{description}</Text>
        )}
      </View>
      {actions == null ? null : <View style={styles.sectionActions}>{actions}</View>}
    </View>
  );
}

export function Pill({ glyph, label }: { glyph?: string; label: string }) {
  return (
    <View style={styles.pill}>
      {glyph == null ? null : <Text style={styles.pillGlyph}>{glyph}</Text>}
      <Text style={styles.pillText}>{label}</Text>
    </View>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost";

export function Button({
  label,
  loading = false,
  tone = "default",
  variant = "primary",
  ...props
}: Omit<PressableProps, "children" | "style"> & {
  label: string;
  loading?: boolean;
  tone?: "default" | "danger";
  variant?: ButtonVariant;
}) {
  const disabled = props.disabled === true || loading;
  const contentColor = variant === "primary"
    ? colors.onPrimary
    : tone === "danger" ? colors.danger : colors.foreground;

  return (
    <Pressable
      {...props}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        variant === "primary" && styles.buttonPrimary,
        variant === "secondary" && styles.buttonSecondary,
        variant === "ghost" && styles.buttonGhost,
        disabled && styles.buttonDisabled,
        pressed && !disabled && styles.buttonPressed,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={contentColor} size="small" />
      ) : (
        <Text style={[styles.buttonText, { color: contentColor }]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function Field({
  invalid = false,
  label,
  ...props
}: TextInputProps & { invalid?: boolean; label: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        {...props}
        accessibilityLabel={props.accessibilityLabel ?? label}
        placeholderTextColor={colors.mutedStrong}
        selectionColor={colors.primary}
        style={[styles.input, invalid && styles.inputInvalid, props.style]}
      />
    </View>
  );
}

export function EmptyState({
  action,
  description,
  glyph,
  title,
}: {
  action?: ReactNode;
  description: string;
  glyph: string;
  title: string;
}) {
  return (
    <View style={styles.emptyState}>
      <View style={styles.emptyGlyphBox}>
        <Text style={styles.emptyGlyph}>{glyph}</Text>
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyDescription}>{description}</Text>
      {action == null ? null : <View style={styles.emptyAction}>{action}</View>}
    </View>
  );
}

export function Feedback({ children }: PropsWithChildren) {
  return (
    <View accessibilityRole="alert" style={styles.feedback}>
      <Text style={styles.feedbackGlyph}>!</Text>
      <Text style={styles.feedbackText}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderRadius: radii.lg,
    borderWidth: spacing.hairline,
    gap: density.gapLg,
    padding: density.insetMd,
  },
  sectionHeading: {
    alignItems: "flex-end",
    borderBottomColor: colors.border,
    borderBottomWidth: spacing.hairline,
    flexDirection: "row",
    gap: density.gapLg,
    justifyContent: "space-between",
    paddingBottom: density.insetSm,
  },
  sectionHeadingText: { flex: 1, gap: density.gapSm },
  sectionActions: { alignItems: "center", flexDirection: "row", gap: density.gapMd },
  eyebrow: {
    color: colors.muted,
    fontFamily: type.family.mono,
    fontSize: type.size.xs,
    fontWeight: type.weight.bold,
    letterSpacing: 1.4,
  },
  sectionTitle: {
    color: colors.foreground,
    fontFamily: type.family.sans,
    fontSize: type.size.lg,
    fontWeight: type.weight.medium,
    letterSpacing: -0.36,
  },
  description: {
    color: colors.muted,
    fontFamily: type.family.sans,
    fontSize: type.size.sm,
    lineHeight: 21,
  },
  pill: {
    alignItems: "center",
    alignSelf: "flex-start",
    borderColor: colors.borderStrong,
    borderRadius: radii.full,
    borderWidth: spacing.hairline,
    flexDirection: "row",
    gap: density.gapMd,
    minHeight: density.controlHeightMd,
    paddingHorizontal: density.insetSm,
  },
  pillGlyph: {
    color: colors.foreground,
    fontFamily: type.family.mono,
    fontSize: type.size.xs,
  },
  pillText: {
    color: colors.foreground,
    fontFamily: type.family.mono,
    fontSize: 10,
    fontWeight: type.weight.bold,
    letterSpacing: 1,
  },
  button: {
    alignItems: "center",
    borderColor: "transparent",
    borderRadius: radii.md,
    borderWidth: spacing.hairline,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: density.insetMd,
  },
  buttonPrimary: { backgroundColor: colors.primary },
  buttonSecondary: { backgroundColor: "transparent", borderColor: colors.borderStrong },
  buttonGhost: { alignSelf: "flex-start", backgroundColor: "transparent", minHeight: 36 },
  buttonDisabled: { opacity: 0.5 },
  buttonPressed: { opacity: 0.82 },
  buttonText: {
    fontFamily: type.family.sans,
    fontSize: type.size.sm,
    fontWeight: type.weight.bold,
    letterSpacing: 0.8,
  },
  field: { gap: density.gapMd },
  fieldLabel: {
    color: colors.foreground,
    fontFamily: type.family.sans,
    fontSize: type.size.sm,
    fontWeight: type.weight.medium,
  },
  input: {
    backgroundColor: colors.surfaceSunken,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    borderWidth: spacing.hairline,
    color: colors.foreground,
    fontFamily: type.family.mono,
    fontSize: type.size.sm,
    minHeight: 52,
    paddingHorizontal: density.insetSm,
    paddingVertical: density.gapLg,
  },
  inputInvalid: { borderColor: colors.danger },
  emptyState: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: radii.lg,
    borderStyle: "dashed",
    borderWidth: spacing.hairline,
    gap: density.gapLg,
    paddingHorizontal: density.insetLg,
    paddingVertical: spacing.huge,
  },
  emptyGlyphBox: {
    alignItems: "center",
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    borderWidth: spacing.hairline,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  emptyGlyph: {
    color: colors.muted,
    fontFamily: type.family.mono,
    fontSize: type.size.lg,
  },
  emptyTitle: {
    color: colors.foreground,
    fontFamily: type.family.sans,
    fontSize: type.size.base,
    fontWeight: type.weight.medium,
    textAlign: "center",
  },
  emptyDescription: {
    color: colors.muted,
    fontFamily: type.family.sans,
    fontSize: type.size.sm,
    lineHeight: 21,
    maxWidth: 320,
    textAlign: "center",
  },
  emptyAction: { alignSelf: "stretch", paddingTop: density.gapSm },
  feedback: {
    alignItems: "flex-start",
    backgroundColor: colors.surface,
    borderColor: colors.danger,
    borderRadius: radii.md,
    borderWidth: spacing.hairline,
    flexDirection: "row",
    gap: density.gapMd,
    padding: density.insetSm,
  },
  feedbackGlyph: {
    color: colors.danger,
    fontFamily: type.family.mono,
    fontSize: type.size.sm,
    fontWeight: type.weight.bold,
  },
  feedbackText: {
    color: colors.foreground,
    flex: 1,
    fontFamily: type.family.sans,
    fontSize: type.size.sm,
    lineHeight: 20,
  },
});
