import { useFonts } from "expo-font";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
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
import {
  fleetHostViews,
  fleetWorkerRows,
  type FleetWorkerRow,
  type HostRuntime,
} from "./src/domain/host-fleet";
import { parseGitHubIssueUrl } from "./src/domain/issue-url";
import type { MobileOperatorGateway } from "./src/domain/ticket-dispatch";
import { addPairedHost, loadPairedHosts, removePairedHost } from "./src/transport/paired-host-store";
import { createRemoteOperatorGateway } from "./src/transport/remote-operator-gateway";
import { copy } from "./src/ui/copy";

export default function App() {
  const [fontsLoaded, fontError] = useFonts({
    JetBrainsMono: require("./vendor/design-system/fonts/jetbrains-mono-variable.ttf"),
    SpaceGrotesk: require("./vendor/design-system/fonts/space-grotesk-variable.ttf"),
  });
  const [hosts, setHosts] = useState<readonly RedskilledLinkPairedHost[]>([]);
  const [activeHostId, setActiveHostId] = useState<string | null>(null);
  const [addingHost, setAddingHost] = useState(false);
  const [pairingCode, setPairingCode] = useState("");
  const [isPairing, setIsPairing] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const scanLocked = useRef(false);
  const [issueUrl, setIssueUrl] = useState("");
  const [isDispatching, setIsDispatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<Readonly<Record<string, HostRuntime>>>({});
  const [pending, setPending] = useState<readonly FleetWorkerRow[]>([]);
  const gateways = useMemo(() => {
    const built = new Map<string, MobileOperatorGateway>();
    for (const host of hosts) built.set(host.host_id, createRemoteOperatorGateway(host));
    return built;
  }, [hosts]);
  const activeHost = hosts.find((host) => host.host_id === activeHostId) ?? hosts[0] ?? null;

  useEffect(() => {
    let active = true;
    void loadPairedHosts().then((loaded) => {
      if (active) setHosts(loaded);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (gateways.size === 0) return;
    let active = true;
    // Each Host is polled on its own and each outcome lands in ITS runtime:
    // an answered read stamps the instant the status verdict derives from,
    // and a failed read records WHY instead of being swallowed — one dead
    // machine reads unreachable on its own card while the rest stay honest.
    const refresh = () => {
      for (const [hostId, gateway] of gateways) {
        void gateway.state().then((snapshot) => {
          if (!active) return;
          setRuntime((current) => ({
            ...current,
            [hostId]: { snapshot, lastAnsweredAtMs: Date.now(), failure: null },
          }));
          setPending((current) => current.filter((row) =>
            row.hostId !== hostId || !snapshot.workers.some((worker) => worker.workerId === row.workerId)));
        }).catch((failure: unknown) => {
          if (!active) return;
          setRuntime((current) => ({
            ...current,
            [hostId]: {
              snapshot: current[hostId]?.snapshot ?? null,
              lastAnsweredAtMs: current[hostId]?.lastAnsweredAtMs ?? null,
              failure: failure instanceof Error ? failure.message : String(failure),
            },
          }));
        });
      }
    };
    refresh();
    const timer = setInterval(refresh, 3_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [gateways]);

  const issue = useMemo(() => {
    try {
      return parseGitHubIssueUrl(issueUrl);
    } catch {
      return null;
    }
  }, [issueUrl]);

  const now = Date.now();
  const hostViews = fleetHostViews(hosts, runtime, now);
  const workers = fleetWorkerRows(hosts, runtime, pending, now);
  const canDispatch = activeHost != null && issue != null && !isDispatching;

  async function dispatchIssue() {
    const gateway = activeHost == null ? null : gateways.get(activeHost.host_id);
    if (activeHost == null || issue == null || gateway == null) return;

    setIsDispatching(true);
    setError(null);
    try {
      const receipt = await gateway.dispatch({
        hostId: activeHost.host_id,
        issueUrl: issue.canonicalUrl,
      });
      setPending((current) => [{
        workerId: receipt.workerId,
        repository: receipt.repository,
        ticket: receipt.ticket,
        startedAt: new Date().toISOString(),
        pending: true,
        hostId: activeHost.host_id,
        hostName: activeHost.host_name,
      }, ...current.filter((row) => row.workerId !== receipt.workerId)]);
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
      setHosts(await addPairedHost(host));
      setActiveHostId(host.host_id);
      setAddingHost(false);
      setPairingCode("");
    } catch {
      setError(copy.errors.pairing);
    } finally {
      setIsPairing(false);
    }
  }

  async function unpairHost(hostId: string) {
    setError(null);
    setHosts(await removePairedHost(hostId));
    setRuntime(({ [hostId]: _gone, ...rest }) => rest);
    setPending((current) => current.filter((row) => row.hostId !== hostId));
    if (activeHostId === hostId) setActiveHostId(null);
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

  async function stopWorker(row: FleetWorkerRow) {
    const gateway = gateways.get(row.hostId);
    if (gateway == null) return;
    setError(null);
    try {
      if (await gateway.stop(row.workerId)) {
        setPending((current) => current.filter((entry) => entry.workerId !== row.workerId));
        setRuntime((current) => {
          const state = current[row.hostId];
          if (state?.snapshot == null) return current;
          return {
            ...current,
            [row.hostId]: {
              ...state,
              snapshot: {
                ...state.snapshot,
                workers: state.snapshot.workers.filter((worker) => worker.workerId !== row.workerId),
              },
            },
          };
        });
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
            <SectionHeading
              actions={hosts.length === 0 ? undefined : <Pill label={copy.host.count(hosts.length)} />}
              eyebrow={copy.host.section}
            />
            {hostViews.map((view) => (
              <Pressable
                accessibilityLabel={copy.host.selectLabel(view.hostName)}
                key={view.hostId}
                onPress={() => setActiveHostId(view.hostId)}
              >
                <Card
                  style={[
                    styles.hostCard,
                    activeHost?.host_id === view.hostId && styles.hostCardActive,
                  ]}
                >
                  <View style={styles.hostIdentity}>
                    <View style={styles.hostGlyph}>
                      <Text style={styles.hostGlyphText}>H</Text>
                    </View>
                    <View style={styles.hostText}>
                      <Text style={styles.hostName}>{view.hostName}</Text>
                      <Text style={styles.metadata}>
                        {view.daemonVersion == null
                          ? copy.host.pairedDescription
                          : `${copy.host.daemonVersion(view.daemonVersion)} · ${copy.host.workerCount(view.workerCount)}`}
                      </Text>
                      {view.failure == null || view.status === "online" ? null : (
                        <Text style={styles.metadata}>{copy.errors.state(view.failure)}</Text>
                      )}
                    </View>
                  </View>
                  <View style={styles.hostActions}>
                    <Pill glyph="◆" label={copy.host.status[view.status]} />
                    <Button
                      label={copy.host.unpair}
                      onPress={() => void unpairHost(view.hostId)}
                      tone="danger"
                      variant="ghost"
                    />
                  </View>
                </Card>
              </Pressable>
            ))}
            {hosts.length > 0 && !addingHost ? (
              <Button
                label={copy.host.addAnother}
                onPress={() => {
                  setAddingHost(true);
                  setError(null);
                }}
                variant="secondary"
              />
            ) : (
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
                {hosts.length === 0 ? null : (
                  <Button
                    label={copy.host.addCancel}
                    onPress={() => setAddingHost(false)}
                    variant="ghost"
                  />
                )}
              </Card>
            )}
          </View>

          <View style={styles.section}>
            <SectionHeading
              description={activeHost == null
                ? copy.dispatch.description
                : copy.dispatch.target(activeHost.host_name)}
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
                    key={`${worker.hostId}:${worker.workerId}`}
                    style={[styles.workerRow, index > 0 && styles.workerRowBorder]}
                  >
                    <View style={styles.workerGlyph}>
                      <Text style={styles.workerGlyphText}>▶</Text>
                    </View>
                    <View style={styles.workerBody}>
                      <Text numberOfLines={1} style={styles.workerTitle}>
                        {worker.repository}{worker.ticket == null ? "" : ` #${worker.ticket}`}
                      </Text>
                      <Text numberOfLines={1} style={styles.workerId}>
                        {worker.hostName} · {worker.workerId}
                      </Text>
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
                      onPress={() => void stopWorker(worker)}
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
  hostCardActive: { borderColor: colors.primary },
  hostActions: { alignItems: "flex-end", gap: density.gapSm },
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
