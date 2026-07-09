#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
let root = path.resolve(".");

for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--root") {
    root = path.resolve(args[i + 1] ?? "");
    i += 1;
    continue;
  }
  console.error(`unknown argument: ${args[i]}`);
  process.exit(2);
}

const pluginsDir = path.join(root, "plugins");
if (!fs.existsSync(pluginsDir)) {
  console.log(`lint-local-markdown-links: no plugins/ directory under ${root} - nothing to check`);
  process.exit(0);
}

const markdownFiles = [];
walk(pluginsDir, markdownFiles);

const failures = [];
for (const file of markdownFiles) {
  if (shouldIgnoreFile(file)) continue;
  const text = fs.readFileSync(file, "utf8");
  const checkableText = stripFencedCodeBlocks(text);
  for (const link of linksIn(checkableText)) {
    const target = normaliseTarget(link.target);
    if (!target || shouldIgnoreTarget(target)) continue;

    const targetPath = target.startsWith("/")
      ? path.join(root, target.slice(1))
      : path.resolve(path.dirname(file), target);

    if (!fs.existsSync(targetPath)) {
      failures.push({
        file,
        line: lineNumberAt(text, link.index),
        target: link.target,
        resolved: targetPath,
      });
    }
  }
}

if (failures.length > 0) {
  console.error(`lint-local-markdown-links: ${failures.length} broken local markdown link(s)`);
  for (const failure of failures) {
    console.error(`FAIL  ${path.relative(root, failure.file)}:${failure.line}`);
    console.error(`      > ${failure.target}`);
    console.error(`      > resolved to missing ${path.relative(root, failure.resolved)}`);
  }
  process.exit(1);
}

console.log(`lint-local-markdown-links: checked ${markdownFiles.length} markdown file(s), 0 broken local link(s)`);

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".md") && isSkillMarkdown(full)) {
      out.push(full);
    }
  }
}

function isSkillMarkdown(file) {
  return path.relative(root, file).split(path.sep).includes("skills");
}

function shouldIgnoreFile(file) {
  const relative = path.relative(root, file).split(path.sep);
  if (relative.includes("in-progress") || relative.includes("examples")) return true;
  const base = path.basename(file);
  return base.includes("template") || base === "CONTEXT-FORMAT.md";
}

function stripFencedCodeBlocks(text) {
  return text.replace(/^```[\s\S]*?^```/gm, (block) => "\n".repeat(block.split("\n").length - 1));
}

function* linksIn(text) {
  const inline = /!?\[[^\]\n]*(?:\][^\[\]\n]*)*]\(([^)\n]+)\)/g;
  const reference = /^[ \t]{0,3}\[[^\]\n]+]:[ \t]*(\S+)/gm;

  for (const match of text.matchAll(inline)) {
    if (match[0].startsWith("![")) continue;
    yield { target: match[1], index: match.index ?? 0 };
  }
  for (const match of text.matchAll(reference)) {
    yield { target: match[1], index: match.index ?? 0 };
  }
}

function normaliseTarget(raw) {
  let target = raw.trim();
  if (target.startsWith("<") && target.endsWith(">")) {
    target = target.slice(1, -1).trim();
  }
  target = target.split(/[ \t]+/)[0] ?? "";
  const hash = target.indexOf("#");
  if (hash >= 0) target = target.slice(0, hash);
  try {
    target = decodeURI(target);
  } catch {
    // Keep the raw spelling if it is not URI-encoded.
  }
  return target;
}

function shouldIgnoreTarget(target) {
  if (target === "" || target.startsWith("#")) return true;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith("//")) return true;
  if (target.includes("{{") || target.includes("}}")) return true;
  if (target.includes("<") || target.includes(">")) return true;
  if (target === "./..." || target.endsWith("/...")) return true;
  if (/(^|\/)(slug|page-x)\.md$/.test(target)) return true;
  return false;
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}
