import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { patchBuildGradle } = require("../plugins/with-release-signing.js") as {
  patchBuildGradle(source: string): string;
};

const fixture = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.debug
        }
    }
}`;

describe("Android release signing plugin", () => {
  it("makes release builds require the four external signing values", () => {
    const result = patchBuildGradle(fixture);

    expect(result).toContain("REDSKILLED_ANDROID_KEYSTORE_FILE");
    expect(result).toContain("REDSKILLED_ANDROID_KEYSTORE_PASSWORD");
    expect(result).toContain("REDSKILLED_ANDROID_KEY_ALIAS");
    expect(result).toContain("REDSKILLED_ANDROID_KEY_PASSWORD");
    expect(result).toContain("throw new GradleException");
    expect(result).toContain("signingConfigs.release");
    expect(result).toContain(`debug {
            signingConfig signingConfigs.debug
        }`);
  });

  it("is idempotent and fails loudly when the Expo template drifts", () => {
    const patched = patchBuildGradle(fixture);
    expect(patchBuildGradle(patched)).toBe(patched);
    expect(() => patchBuildGradle("android {}"))
      .toThrow(/signing block changed/);
  });
});
