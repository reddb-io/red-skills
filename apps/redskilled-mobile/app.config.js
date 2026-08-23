const packageManifest = require("./package.json");

function androidVersionCode(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match == null) {
    throw new Error(`Cannot derive Android versionCode from ${version}`);
  }

  const [, majorText, minorText, patchText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  if (minor > 999 || patch > 999) {
    throw new Error(`Android versionCode component exceeds 999 in ${version}`);
  }
  return major * 1_000_000 + minor * 1_000 + patch;
}

module.exports = ({ config }) => ({
  ...config,
  version: packageManifest.version,
  android: {
    ...config.android,
    versionCode: androidVersionCode(packageManifest.version),
  },
});

module.exports.androidVersionCode = androidVersionCode;
