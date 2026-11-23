import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const rootDir = fileURLToPath(root);
const canonicalRoot = fs.realpathSync.native(rootDir);
const canonicalRootPrefix = canonicalRoot.endsWith(path.sep) ? canonicalRoot : `${canonicalRoot}${path.sep}`;

function readText(file) {
  return fs.readFileSync(new URL(file, root), "utf8");
}

function assertNonEmptyString(value, field) {
  assert.ok(typeof value === "string" && value.trim(), `${field} must be a non-empty string`);
}

function assertPackagedFile(file) {
  assertNonEmptyString(file, "packaged file path");
  assert.ok(!path.isAbsolute(file) && !path.win32.isAbsolute(file), `${file} must be a relative path`);
  assert.ok(!file.includes("\\") && !/^[A-Za-z]:/.test(file), `${file} must use POSIX relative path separators`);
  assert.ok(!/[\0?#]/.test(file), `${file} must not contain null bytes, queries, or fragments`);
  const target = path.resolve(rootDir, file);
  const rel = path.relative(rootDir, target);
  assert.ok(
    rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel),
    `${file} must be inside the plugin`,
  );
  assert.ok(fs.statSync(target, { throwIfNoEntry: false })?.isFile(), `${file} must exist as a file`);
  const canonicalFile = fs.realpathSync.native(target);
  assert.ok(canonicalFile.startsWith(canonicalRootPrefix), `${file} must resolve inside the plugin`);
}

function readFrontmatter(file) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(readText(file));
  assert.ok(match, `${file} must start with delimited YAML frontmatter`);

  // Keep the dependency-free check to the YAML forms used here: a flat mapping
  // with simple scalars, folded text, and indented lists of plain strings.
  const fields = new Map();
  const lines = match[1].split(/\r?\n/);
  while (lines.length > 0) {
    const line = lines.shift();
    const context = `${file}: ${line}`;
    const entry = /^([A-Za-z][\w-]*):(?: ([A-Za-z][\w-]*|>-))?$/.exec(line);
    assert.ok(entry, `${context} is not a supported YAML mapping entry`);
    const [, key, scalar] = entry;
    assert.ok(!fields.has(key), `${context} repeats a YAML key`);

    let value = scalar;
    if (scalar === ">-" || scalar === undefined) {
      const content = [];
      const pattern = scalar === ">-" ? /^ {2}(\S[^\x00-\x1f\x7f]*)$/ : /^ {2}- ([A-Za-z][\w-]*)$/;
      while (lines.length > 0 && lines[0].startsWith(" ")) {
        const item = pattern.exec(lines.shift());
        assert.ok(item, `${context} has an invalid indented line`);
        content.push(item[1]);
      }
      assert.ok(content.length > 0, `${context} requires indented content`);
      value = scalar === ">-" ? content.join(" ") : content;
    } else if (/^(true|false|null)$/i.test(scalar)) {
      value = JSON.parse(scalar.toLowerCase());
    }
    fields.set(key, value);
  }

  assertNonEmptyString(fields.get("name"), `${file} name`);
  assertNonEmptyString(fields.get("description"), `${file} description`);
  return fields;
}

test("packages the plugin manifest", () => {
  const plugin = JSON.parse(readText("plugin.json"));
  for (const field of ["name", "version", "description", "logo"]) {
    assertNonEmptyString(plugin[field], `plugin.json ${field}`);
  }
  assert.equal(plugin.name, "codex-cli", "plugin.json name must match installed plugin path");
  assert.notEqual(plugin.disabled, true, "plugin.json must not disable the plugin by default");
  assert.ok(/\.(?:svg|png|jpe?g|webp)$/i.test(plugin.logo), "plugin.json logo must be an image file");
  assertPackagedFile(plugin.logo);
});

test("packages the MCP server", () => {
  const config = JSON.parse(readText("mcp_config.json"));
  const server = config.mcpServers?.codex;
  assert.equal(server?.command, "node");
  assert.ok(Array.isArray(server.args), "MCP codex arguments must be an array");
  const [script] = server.args;
  assertNonEmptyString(script, "MCP codex script");
  const prefix = "${PLUGIN_ROOT}/";
  assert.ok(script.startsWith(prefix) && script.length > prefix.length, `MCP codex script must start with ${prefix}`);
  assertPackagedFile(script.slice(prefix.length));
});

test("packages the opt-in hook", () => {
  const hooks = JSON.parse(readText("hooks.json"));
  assert.ok(hooks && typeof hooks === "object" && !Array.isArray(hooks), "hooks.json must be an object");
  for (const [name, group] of Object.entries(hooks)) {
    assert.ok(group && typeof group === "object" && !Array.isArray(group), `hook group ${name} must be an object`);
    assert.equal(group.enabled, false, `hook group ${name} must remain disabled by default`);
  }
  const gate = hooks["codex-stop-review-gate"];
  assert.ok(gate, "hooks.json must define codex-stop-review-gate");
  assert.ok(Array.isArray(gate.Stop) && gate.Stop.length === 1, "Stop review gate must define exactly one handler");
  const [handler] = gate.Stop;
  assert.ok(handler && typeof handler === "object" && !Array.isArray(handler), "Stop review gate handler must be an object");
  assert.equal(handler.type, "command", "Stop review gate handler type must be command");
  assert.equal(handler.command, "node ./scripts/stop-review-gate.mjs", "Stop review gate must invoke ./scripts/stop-review-gate.mjs");
  assert.ok(Number.isInteger(handler.timeout) && handler.timeout >= 250, "Stop review gate timeout must be an integer >= 250 seconds");
  assertPackagedFile("./scripts/stop-review-gate.mjs");
});

test("validates delegate frontmatter", () => {
  readFrontmatter("agents/codex-delegate.md");
});

const skills = fs.readdirSync(new URL("skills/", root), { withFileTypes: true });
for (const skill of skills.filter((entry) => entry.isDirectory())) {
  test(`validates ${skill.name} frontmatter`, () => {
    const file = `skills/${skill.name}/SKILL.md`;
    assert.equal(readFrontmatter(file).get("name"), skill.name, `${file} name must match its directory`);
  });
}
