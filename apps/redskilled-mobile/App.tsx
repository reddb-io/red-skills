import { useFonts } from "expo-font";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { deriveHostStatus } from "./src/domain/host-status";
import { parseGitHubIssueUrl } from "./src/domain/issue-url";
import type { MobileHostSnapshot, MobileWorker, PairedHost } from "./src/domain/ticket-dispatch";
import { reconcilePendingWorkers } from "./src/domain/worker-reconcile";
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
  const [scannerOpen, setScannerOpen] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const scanLocked = useRef(false);
  const [issueUrl, setIssueUrl] = useState("");
  const [isDispatching, setIsDispatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workers, setWorkers] = useState<readonly MobileWorker[]>([]);
  const [snapshot, setSnapshot] = useState<MobileHostSnapshot | null>(null);
  const [lastAnsweredAt, setLastAnsweredAt] = useState<number | null>(null);
  const [linkFailure, setLinkFailure] = useState<string | null>(null);
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
    // Every outcome lands in state: an answered read stamps the instant the
    // status verdict derives from, and a failed read records WHY instead of
    // being swallowed — the card then reads stale/unreachable by evidence.
    const refresh = () => void gateway.state().then((read) => {
      if (!active) return;
      setSnapshot(read);
      setLastAnsweredAt(Date.now());
      setLinkFailure(null);
      setWorkers((current) => reconcilePendingWorkers(
        read.workers,
        current.filter((worker) => worker.pending === true),
        Date.now(),
      ));
    }).catch((failure: unknown) => {
      if (!active) return;
      setLinkFailure(failure instanceof Error ? failure.message : String(failure));
    });
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

  const hostStatus = deriveHostStatus(lastAnsweredAt, Date.now());
  const selectedHost: PairedHost | null = pairedHost == null ? null : {
    id: pairedHost.host_id,
    name: pairedHost.host_name,
    status: hostStatus,
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
        pending: true,
      }, ...current.filter((worker) => worker.workerId !== receipt.workerId)]);
      setIssueUrl("");
    } catch {
      setError(copy.errors.dispatch);
    } finally {
      setIsDispatching(false);
    }
  }

  async function pairHost(invitation: string) {
    if (invitation.trim() === "") return;
    setIsPairing(true);
    setError(null);
    try {
      const host = await pairRedskilledHost(invitation, `Redskilled ${Platform.OS}`);
      await savePairedHost(host);
      setPairedHost(host);
      setPairingCode("");
    } catch {
      setError(copy.errors.pairing);
    } finally {
      setIsPairing(false);
    }
  }

  async function scanPairingInvitation({ data }: BarcodeScanningResult) {
    if (scanLocked.current) return;
    scanLocked.current = true;
    setPairingCode(data);
    setScannerOpen(false);
    try {
      await pairHost(data);
    } finally {
      scanLocked.current = false;
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
        <BrandMark size={40} />
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
              <BrandMark size={24} />
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
                <Button
                  label={copy.host.scanAction}
                  onPress={() => {
                    scanLocked.current = false;
                    setScannerOpen(true);
                    setError(null);
                  }}
                  variant="secondary"
                />
                {!scannerOpen ? null : cameraPermission == null ? (
                  <View accessibilityLabel={copy.host.cameraLoading} style={styles.cameraLoading}>
                    <ActivityIndicator color={colors.primary} />
                    <Text style={styles.cameraCopy}>{copy.host.cameraLoading}</Text>
                  </View>
                ) : !cameraPermission.granted ? (
                  <View style={styles.cameraPermission}>
                    <Text style={styles.cameraCopy}>{copy.host.cameraPermission}</Text>
                    {cameraPermission.canAskAgain ? (
                      <Button label={copy.host.cameraAllow} onPress={() => void requestCameraPermission()} />
                    ) : (
                      <Feedback>{copy.host.cameraUnavailable}</Feedback>
                    )}
                    <Button label={copy.host.cameraCancel} onPress={() => setScannerOpen(false)} variant="ghost" />
                  </View>
                ) : (
                  <View style={styles.cameraPanel}>
                    <View style={styles.cameraFrame}>
                      <CameraView
                        accessibilityLabel={copy.host.cameraLabel}
                        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                        facing="back"
                        onBarcodeScanned={(result) => void scanPairingInvitation(result)}
                        style={styles.camera}
                      />
                    </View>
                    <Text style={styles.cameraCopy}>{copy.host.cameraHint}</Text>
                    <Button label={copy.host.cameraCancel} onPress={() => setScannerOpen(false)} variant="ghost" />
                  </View>
                )}
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
                  onPress={() => void pairHost(pairingCode)}
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
                    <Text style={styles.metadata}>
                      {snapshot?.daemonVersion == null
                        ? copy.host.pairedDescription
                        : `${copy.host.pairedDescription} · ${copy.host.daemonVersion(snapshot.daemonVersion)}`}
                    </Text>
                    {linkFailure == null || hostStatus === "online" ? null : (
                      <Text style={styles.metadata}>{copy.errors.state(linkFailure)}</Text>
                    )}
                  </View>
                </View>
                <Pill glyph="◆" label={copy.host.status[selectedHost.status]} />
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
                      <Text style={styles.runningText}>
                        {worker.pending === true
                          ? copy.workers.pending
                          : [
                            (worker.phase ?? copy.workers.running).toUpperCase(),
                            worker.heartbeatAgeMs == null
                              ? null
                              : copy.workers.heartbeat(Math.round(worker.heartbeatAgeMs / 1000)),
                          ].filter((part) => part != null).join(" · ")}
                      </Text>
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
  cameraLoading: { alignItems: "center", gap: density.gapLg, padding: density.insetMd },
  cameraPermission: { gap: density.gapLg },
  cameraPanel: { gap: density.gapLg },
  cameraFrame: {
    aspectRatio: 1,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    borderWidth: spacing.hairline,
    overflow: "hidden",
  },
  camera: { flex: 1 },
  cameraCopy: {
    color: colors.muted,
    fontFamily: type.family.sans,
    fontSize: type.size.sm,
    lineHeight: 20,
    textAlign: "center",
  },
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
