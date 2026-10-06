const assert = require("node:assert/strict");
const fs = require("node:fs");
const { position, applyEdits, editsFor, sameUri } = require("./project");
const at = (client, fixture, method, fragment, inside = 0, extra = {}) =>
  client.request(method, {
    textDocument: { uri: fixture.uri },
    position: position(fixture.text, fragment, inside),
    ...extra,
  });
const exerciseIntelligence = async (client, fixture) => {
  const covered = [];
  const check = (name, condition) => {
    assert.ok(condition, `${name} returned no usable result`);
    covered.push(name);
  };
  client.open(fixture.uri, "ruby", fixture.text);
  await client.waitFor(
    async () => (await client.request("workspace/symbol", { query: "Calculator" })).length > 1,
    "Ruby workspace indexing",
    60000,
  );
  const completion = await at(
    client,
    fixture,
    "textDocument/completion",
    "Calculator.add(1, 2)",
    13,
  );
  check(
    "completion",
    (completion.items || completion).some(({ label }) => label.startsWith("add")),
  );
  const signature = await at(
    client,
    fixture,
    "textDocument/signatureHelp",
    "Calculator.add(1, 2)",
    17,
  );
  check(
    "signature",
    signature.signatures.some(({ label }) => label.includes("left") && label.includes("right")),
  );
  const hover = await at(client, fixture, "textDocument/hover", "Calculator.add(1, 2)", 12);
  check("hover", JSON.stringify(hover).includes("Add two values"));
  const definition = await at(
    client,
    fixture,
    "textDocument/definition",
    "Calculator.add(1, 2)",
    1,
  );
  check(
    "definition",
    definition.some((item) => sameUri(item.uri || item.targetUri, fixture.uri)),
  );
  const symbols = await client.request("textDocument/documentSymbol", {
    textDocument: { uri: fixture.uri },
  });
  check(
    "document symbols",
    symbols.some(({ name }) => name === "Calculator"),
  );
  const workspace = await client.request("workspace/symbol", { query: "WorkspaceHelper" });
  check(
    "workspace symbols",
    workspace.some(({ name }) => name === "WorkspaceHelper"),
  );
  const dependency = await client.request("workspace/symbol", { query: "ProjectDependency" });
  check(
    "project bundle dependency indexing",
    dependency.some(({ name }) => name === "ProjectDependency"),
  );
  const format = await client.request("textDocument/formatting", {
    textDocument: { uri: fixture.uri },
    options: { tabSize: 2, insertSpaces: true },
  });
  check(
    "RuboCop formatting",
    format.length > 0 && applyEdits(fixture.text, format) !== fixture.text,
  );
  const hints = await client.request("textDocument/inlayHint", {
    textDocument: { uri: fixture.uri },
    range: {
      start: { line: 0, character: 0 },
      end: { line: fixture.text.split("\n").length - 1, character: 0 },
    },
  });
  check(
    "implicit Ruby inlay hints",
    hints.some(({ label }) => label === "StandardError") &&
      hints.some(({ label }) => label === "answer"),
  );
  const tokens = await client.request("textDocument/semanticTokens/full", {
    textDocument: { uri: fixture.uri },
  });
  check("semantic tokens", tokens.data.length > 0 && tokens.data.length % 5 === 0);
  const parents = await at(
    client,
    fixture,
    "textDocument/prepareTypeHierarchy",
    "Calculator < BaseCalculator",
    15,
  );
  check(
    "type hierarchy",
    parents.some(({ name }) => name === "BaseCalculator"),
  );
  const children = await client.request("typeHierarchy/subtypes", { item: parents[0] });
  assert.equal(children, null, "Ruby LSP currently does not implement subtype lookup");
  const child = await at(
    client,
    fixture,
    "textDocument/prepareTypeHierarchy",
    "Calculator.add(1, 2)",
    1,
  );
  const supers = await client.request("typeHierarchy/supertypes", { item: child[0] });
  check(
    "supertypes",
    supers.some(({ name }) => name === "BaseCalculator"),
  );
  const folds = await client.request("textDocument/foldingRange", {
    textDocument: { uri: fixture.uri },
  });
  check(
    "folding",
    folds.some(({ startLine, endLine }) => startLine < endLine),
  );
  const selections = await client.request("textDocument/selectionRange", {
    textDocument: { uri: fixture.uri },
    positions: [position(fixture.text, "Calculator.add(1, 2)", 1)],
  });
  check("selection ranges", selections[0].parent);
  return covered;
};
const exerciseUnicodeRename = async (client, fixture) => {
  client.open(fixture.uri, "ruby", fixture.text);
  await client.waitFor(
    async () => (await client.request("workspace/symbol", { query: "Calculator" })).length > 1,
    "Ruby workspace indexing",
    60000,
  );
  const start = position(fixture.text, "Calculator.add(4, 5)");
  const asciiStart = position(fixture.text, "Calculator.add(1, 2)");
  const asciiPrepared = await at(
    client,
    fixture,
    "textDocument/prepareRename",
    "Calculator.add(1, 2)",
    1,
  );
  const asciiRange = asciiPrepared.range || asciiPrepared;
  assert.equal(asciiRange.start.character, asciiStart.character);
  assert.equal(asciiRange.end.character, asciiStart.character + 10);
  const prepared = await at(
    client,
    fixture,
    "textDocument/prepareRename",
    "Calculator.add(4, 5)",
    1,
  );
  const range = prepared.range || prepared;
  assert.equal(range.start.character, start.character);
  assert.equal(range.end.character, start.character + 10);
  const refs = await at(client, fixture, "textDocument/references", "Calculator.add(4, 5)", 1, {
    context: { includeDeclaration: true },
  });
  const occurrence = refs.find(({ range }) => range.start.line === start.line);
  assert.equal(occurrence.range.start.character, start.character);
  assert.equal(occurrence.range.end.character, start.character + 10);
  const closedStart = position(fixture.linkedText, "Calculator");
  const closedOccurrence = refs.find(({ uri }) => sameUri(uri, fixture.linkedUri));
  assert.equal(closedOccurrence.range.start.character, closedStart.character);
  assert.equal(closedOccurrence.range.end.character, closedStart.character + 10);
  const renamed = await at(client, fixture, "textDocument/rename", "Calculator.add(4, 5)", 1, {
    newName: "Arithmetic",
  });
  const changed = applyEdits(fixture.text, editsFor(renamed, fixture.uri));
  assert.ok(changed.includes('unicode = "😀"; result = Arithmetic.add(4, 5)'));
  assert.ok(changed.includes("class Arithmetic < BaseCalculator"));
  const closedChanged = applyEdits(fixture.linkedText, editsFor(renamed, fixture.linkedUri));
  assert.ok(closedChanged.includes('marker = "😀"; object = Arithmetic'));
  fs.writeFileSync(fixture.linkedPath, closedChanged);
  await client.change(fixture.uri, changed, 2);
  const symbols = await client.request("textDocument/documentSymbol", {
    textDocument: { uri: fixture.uri },
  });
  assert.ok(symbols.some(({ name }) => name === "Arithmetic"));
  return [
    "constant references",
    "prepare rename after astral text",
    "UTF-16 reference ranges",
    "constant rename",
    "UTF-16 rename edits",
    "unchanged ASCII ranges",
    "closed-file UTF-16 references and edits",
    "symbols after applying rename edits",
  ];
};
const exerciseDiagnosticEdits = async (client, fixture) => {
  const textDocument = { uri: fixture.uri };
  client.open(fixture.uri, "ruby", "class Broken\n");
  const broken = await client.request("textDocument/diagnostic", { textDocument });
  assert.ok(
    broken.items.some(({ severity }) => severity === 1),
    "Syntax error diagnostic is missing",
  );
  await client.change(fixture.uri, "# frozen_string_literal: true\n\nvalue = 1\n", 2);
  await client.waitFor(async () => {
    const fixed = await client.request("textDocument/diagnostic", { textDocument });
    return !fixed.items.some(({ source, severity }) => source === "Prism" && severity === 1);
  }, "cleared Ruby syntax diagnostics");
  const code = "# frozen_string_literal: true\n\nvalue=1\n";
  await client.change(fixture.uri, code, 3);
  const style = await client.waitFor(async () => {
    const report = await client.request("textDocument/diagnostic", { textDocument });
    return report.items.some(({ code }) => code === "Layout/SpaceAroundOperators") && report;
  }, "RuboCop operator-spacing diagnostic");
  const diagnostic = style.items.find(({ code }) => code === "Layout/SpaceAroundOperators");
  assert.ok(diagnostic, "RuboCop style diagnostic is missing");
  const actions = await client.request("textDocument/codeAction", {
    textDocument,
    range: diagnostic.range,
    context: { diagnostics: style.items, only: ["quickfix"] },
  });
  let action = actions.find(({ title }) => title.includes("SpaceAroundOperators"));
  assert.ok(action, "RuboCop quick fix is missing");
  if (!action.edit) action = await client.request("codeAction/resolve", action);
  const corrected = applyEdits(code, editsFor(action.edit, fixture.uri));
  assert.ok(corrected.includes("value = 1"), "RuboCop quick fix did not update the code");
  await client.change(fixture.uri, corrected, 4);
  await client.waitFor(async () => {
    const after = await client.request("textDocument/diagnostic", { textDocument });
    return !after.items.some(({ code }) => code === "Layout/SpaceAroundOperators");
  }, "RuboCop diagnostic after applying edits");
  const refactorSource = "# frozen_string_literal: true\n\ndef example\n  1 + 2\nend\n";
  await client.change(fixture.uri, refactorSource, 5);
  const refactors = await client.request("textDocument/codeAction", {
    textDocument,
    range: { start: { line: 3, character: 2 }, end: { line: 3, character: 7 } },
    context: { diagnostics: [], only: ["refactor.extract"] },
  });
  const extraction = refactors.find(({ title }) => title === "Refactor: Extract Variable");
  assert.ok(extraction, "Ruby extract-variable action is missing");
  const resolved = await client.request("codeAction/resolve", extraction);
  const extracted = applyEdits(refactorSource, editsFor(resolved.edit, fixture.uri));
  assert.ok(extracted.includes("new_variable = 1 + 2"));
  return [
    "syntax diagnostics",
    "diagnostic clearing",
    "RuboCop diagnostics",
    "resolved quick-fix edits",
    "diagnostics after edits",
    "resolved extract-variable refactoring",
  ];
};
module.exports = { exerciseIntelligence, exerciseDiagnosticEdits, exerciseUnicodeRename };

if (require.main === module) {
  const { LiveLspClient } = require("./live-lsp-client");
  const { createProject, prepareProject, removeProject } = require("./project");
  const manifest = require("../../package.json");
  const values = {
    rubyPath: process.env.RUBY_LSP_RUBY_PATH,
    serverPath: process.env.RUBY_LSP_SERVER_PATH,
    inlayHints: { implicitRescue: true, implicitHashValue: true },
  };
  globalThis.lumine = {
    config: {
      get(key) {
        const field = key.slice(9);
        return Object.hasOwn(values, field) ? values[field] : manifest.configSchema[field]?.default;
      },
    },
  };
  let adapter;
  require("../../lib/main").consumeIde({
    registerAdapter(value) {
      adapter = value;
      return { dispose() {} };
    },
    reportMissingServer() {
      throw new Error("Ruby LSP missing");
    },
  });
  (async () => {
    for (const exercise of [exerciseIntelligence, exerciseDiagnosticEdits, exerciseUnicodeRename]) {
      const fixture = createProject(),
        client = new LiveLspClient(adapter, fixture.rootPath);
      try {
        await prepareProject(fixture, values.rubyPath, process.env.RUBY_LSP_GEM_HOME);
        const result = await client.start();
        console.log("CAPABILITIES", result.capabilities);
        console.log("COVERED", await exercise(client, fixture));
      } catch (error) {
        console.error(client.stderr);
        throw error;
      } finally {
        await client.stop();
        removeProject(fixture.rootPath);
      }
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
