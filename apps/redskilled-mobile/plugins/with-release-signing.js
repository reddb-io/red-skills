const { withAppBuildGradle } = require("expo/config-plugins");

const DEBUG_SIGNING_CONFIG = `    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }`;

const RELEASE_SIGNING_CONFIG = `    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
        release {
            if (redskilledReleaseSigningAvailable) {
                storeFile file(redskilledReleaseKeystoreFile)
                storePassword System.getenv("REDSKILLED_ANDROID_KEYSTORE_PASSWORD")
                keyAlias System.getenv("REDSKILLED_ANDROID_KEY_ALIAS")
                keyPassword System.getenv("REDSKILLED_ANDROID_KEY_PASSWORD")
            }
        }
    }`;

const RELEASE_PREAMBLE = `def redskilledReleaseKeystoreFile = System.getenv("REDSKILLED_ANDROID_KEYSTORE_FILE")
def redskilledReleaseSigningAvailable = [
    redskilledReleaseKeystoreFile,
    System.getenv("REDSKILLED_ANDROID_KEYSTORE_PASSWORD"),
    System.getenv("REDSKILLED_ANDROID_KEY_ALIAS"),
    System.getenv("REDSKILLED_ANDROID_KEY_PASSWORD"),
].every { it != null && !it.isEmpty() }
def redskilledReleaseTask = gradle.startParameter.taskNames.any {
    it.toLowerCase().contains("release")
}

if (redskilledReleaseTask && !redskilledReleaseSigningAvailable) {
    throw new GradleException("Redskilled release signing credentials are missing")
}

`;

function patchBuildGradle(source) {
  if (source.includes("redskilledReleaseSigningAvailable")) return source;
  if (!source.includes(DEBUG_SIGNING_CONFIG)) {
    throw new Error("Expo Android signing block changed; update the Redskilled signing plugin");
  }

  const withPreamble = source.replace("android {", `${RELEASE_PREAMBLE}android {`);
  const withSigning = withPreamble.replace(
    DEBUG_SIGNING_CONFIG,
    RELEASE_SIGNING_CONFIG,
  );
  const releaseDebugSigning = /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/;
  if (!releaseDebugSigning.test(withSigning)) {
    throw new Error("Expo Android release build type changed; update the Redskilled signing plugin");
  }
  return withSigning.replace(
    releaseDebugSigning,
    "$1signingConfig redskilledReleaseSigningAvailable ? signingConfigs.release : signingConfigs.debug",
  );
}

function withReleaseSigning(config) {
  return withAppBuildGradle(config, (gradleConfig) => {
    if (gradleConfig.modResults.language !== "groovy") {
      throw new Error("Redskilled release signing requires a Groovy Android build file");
    }
    gradleConfig.modResults.contents = patchBuildGradle(
      gradleConfig.modResults.contents,
    );
    return gradleConfig;
  });
}

module.exports = withReleaseSigning;
module.exports.patchBuildGradle = patchBuildGradle;
