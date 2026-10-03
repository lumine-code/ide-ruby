const { resolveLiveRuntime } = require("./helpers/live-runtime");
const { LiveLspClient } = require("./helpers/live-lsp-client");
const { createProject, prepareProject, removeProject, position } = require("./helpers/project");
const {
  exerciseIntelligence,
  exerciseDiagnosticEdits,
  exerciseUnicodeRename,
} = require("./helpers/exercise-server");
const runtime = resolveLiveRuntime();
const liveSuite = runtime ? describe : xdescribe;

liveSuite("ide-ruby real Ruby LSP protocol", () => {
  let fixture, client, registration;
  beforeEach(async () => {
    jasmine.useRealClock();
    fixture = createProject();
    const main = (await lumine.packages.activatePackage("ide-ruby")).mainModule;
    lumine.config.set("ide-ruby.rubyPath", runtime);
    if (process.env.RUBY_LSP_SERVER_PATH)
      lumine.config.set("ide-ruby.serverPath", process.env.RUBY_LSP_SERVER_PATH);
    lumine.config.set("ide-ruby.inlayHints", { implicitRescue: true, implicitHashValue: true });
    await prepareProject(fixture, runtime, process.env.RUBY_LSP_GEM_HOME);
    registration = main.consumeIdeClient({
      registerAdapter(adapter) {
        client = new LiveLspClient(adapter, fixture.rootPath);
        return { dispose() {} };
      },
      reportMissingServer() {
        throw new Error("Real Ruby LSP missing");
      },
    });
    const result = await client.start();
    if (process.env.RUBY_LSP_VERSION)
      expect(result.serverInfo.version).toBe(process.env.RUBY_LSP_VERSION);
    expect(result.capabilities.codeLensProvider).toBeUndefined();
    expect(result.capabilities.callHierarchyProvider).toBeUndefined();
  }, 180000);
  afterEach(async () => {
    await client?.stop();
    registration?.dispose();
    for (const key of ["rubyPath", "serverPath", "inlayHints"])
      lumine.config.unset(`ide-ruby.${key}`);
    await lumine.packages.deactivatePackage("ide-ruby");
    removeProject(fixture.rootPath);
  }, 30000);
  it("serves real language features and indexes a project-local bundled gem", async () => {
    const covered = await exerciseIntelligence(client, fixture);
    expect(covered).toContain("project bundle dependency indexing");
    expect(covered).toContain("supertypes");
  }, 90000);
  it("updates syntax and RuboCop diagnostics and applies a resolved fix", async () => {
    expect(await exerciseDiagnosticEdits(client, fixture)).toContain("diagnostics after edits");
  }, 90000);
  it("uses UTF-16 positions for constant references and rename after emoji", async () => {
    const covered = await exerciseUnicodeRename(client, fixture);
    expect(covered).toContain("UTF-16 rename edits");
    expect(covered).toContain("unchanged ASCII ranges");
    expect(covered).toContain("closed-file UTF-16 references and edits");
  }, 90000);
  it("leaves Prism byte columns unchanged when a separate client negotiates UTF-8", async () => {
    await client.stop();
    client.positionEncodings = ["utf-8"];
    const result = await client.start();
    expect(result.capabilities.positionEncoding).toBe("utf-8");
    client.open(fixture.uri, "ruby", fixture.text);
    await client.waitFor(
      async () => (await client.request("workspace/symbol", { query: "Calculator" })).length > 1,
      "UTF-8 Ruby indexing",
    );
    const start = position(fixture.text, "Calculator.add(4, 5)");
    const line = fixture.text.split("\n")[start.line];
    const character = Buffer.byteLength(line.slice(0, start.character), "utf8");
    const prepared = await client.request("textDocument/prepareRename", {
      textDocument: { uri: fixture.uri },
      position: { line: start.line, character: character + 1 },
    });
    expect(prepared.start.character).toBe(character);
    expect(prepared.end.character).toBe(character + 10);
  }, 90000);
  if (process.env.REQUIRE_RUBY_MANAGED_INSTALL)
    it("installs verified gems into fresh staging and launches the actual managed copy", async () => {
      await client.stop();
      const managed = createProject();
      try {
        await lumine.packages.activatePackage("ide-client");
        const service = lumine.packages
          .getActivePackage("ide-client")
          .mainModule.provideIdeClient();
        await service.uninstallServer("ide-ruby");
        const installed = await service.installServer("ide-ruby", {
          version: process.env.RUBY_LSP_VERSION || "0.26.11",
        });
        expect(installed.version).toBe(process.env.RUBY_LSP_VERSION || "0.26.11");
        const managedServer = service.managedServer("ide-ruby");
        expect(managedServer.modulePath).toBeTruthy();
        lumine.config.set("ide-ruby.serverPath", "");
        await client.start(managedServer);
        client.open(fixture.uri, "ruby", fixture.text);
        const symbols = await client.request("textDocument/documentSymbol", {
          textDocument: { uri: fixture.uri },
        });
        expect(symbols.some(({ name }) => name === "Calculator")).toBe(true);
      } finally {
        await client.stop();
        const service = lumine.packages
          .getActivePackage("ide-client")
          ?.mainModule.provideIdeClient();
        await service?.uninstallServer("ide-ruby");
        await lumine.packages.deactivatePackage("ide-client");
        removeProject(managed.rootPath);
      }
    }, 600000);
});
