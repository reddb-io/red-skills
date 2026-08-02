#!/usr/bin/env python3
"""check-manifest — assert herdr-plugin.toml parses and holds together.

herdr validates the manifest at install time, which is the wrong moment to find
a duplicate id or a stray quote. The rules checked here are the manifest's own:
ids are unique and dot-free, every entry names a command, and every non-Windows
entry has a Windows twin (or deliberately does not).
"""
import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ID = re.compile(r"^[A-Za-z0-9:_-]+$")
PLUGIN_ID = re.compile(r"^[A-Za-z0-9.:_-]+$")
PLACEMENTS = {"overlay", "popup", "split", "tab", "zoomed"}
CONTEXTS = {"global", "workspace", "tab", "pane", "selection"}
PLATFORMS = {"linux", "macos", "windows"}

failures = []


def check(condition, message):
    if not condition:
        failures.append(message)


manifest = tomllib.loads((ROOT / "herdr-plugin.toml").read_text(encoding="utf-8"))

for field in ("id", "name", "version", "min_herdr_version"):
    check(field in manifest, f"missing required field {field!r}")
check(PLUGIN_ID.match(manifest["id"]) is not None, f"plugin id {manifest['id']!r} is not ascii/./:/_/-")
check(set(manifest.get("platforms", [])) <= PLATFORMS, "unknown platform in the top-level list")

entry_ids = []
for section in ("panes", "actions"):
    for entry in manifest.get(section, []):
        entry_ids.append(entry["id"])
        check(ID.match(entry["id"]) is not None, f"{section} id {entry['id']!r} must carry no dot")
        check(bool(entry.get("command")), f"{section} {entry['id']!r} names no command")
        check(set(entry.get("platforms", [])) <= PLATFORMS, f"{section} {entry['id']!r} names an unknown platform")

check(len(entry_ids) == len(set(entry_ids)), "two entries share an id; herdr requires them unique")

for pane in manifest.get("panes", []):
    check(pane.get("placement", "overlay") in PLACEMENTS, f"pane {pane['id']!r} has an unknown placement")

for action in manifest.get("actions", []):
    check(set(action.get("contexts", [])) <= CONTEXTS, f"action {action['id']!r} names an unknown context")

# Every unix entry needs a Windows twin, because the manifest cannot express one
# command per platform under one id — and a missing twin is a feature that
# silently does not exist on Windows rather than one that fails loudly.
for section in ("panes", "actions", "startup", "build"):
    unix = [e for e in manifest.get(section, []) if "windows" not in e.get("platforms", [])]
    windows = [e for e in manifest.get(section, []) if e.get("platforms") == ["windows"]]
    check(
        len(unix) == len(windows),
        f"{section}: {len(unix)} unix entr(ies) but {len(windows)} windows twin(s)",
    )

for section in ("panes", "actions", "startup", "build"):
    for entry in manifest.get(section, []):
        joined = " ".join(entry["command"])
        if entry.get("platforms") == ["windows"]:
            continue
        if "HERDR_PLUGIN_ROOT" in joined:
            check("$HERDR_PLUGIN_ROOT" in joined, f"{section}: the plugin root must be read as a shell variable")

# Every command must name an entry that is actually there. A pane whose command
# points at a renamed file opens and closes again with nothing to read, which is
# the failure this check exists to make loud at development time rather than at
# session-restore time.
for section in ("panes", "actions", "startup", "build"):
    for entry in manifest.get(section, []):
        joined = " ".join(entry["command"])
        # `startup` and `build` entries carry no id; the section names them well enough.
        who = entry.get("id", section)
        for match in re.finditer(r"HERDR_PLUGIN_ROOT[/\\]([\w./\\-]+\.mjs)", joined):
            named = match.group(1).replace("\\", "/")
            check((ROOT / named).is_file(), f"{section} {who!r} runs {named!r}, which is not in this checkout")

# The entry answers `--version` off the build stamp, and stands its own constant
# in when there is no stamp — a checkout run. A constant that drifted from the
# manifest would make that answer name a release nobody shipped.
entry_source = (ROOT / "bin" / "red-skills-herdr.mjs").read_text(encoding="utf-8")
checkout_version = re.search(r'^const CHECKOUT_VERSION = "([^"]+)";$', entry_source, re.MULTILINE)
check(checkout_version is not None, "the entry declares no CHECKOUT_VERSION for an unstamped run to fall back to")
if checkout_version is not None:
    check(
        checkout_version.group(1) == manifest["version"],
        f"the entry's CHECKOUT_VERSION {checkout_version.group(1)!r} is not the manifest's {manifest['version']!r}",
    )

if failures:
    for failure in failures:
        print(f"FAIL {failure}")
    sys.exit(1)

print(
    f"ok  {manifest['id']} v{manifest['version']} — "
    f"{len(manifest.get('panes', []))} panes, {len(manifest.get('actions', []))} actions, "
    f"{len(manifest.get('startup', []))} startup, {len(manifest.get('build', []))} build"
)
