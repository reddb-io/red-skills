import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { colors, density } from "../src/design-system/tokens";
import { copy } from "../src/ui/copy";

const appRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const sourceRoot = join(appRoot, "src");
const vendorRoot = join(appRoot, "vendor", "design-system");

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("Redskilled Mobile Design System adoption", () => {
  it("keeps the native color adapter tied to vendored generated tokens", () => {
    const generatedTokens = readFileSync(join(vendorRoot, "tokens", "tokens.css"), "utf8");

    for (const value of new Set(Object.values(colors))) {
      expect(generatedTokens).toContain(value);
    }
  });

  it("uses the vendored compact density stop for the native application surface", () => {
    const compactDensity = readFileSync(join(vendorRoot, "tokens", "density-compact.css"), "utf8");

    expect(compactDensity).toContain('[data-density="compact"]');
    expect(density).toEqual({
      controlHeightSm: 22,
      controlHeightMd: 28,
      controlHeightLg: 36,
      gapSm: 3,
      gapMd: 6,
      gapLg: 10,
      insetSm: 10,
      insetMd: 14,
      insetLg: 22,
    });
  });

  it("pins the identity and native font bytes copied from the Design System", () => {
    expect(sha256(join(vendorRoot, "platform", "icon-512.png"))).toBe(
      "f05ebd448beaf4c9e9e57af0b1836f1f07a26db05f7dc3f972dc46cab1cb34b0",
    );
    expect(sha256(join(vendorRoot, "platform", "maskable-512.png"))).toBe(
      "f9eb2a35751029f85a1e6eb8846e3bcf7ee0eac2e642357bb11097175bf7102f",
    );
    expect(sha256(join(vendorRoot, "platform", "adaptive-background-432.png"))).toBe(
      "2012fc72372d92f36ba71a6c6b5d9e683ac08c7dde1eb3de319c8b968918e796",
    );
    expect(sha256(join(vendorRoot, "platform", "adaptive-foreground-432.png"))).toBe(
      "4574177ccff1acf5558a0c777f8e676fb31970c2620568fa23a44c4251b85b24",
    );
    expect(sha256(join(vendorRoot, "marks", "reddb-horizontal-inverse-h128.png"))).toBe(
      "c199948ac7c4b5b11c913634ac881d052a7d0d6aaa7c85766b253797ef177be5",
    );
    expect(sha256(join(vendorRoot, "marks", "reddb-stacked-inverse-h256.png"))).toBe(
      "359cc4c0e7661250f91f934bd3e225d76d68ac3c6886108e64b5ba5b3d63d18d",
    );
    expect(sha256(join(vendorRoot, "fonts", "space-grotesk-variable.ttf"))).toBe(
      "94f4af82871f6de575a33981e6609ebba43d9201c0a8b6275f4d6647ea527a3b",
    );
    expect(sha256(join(vendorRoot, "fonts", "jetbrains-mono-variable.ttf"))).toBe(
      "662a196d58f1183bf2d77428b6d5283fe3f45161ab021bea4036bc98e5cac016",
    );
  });

  it("keeps runtime source free of a sibling-repository dependency and local hex values", () => {
    const appSource = readFileSync(join(appRoot, "App.tsx"), "utf8");
    const runtimeSources = [appSource, ...sourceFiles(sourceRoot).map((path) => readFileSync(path, "utf8"))];
    const packageManifest = readFileSync(join(appRoot, "package.json"), "utf8");

    expect(packageManifest).not.toMatch(/design-system/);
    expect(runtimeSources.join("\n")).not.toMatch(/\.\.\/design-system/);
    expect(appSource).not.toMatch(/#[0-9a-f]{6}/i);
    for (const path of sourceFiles(sourceRoot).filter((path) => !path.endsWith("tokens.ts"))) {
      expect(readFileSync(path, "utf8"), path).not.toMatch(/#[0-9a-f]{6}/i);
    }
  });

  it("keeps every owned mobile string in English", () => {
    const ownedCopy = JSON.stringify(copy);
    const runtimeSources = [join(appRoot, "App.tsx"), ...sourceFiles(sourceRoot)]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    const portuguese = /\b(?:ainda|ativos|aqui|cole|configurado|inicia|número|próximo|provisiona|quieto|recusado|repositório|tudo|uma)\b/i;

    expect(ownedCopy).not.toMatch(portuguese);
    expect(runtimeSources).not.toMatch(portuguese);
  });

  it("uses vendored platform identity in Expo config", () => {
    const config = JSON.parse(readFileSync(join(appRoot, "app.json"), "utf8")) as {
      expo: {
        icon: string;
        android: { adaptiveIcon: { backgroundImage: string; foregroundImage: string } };
        plugins: Array<string | [string, Record<string, unknown>]>;
        web: { favicon: string };
      };
    };

    expect(config.expo.icon).toBe("./vendor/design-system/platform/icon-512.png");
    expect(config.expo.android.adaptiveIcon.foregroundImage).toBe(
      "./vendor/design-system/platform/adaptive-foreground-432.png",
    );
    expect(config.expo.android.adaptiveIcon.backgroundImage).toBe(
      "./vendor/design-system/platform/adaptive-background-432.png",
    );
    expect(config.expo.web.favicon).toBe("./vendor/design-system/platform/icon-192.png");

    const splash = config.expo.plugins.find(
      (plugin): plugin is [string, Record<string, unknown>] =>
        Array.isArray(plugin) && plugin[0] === "expo-splash-screen",
    );
    expect(splash?.[1]).toMatchObject({
      backgroundColor: "#07080a",
      image: "./vendor/design-system/marks/reddb-stacked-inverse-h256.png",
      imageWidth: 160,
      resizeMode: "contain",
    });
  });

  it("uses the Brand-published inverse lockup on the dark application surface", () => {
    const components = readFileSync(join(sourceRoot, "design-system", "components.tsx"), "utf8");

    expect(components).toContain("reddb-horizontal-inverse-h128.png");
    expect(components).not.toContain("platform/icon-512.png");
    expect(components).toContain("size * 0.25");
  });
});
