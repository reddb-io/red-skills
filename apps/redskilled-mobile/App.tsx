import { useFonts } from "expo-font";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { pairRedskilledHost } from "@reddb-io/red-skills-link-protocol/mobile-client";
import type { RedskilledLinkPairedHost } from "@reddb-io/red-skills-link-protocol/protocol";

import {
  BrandMark,
  Button,
  Card,
  EmptyState,
  Feedback,
  Field,
  Pill,
  SectionHeading,
} from "./src/design-system/components";
import { colors, density, radii, spacing, type } from "./src/design-system/tokens";
import { parseGitHubIssueUrl } from "./src/domain/issue-url";
import type { MobileWorker, PairedHost } from "./src/domain/ticket-dispatch";
import { loadPairedHost, savePairedHost } from "./src/transport/paired-host-store";
import { createRemoteOperatorGateway } from "./src/transport/remote-operator-gateway";
import { copy } from "./src/ui/copy";

export default function App() {
  const [fontsLoaded, fontError] = useFonts({
    JetBrainsMono: require("./vendor/design-system/fonts/jetbrains-mono-variable.ttf"),
    SpaceGrotesk: require("./vendor/design-system/fonts/space-grotesk-variable.ttf"),
  });
  const [pairedHost, setPairedHost] = useState<RedskilledLinkPairedHost | null>(null);
  const [pairingCode, setPairingCode] = useState("");
  const [isPairing, setIsPairing] = useState(false);
  const [issueUrl, setIssueUrl] = useState("");
  const [isDispatching, setIsDispatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workers, setWorkers] = useState<MobileWorker[]>([]);
  const gateway = useMemo(
    () => pairedHost == null ? null : createRemoteOperatorGateway(pairedHost),
    [pairedHost],
  );

  useEffect(() => {
    let active = true;
    void loadPairedHost().then((host) => {
      if (active) setPairedHost(host);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (gateway == null) return;
    let active = true;
    const refresh = () => void gateway.state().then((state) => {
      if (active) setWorkers([...state]);
    }).catch(() => undefined);
    refresh();
    const timer = setInterval(refresh, 3_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [gateway]);

  const issue = useMemo(() => {
    try {
      return parseGitHubIssueUrl(issueUrl);
    } catch {
      return null;
    }
  }, [issueUrl]);

  const selectedHost: PairedHost | null = pairedHost == null ? null : {
    id: pairedHost.host_id,
    name: pairedHost.host_name,
    status: "online",
  };
  const canDispatch = selectedHost != null && issue != null && !isDispatching;

  async function dispatchIssue() {
    if (selectedHost == null || issue == null || gateway == null) return;

    setIsDispatching(true);
    setError(null);
    try {
      const receipt = await gateway.dispatch({
        hostId: selectedHost.id,
        issueUrl: issue.canonicalUrl,
      });
      setWorkers((current) => [{
        workerId: receipt.workerId,
        repository: receipt.repository,
        ticket: receipt.ticket,
        startedAt: new Date().toISOString(),
      }, ...current.filter((worker) => worker.workerId !== receipt.workerId)]);
      setIssueUrl("");
    } catch {
      setError(copy.errors.dispatch);
    } finally {
      setIsDispatching(false);
    }
  }

  async function pairHost() {
    if (pairingCode.trim() === "") return;
    setIsPairing(true);
    setError(null);
    try {
      const host = await pairRedskilledHost(pairingCode, `Redskilled ${Platform.OS}`);
      await savePairedHost(host);
      setPairedHost(host);
      setPairingCode("");
    } catch {
      setError(copy.errors.pairing);
    } finally {
      setIsPairing(false);
    }
  }

  async function stopWorker(workerId: string) {
    if (gateway == null) return;
    setError(null);
    try {
      if (await gateway.stop(workerId)) {
        setWorkers((current) => current.filter((worker) => worker.workerId !== workerId));
      }
    } catch {
      setError(copy.errors.stop);
    }
  }

  if (!fontsLoaded && fontError == null) {
    return (
      <SafeAreaView accessibilityLabel={copy.app.loading} style={styles.loadingScreen}>
        <StatusBar style="light" />
        <BrandMark size={56} />
        <ActivityIndicator color={colors.primary} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.safeArea}
      >
        <ScrollView
          contentContainerStyle={styles.page}
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <View style={styles.brandLockup}>
              <BrandMark />
              <View style={styles.brandCopy}>
                <Text style={styles.brandEyebrow}>{copy.app.eyebrow}</Text>
                <Text style={styles.title}>{copy.app.title}</Text>
                <Text style={styles.subtitle}>{copy.app.subtitle}</Text>
              </View>
            </View>
            <Pill label={copy.app.platform} />
          </View>

          <View style={styles.section}>
            <SectionHeading eyebrow={copy.host.section} />
            {selectedHost == null ? (
              <Card>
                <EmptyState
                  description={copy.host.emptyDescription}
                  glyph="+"
                  title={copy.host.emptyTitle}
                />
                <Field
                  autoCapitalize="none"
                  autoCorrect={false}
                  label={copy.host.invitationLabel}
                  onChangeText={setPairingCode}
                  placeholder={copy.host.invitationPlaceholder}
                  value={pairingCode}
                />
                <Button
                  disabled={pairingCode.trim() === ""}
                  label={copy.host.pairAction}
                  loading={isPairing}
                  onPress={() => void pairHost()}
                />
              </Card>
            ) : (
              <Card style={styles.hostCard}>
                <View style={styles.hostIdentity}>
                  <View style={styles.hostGlyph}>
                    <Text style={styles.hostGlyphText}>H</Text>
                  </View>
                  <View style={styles.hostText}>
                    <Text style={styles.hostName}>{selectedHost.name}</Text>
                    <Text style={styles.metadata}>{copy.host.pairedDescription}</Text>
                  </View>
                </View>
                <Pill glyph="◆" label={copy.host.paired} />
              </Card>
            )}
          </View>

          <View style={styles.section}>
            <SectionHeading
              description={copy.dispatch.description}
              eyebrow={copy.dispatch.section}
              title={copy.dispatch.title}
            />
            <Card>
              <Field
                autoCapitalize="none"
                autoCorrect={false}
                invalid={issueUrl.length > 0 && issue == null}
                keyboardType="url"
                label={copy.dispatch.issueLabel}
                onChangeText={(value) => {
                  setIssueUrl(value);
                  setError(null);
                }}
                onSubmitEditing={() => {
                  if (canDispatch) void dispatchIssue();
                }}
                placeholder={copy.dispatch.issuePlaceholder}
                returnKeyType="go"
                value={issueUrl}
              />
              {issueUrl.length > 0 && issue == null ? (
                <View style={styles.validationRow}>
                  <Text style={styles.validationGlyph}>!</Text>
                  <Text style={styles.validationText}>{copy.dispatch.invalidIssue}</Text>
                </View>
              ) : null}
              {issue != null ? (
                <View style={styles.issuePreview}>
                  <Text numberOfLines={1} style={styles.issueRepository}>
                    {issue.owner}/{issue.repository}
                  </Text>
                  <Text style={styles.issueNumber}>#{issue.ticket}</Text>
                </View>
              ) : null}
              {error == null ? null : <Feedback>{error}</Feedback>}
              <Button
                disabled={!canDispatch}
                label={copy.dispatch.action}
                loading={isDispatching}
                onPress={() => void dispatchIssue()}
              />
            </Card>
          </View>

          <View style={styles.section}>
            <SectionHeading
              actions={<Pill label={copy.workers.count(workers.length)} />}
              eyebrow={copy.workers.section}
            />
            {workers.length === 0 ? (
              <EmptyState
                description={copy.workers.emptyDescription}
                glyph="○"
                title={copy.workers.emptyTitle}
              />
            ) : (
              <Card style={styles.workerList}>
                {workers.map((worker, index) => (
                  <View
                    key={worker.workerId}
                    style={[styles.workerRow, index > 0 && styles.workerRowBorder]}
                  >
                    <View style={styles.workerGlyph}>
                      <Text style={styles.workerGlyphText}>▶</Text>
                    </View>
                    <View style={styles.workerBody}>
                      <Text numberOfLines={1} style={styles.workerTitle}>
                        {worker.repository}{worker.ticket == null ? "" : ` #${worker.ticket}`}
                      </Text>
                      <Text numberOfLines={1} style={styles.workerId}>{worker.workerId}</Text>
                      <Text style={styles.runningText}>{copy.workers.running}</Text>
                    </View>
                    <Button
                      label={copy.workers.stop}
                      onPress={() => void stopWorker(worker.workerId)}
                      tone="danger"
                      variant="ghost"
                    />
                  </View>
                ))}
              </Card>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: colors.background, flex: 1 },
  loadingScreen: {
    alignItems: "center",
    backgroundColor: colors.background,
    flex: 1,
    gap: spacing.xl,
    justifyContent: "center",
  },
  page: {
    gap: spacing.xxl,
    paddingBottom: 56,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
  },
  header: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: density.gapLg,
    justifyContent: "space-between",
  },
  brandLockup: { alignItems: "center", flexDirection: "row", flex: 1, gap: density.gapLg },
  brandCopy: { flex: 1 },
  brandEyebrow: {
    color: colors.primary,
    fontFamily: type.family.mono,
    fontSize: 10,
    fontWeight: type.weight.bold,
    letterSpacing: 1.8,
  },
  title: {
    color: colors.foreground,
    fontFamily: type.family.sans,
    fontSize: type.size.display,
    fontWeight: type.weight.bold,
    letterSpacing: -0.6,
    lineHeight: 33,
  },
  subtitle: {
    color: colors.muted,
    fontFamily: type.family.sans,
    fontSize: type.size.sm,
    marginTop: density.gapSm,
  },
  section: { gap: density.gapLg },
  hostCard: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  hostIdentity: { alignItems: "center", flex: 1, flexDirection: "row", gap: density.gapLg },
  hostGlyph: {
    alignItems: "center",
    backgroundColor: colors.surfaceSunken,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    borderWidth: spacing.hairline,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  hostGlyphText: {
    color: colors.foreground,
    fontFamily: type.family.mono,
    fontSize: type.size.base,
    fontWeight: type.weight.bold,
  },
  hostText: { flex: 1 },
  hostName: {
    color: colors.foreground,
    fontFamily: type.family.sans,
    fontSize: type.size.base,
    fontWeight: type.weight.medium,
  },
  metadata: {
    color: colors.muted,
    fontFamily: type.family.sans,
    fontSize: type.size.xs,
    marginTop: density.gapSm,
  },
  validationRow: { alignItems: "flex-start", flexDirection: "row", gap: density.gapMd },
  validationGlyph: {
    color: colors.danger,
    fontFamily: type.family.mono,
    fontSize: type.size.xs,
    fontWeight: type.weight.bold,
  },
  validationText: {
    color: colors.foreground,
    flex: 1,
    fontFamily: type.family.sans,
    fontSize: type.size.xs,
    lineHeight: 18,
  },
  issuePreview: {
    alignItems: "center",
    backgroundColor: colors.surfaceSunken,
    borderColor: colors.border,
    borderRadius: radii.md,
    borderWidth: spacing.hairline,
    flexDirection: "row",
    gap: density.gapLg,
    justifyContent: "space-between",
    padding: density.insetSm,
  },
  issueRepository: {
    color: colors.foreground,
    flex: 1,
    fontFamily: type.family.mono,
    fontSize: type.size.xs,
  },
  issueNumber: {
    color: colors.primary,
    fontFamily: type.family.mono,
    fontSize: type.size.sm,
    fontWeight: type.weight.bold,
  },
  workerList: { gap: 0, padding: 0 },
  workerRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: density.gapLg,
    minHeight: 76,
    paddingHorizontal: density.insetMd,
    paddingVertical: density.insetSm,
  },
  workerRowBorder: { borderTopColor: colors.border, borderTopWidth: spacing.hairline },
  workerGlyph: {
    alignItems: "center",
    height: density.controlHeightMd,
    justifyContent: "center",
    width: density.controlHeightMd,
  },
  workerGlyphText: {
    color: colors.foreground,
    fontFamily: type.family.mono,
    fontSize: type.size.xs,
  },
  workerBody: { flex: 1 },
  workerTitle: {
    color: colors.foreground,
    fontFamily: type.family.sans,
    fontSize: type.size.sm,
    fontWeight: type.weight.medium,
  },
  workerId: {
    color: colors.muted,
    fontFamily: type.family.mono,
    fontSize: 10,
    marginTop: density.gapSm,
  },
  runningText: {
    color: colors.muted,
    fontFamily: type.family.mono,
    fontSize: 9,
    fontWeight: type.weight.bold,
    letterSpacing: 1,
    marginTop: density.gapSm,
  },
});
