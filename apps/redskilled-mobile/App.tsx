import { StatusBar } from "expo-status-bar";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { parseGitHubIssueUrl } from "./src/domain/issue-url";
import type {
  PairedHost,
  TicketDispatchReceipt,
} from "./src/domain/ticket-dispatch";
import { createPreviewDispatchGateway } from "./src/transport/preview-dispatch-gateway";

const PREVIEW_HOST: PairedHost = {
  id: "preview-host",
  name: "Host de desenvolvimento",
  status: "online",
};

const PREVIEW_HOSTS = __DEV__ ? [PREVIEW_HOST] : [];

export default function App() {
  const [selectedHostId, setSelectedHostId] = useState(
    PREVIEW_HOSTS[0]?.id ?? null,
  );
  const [issueUrl, setIssueUrl] = useState("");
  const [isDispatching, setIsDispatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workers, setWorkers] = useState<TicketDispatchReceipt[]>([]);
  const gateway = useMemo(() => createPreviewDispatchGateway(), []);

  const issue = useMemo(() => {
    try {
      return parseGitHubIssueUrl(issueUrl);
    } catch {
      return null;
    }
  }, [issueUrl]);

  const selectedHost = PREVIEW_HOSTS.find(
    (host) => host.id === selectedHostId,
  );
  const canDispatch = selectedHost != null && issue != null && !isDispatching;

  async function dispatchIssue() {
    if (selectedHost == null || issue == null) return;

    setIsDispatching(true);
    setError(null);
    try {
      const receipt = await gateway.dispatch({
        hostId: selectedHost.id,
        issueUrl: issue.canonicalUrl,
      });
      setWorkers((current) => [receipt, ...current]);
      setIssueUrl("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Dispatch recusado");
    } finally {
      setIsDispatching(false);
    }
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
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <View>
              <Text style={styles.eyebrow}>REDSKILLS CONTROL</Text>
              <Text style={styles.title}>redskilled</Text>
            </View>
            <View style={styles.androidBadge}>
              <Text style={styles.androidBadgeText}>ANDROID</Text>
            </View>
          </View>

          {__DEV__ ? (
            <View style={styles.previewBanner}>
              <View style={styles.previewDot} />
              <Text style={styles.previewText}>
                Preview local: o Worker abaixo é simulado até o Remote link entrar.
              </Text>
            </View>
          ) : null}

          <View style={styles.section}>
            <Text style={styles.sectionLabel}>HOST</Text>
            {PREVIEW_HOSTS.length === 0 ? (
              <View style={styles.emptyHost}>
                <Text style={styles.emptyTitle}>Nenhum Host pareado</Text>
                <Text style={styles.secondaryText}>
                  Escaneie o convite gerado por /redskilled para começar.
                </Text>
              </View>
            ) : (
              PREVIEW_HOSTS.map((host) => {
                const selected = host.id === selectedHostId;
                return (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    key={host.id}
                    onPress={() => setSelectedHostId(host.id)}
                    style={[styles.hostCard, selected && styles.hostCardSelected]}
                  >
                    <View>
                      <Text style={styles.hostName}>{host.name}</Text>
                      <Text style={styles.hostMeta}>WireGuard · 24 ms</Text>
                    </View>
                    <View style={styles.onlinePill}>
                      <View style={styles.onlineDot} />
                      <Text style={styles.onlineText}>ONLINE</Text>
                    </View>
                  </Pressable>
                );
              })
            )}
          </View>

          <View style={styles.dispatchCard}>
            <Text style={styles.sectionLabel}>DISPATCH ISSUE</Text>
            <Text style={styles.cardTitle}>Cole uma GitHub Issue</Text>
            <Text style={styles.secondaryText}>
              O Host resolve o repositório, provisiona o Project e inicia um Worker.
            </Text>
            <TextInput
              accessibilityLabel="URL da GitHub Issue"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              onChangeText={(value) => {
                setIssueUrl(value);
                setError(null);
              }}
              onSubmitEditing={() => {
                if (canDispatch) void dispatchIssue();
              }}
              placeholder="https://github.com/owner/repo/issues/123"
              placeholderTextColor="#656C78"
              returnKeyType="go"
              style={[
                styles.input,
                issueUrl.length > 0 && issue == null && styles.inputInvalid,
              ]}
              value={issueUrl}
            />
            {issueUrl.length > 0 && issue == null ? (
              <Text style={styles.validationText}>
                Use uma URL https://github.com/owner/repo/issues/numero
              </Text>
            ) : null}
            {issue != null ? (
              <View style={styles.issuePreview}>
                <Text style={styles.issueRepo}>
                  {issue.owner}/{issue.repository}
                </Text>
                <Text style={styles.issueNumber}>#{issue.ticket}</Text>
              </View>
            ) : null}
            {error != null ? <Text style={styles.errorText}>{error}</Text> : null}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !canDispatch }}
              disabled={!canDispatch}
              onPress={() => void dispatchIssue()}
              style={({ pressed }) => [
                styles.dispatchButton,
                !canDispatch && styles.dispatchButtonDisabled,
                pressed && canDispatch && styles.dispatchButtonPressed,
              ]}
            >
              {isDispatching ? (
                <ActivityIndicator color="#07110B" />
              ) : (
                <Text style={styles.dispatchButtonText}>DISPATCH WORKER</Text>
              )}
            </Pressable>
          </View>

          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionLabel}>WORKERS</Text>
              <Text style={styles.workerCount}>{workers.length} ATIVOS</Text>
            </View>
            {workers.length === 0 ? (
              <View style={styles.emptyWorkers}>
                <Text style={styles.emptyTitle}>Tudo quieto</Text>
                <Text style={styles.secondaryText}>
                  O próximo dispatch aparece aqui com a Issue e o Worker.
                </Text>
              </View>
            ) : (
              workers.map((worker) => (
                <View key={worker.workerId} style={styles.workerCard}>
                  <View style={styles.workerPulse} />
                  <View style={styles.workerBody}>
                    <Text style={styles.workerTitle}>
                      {worker.repository} #{worker.ticket}
                    </Text>
                    <Text style={styles.hostMeta}>{worker.workerId}</Text>
                  </View>
                  <Text style={styles.runningText}>RUNNING</Text>
                </View>
              ))
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#090B0F" },
  page: {
    gap: 28,
    paddingBottom: 56,
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  eyebrow: {
    color: "#8A929F",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 2.2,
  },
  title: {
    color: "#F4F7FA",
    fontSize: 32,
    fontWeight: "800",
    letterSpacing: -1.2,
  },
  androidBadge: {
    borderColor: "#29303A",
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  androidBadgeText: {
    color: "#9DA6B3",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.4,
  },
  previewBanner: {
    alignItems: "center",
    backgroundColor: "#17140D",
    borderColor: "#4A3A16",
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    padding: 12,
  },
  previewDot: {
    backgroundColor: "#F0B429",
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  previewText: { color: "#D6B86E", flex: 1, fontSize: 12, lineHeight: 17 },
  section: { gap: 10 },
  sectionHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  sectionLabel: {
    color: "#777F8B",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.8,
  },
  hostCard: {
    alignItems: "center",
    backgroundColor: "#11151B",
    borderColor: "#242A33",
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 16,
  },
  hostCardSelected: { borderColor: "#48E37B" },
  hostName: { color: "#F1F4F7", fontSize: 16, fontWeight: "700" },
  hostMeta: { color: "#737C89", fontSize: 12, marginTop: 4 },
  onlinePill: {
    alignItems: "center",
    backgroundColor: "#102419",
    borderRadius: 999,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  onlineDot: {
    backgroundColor: "#48E37B",
    borderRadius: 3,
    height: 6,
    width: 6,
  },
  onlineText: {
    color: "#65E88D",
    fontSize: 9,
    fontWeight: "900",
    letterSpacing: 1,
  },
  emptyHost: {
    backgroundColor: "#11151B",
    borderColor: "#242A33",
    borderRadius: 16,
    borderStyle: "dashed",
    borderWidth: 1,
    padding: 18,
  },
  dispatchCard: {
    backgroundColor: "#11151B",
    borderColor: "#242A33",
    borderRadius: 20,
    borderWidth: 1,
    gap: 12,
    padding: 18,
  },
  cardTitle: {
    color: "#F4F7FA",
    fontSize: 22,
    fontWeight: "800",
    letterSpacing: -0.5,
  },
  secondaryText: { color: "#818A97", fontSize: 13, lineHeight: 19 },
  input: {
    backgroundColor: "#090C10",
    borderColor: "#2A313A",
    borderRadius: 12,
    borderWidth: 1,
    color: "#F4F7FA",
    fontSize: 14,
    minHeight: 52,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  inputInvalid: { borderColor: "#9E4242" },
  validationText: { color: "#D16A6A", fontSize: 11 },
  issuePreview: {
    alignItems: "center",
    backgroundColor: "#0D1812",
    borderRadius: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 12,
  },
  issueRepo: { color: "#B7C2BC", fontSize: 13, fontWeight: "600" },
  issueNumber: { color: "#65E88D", fontSize: 13, fontWeight: "800" },
  errorText: { color: "#F07B7B", fontSize: 12 },
  dispatchButton: {
    alignItems: "center",
    backgroundColor: "#48E37B",
    borderRadius: 12,
    justifyContent: "center",
    minHeight: 52,
  },
  dispatchButtonDisabled: { backgroundColor: "#252B31" },
  dispatchButtonPressed: { opacity: 0.82 },
  dispatchButtonText: {
    color: "#07110B",
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 1.4,
  },
  workerCount: {
    color: "#68717E",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1,
  },
  emptyWorkers: {
    alignItems: "center",
    backgroundColor: "#0D1015",
    borderColor: "#202630",
    borderRadius: 16,
    borderStyle: "dashed",
    borderWidth: 1,
    padding: 28,
  },
  emptyTitle: {
    color: "#CDD3DA",
    fontSize: 15,
    fontWeight: "700",
    marginBottom: 5,
  },
  workerCard: {
    alignItems: "center",
    backgroundColor: "#11151B",
    borderColor: "#242A33",
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    padding: 14,
  },
  workerPulse: {
    backgroundColor: "#48E37B",
    borderRadius: 5,
    height: 10,
    marginRight: 12,
    width: 10,
  },
  workerBody: { flex: 1 },
  workerTitle: { color: "#E8ECF0", fontSize: 14, fontWeight: "700" },
  runningText: {
    color: "#65E88D",
    fontSize: 9,
    fontWeight: "900",
    letterSpacing: 1.1,
  },
});
