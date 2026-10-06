const { createProject, prepareProject, removeProject, position } = require("./helpers/project");
const { resolveLiveRuntime } = require("./helpers/live-runtime");
const runtime = resolveLiveRuntime();
const liveSuite = runtime ? describe : xdescribe;
const until = async (check, label) => {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} timed out`);
};

liveSuite("ide-ruby actual editor service routing", () => {
  let fixture, editor, paths, service;
  beforeEach(async () => {
    jasmine.useRealClock();
    fixture = createProject();
    paths = lumine.project.getPaths();
    await prepareProject(fixture, runtime, process.env.RUBY_LSP_GEM_HOME);
    lumine.config.set("ide-ruby.rubyPath", runtime);
    if (process.env.RUBY_LSP_SERVER_PATH)
      lumine.config.set("ide-ruby.serverPath", process.env.RUBY_LSP_SERVER_PATH);
    for (const name of ["language-ruby", "ide-client", "ide-ruby"])
      await lumine.packages.activatePackage(name);
    service = lumine.packages.getActivePackage("ide-client").mainModule.provideIdeClient();
    lumine.project.setPaths([fixture.rootPath]);
    editor = await lumine.workspace.open(fixture.filePath);
    editor.setGrammar(lumine.grammars.grammarForScopeName("source.ruby"));
  }, 180000);
  afterEach(async () => {
    editor?.destroy();
    for (const name of ["ide-ruby", "ide-client", "language-ruby"])
      await lumine.packages.deactivatePackage(name);
    for (const key of ["rubyPath", "serverPath", "features.format"])
      lumine.config.unset(`ide-ruby.${key}`);
    lumine.project.setPaths(paths);
    await lumine.fileWatchClient.settlePendingTeardown();
    removeProject(fixture.rootPath);
  }, 30000);
  const sessionFor = () =>
    until(
      async () =>
        (await service.activeSessionsForEditor(editor)).find(
          ({ adapter }) => adapter.id === "ide-ruby",
        ),
      "Ruby session",
    );
  it("auto-registers, routes real completions and formatting, and honors feature switches", async () => {
    const session = await sessionFor(),
      main = lumine.packages.getActivePackage("ide-client").mainModule;
    expect(service.adaptersForEditor(editor).filter(({ id }) => id === "ide-ruby").length).toBe(1);
    expect(session.supports("textDocument/codeLens", editor)).toBe(false);
    expect(session.supports("textDocument/prepareCallHierarchy", editor)).toBe(false);
    await until(
      async () => (await session.request("workspace/symbol", { query: "Calculator" })).length > 1,
      "Ruby indexing",
    );
    const point = position(fixture.text, "Calculator.add(1, 2)", 13);
    const suggestions = await main.provideAutocomplete().getSuggestions({
      editor,
      bufferPosition: new (require("lumine").Point)(point.line, point.character),
      prefix: "ad",
      activatedManually: true,
    });
    expect(
      suggestions.some((item) =>
        (item.displayText || item.text || item.snippet || "").startsWith("add"),
      ),
    ).toBe(true);
    const formatter = main.provideCodeFormatFile();
    expect((await formatter.formatEntireFile(editor)).length).toBeGreaterThan(0);
    lumine.config.set("ide-ruby.features.format", false);
    expect(
      await service.activeSessionForFeature(editor, "textDocument/formatting", "format"),
    ).toBeNull();
    expect(await formatter.formatEntireFile(editor)).toBeNull();
    lumine.config.set("ide-ruby.features.format", true);
    expect(await service.activeSessionForFeature(editor, "textDocument/formatting", "format")).toBe(
      session,
    );
  }, 180000);
  it("stops an unloaded generation and acquires a fresh module and process", async () => {
    const previous = await sessionFor(),
      oldPackage = lumine.packages.getActivePackage("ide-ruby"),
      oldMain = oldPackage.mainModule,
      packagePath = oldPackage.path;
    await lumine.packages.deactivatePackage("ide-ruby");
    await until(() => previous.state === "stopped", "Ruby teardown");
    await lumine.packages.unloadPackage("ide-ruby");
    await lumine.packages.loadPackage(packagePath);
    const main = (await lumine.packages.activatePackage("ide-ruby")).mainModule;
    expect(main).not.toBe(oldMain);
    const renewed = await sessionFor();
    expect(renewed).not.toBe(previous);
    const hovered = await until(
      () =>
        renewed.request("textDocument/hover", {
          textDocument: { uri: fixture.uri },
          position: position(fixture.text, "Calculator.add(1, 2)", 12),
        }),
      "reloaded Ruby hover",
    );
    expect(JSON.stringify(hovered)).toContain("Add two values");
  }, 180000);
  it("applies actual server rename edits after emoji to editor buffers and a closed file", async () => {
    const session = await sessionFor();
    await until(
      async () => (await session.request("workspace/symbol", { query: "Calculator" })).length > 1,
      "Ruby indexing before rename",
    );
    const rename = await session.request("textDocument/rename", {
      textDocument: { uri: fixture.uri },
      position: position(fixture.text, "Calculator.add(4, 5)", 1),
      newName: "Arithmetic",
    });
    const result = await service.applyWorkspaceEdit(rename, "Rename Ruby constant");
    expect(result).toBe(true);
    expect(editor.getText()).toContain('unicode = "😀"; result = Arithmetic.add(4, 5)');
    const linked = await lumine.workspace.open(fixture.linkedPath);
    expect(linked.getText()).toContain('marker = "😀"; object = Arithmetic');
    linked.destroy();
  }, 180000);
});
