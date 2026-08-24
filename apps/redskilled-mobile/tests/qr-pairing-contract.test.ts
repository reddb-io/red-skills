import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

describe("camera QR pairing contract", () => {
  it("uses the Expo 57 camera package with an explicit permission description", () => {
    const manifest = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const config = JSON.parse(readFileSync(join(appRoot, "app.json"), "utf8")) as {
      expo: { plugins: unknown[] };
    };
    expect(manifest.dependencies["expo-camera"]).toBe("~57.0.4");
    expect(config.expo.plugins).toContainEqual(["expo-camera", {
      cameraPermission: "Allow Redskilled to scan one-use Host pairing invitations.",
      recordAudioAndroid: false,
    }]);
  });

  it("limits scanning to QR and routes scan data through the manual pairing path", () => {
    const app = readFileSync(join(appRoot, "App.tsx"), "utf8");
    expect(app).toContain("useCameraPermissions()");
    expect(app).toContain('barcodeScannerSettings={{ barcodeTypes: ["qr"] }}');
    expect(app).toMatch(/async function pairHost\(invitation: string\)[\s\S]*pairRedskilledHost\(invitation,/);
    expect(app).toContain("await pairHost(data);");
    expect(app).toContain("pairHost(pairingCode)");
  });

  it("requests camera permission only from an explicit action", () => {
    const app = readFileSync(join(appRoot, "App.tsx"), "utf8");
    expect(app).toContain("onPress={() => void requestCameraPermission()}");
    expect(app).not.toMatch(/useEffect\([\s\S]{0,200}requestCameraPermission/);
  });
});
