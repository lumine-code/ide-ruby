const fs = require("node:fs");
const path = require("node:path");
const { createProject, removeProject } = require("./helpers/project");

describe("ide-ruby adapter registration and configuration", () => {
  let main, adapter, registration, cleanup;
  beforeEach(async () => {
    main = (await lumine.packages.activatePackage("ide-ruby")).mainModule;
    cleanup = jasmine.createSpy("unregister");
    registration = main.consumeIdeClient({
      registerAdapter(value) {
        adapter = value;
        return { dispose: cleanup };
      },
      reportMissingServer() {},
    });
  });
  afterEach(async () => {
    registration.dispose();
    for (const key of ["rubyPath", "serverPath", "formatter", "linters", "inlayHints"])
      lumine.config.unset(`ide-ruby.${key}`);
    await lumine.packages.deactivatePackage("ide-ruby");
  });
  it("returns the service's disposable and registers one project-root Ruby adapter", () => {
    expect(adapter.id).toBe("ide-ruby");
    expect(adapter.grammarScopes).toEqual(["source.ruby"]);
    expect(adapter.languageId).toBe("ruby");
    expect(adapter.sessionScope).toBe("project-root");
    registration.dispose();
    expect(cleanup).toHaveBeenCalled();
  });
  it("matches Ruby LSP defaults and suppresses unsupported editor-command lenses", () => {
    const options = adapter.getInitializationOptions();
    expect(options.formatter).toBe("auto");
    expect(options.linters).toBeUndefined();
    expect(options.featuresConfiguration.inlayHint).toEqual({
      implicitRescue: false,
      implicitHashValue: false,
    });
    expect(options.enabledFeatures.codeLens).toBe(false);
    expect(
      adapter.transformServerCapabilities({ codeLensProvider: {}, hoverProvider: true }),
    ).toEqual({ codeLensProvider: false, hoverProvider: true });
    const features = require("../package.json").configSchema.features.properties;
    expect(features.codeLens).toBeUndefined();
    expect(features.callHierarchy).toBeUndefined();
  });
  it("reads formatter, linter and inlay options at restart preparation time", () => {
    lumine.config.set("ide-ruby.formatter", "syntax_tree");
    lumine.config.set("ide-ruby.linters", ["rubocop_internal"]);
    lumine.config.set("ide-ruby.inlayHints.implicitRescue", true);
    const options = adapter.getInitializationOptions();
    expect(options.formatter).toBe("syntax_tree");
    expect(options.linters).toEqual(["rubocop_internal"]);
    expect(options.featuresConfiguration.inlayHint.implicitRescue).toBe(true);
  });
  it("reports a missing server through the hub", async () => {
    const server = require("../lib/server"),
      reportMissingServer = jasmine.createSpy("missing");
    spyOn(server, "resolveServer").and.resolveTo(null);
    const disposable = main.consumeIdeClient({
      registerAdapter(value) {
        adapter = value;
        return { dispose() {} };
      },
      reportMissingServer,
    });
    expect(await adapter.resolveServer({ rootPath: process.cwd() })).toBeNull();
    expect(reportMissingServer).toHaveBeenCalled();
    disposable.dispose();
  });
  it("provides a manifest-named tip describing the project bundle", () => {
    const provider = main.provideBackgroundTips();
    expect(provider.packageName).toBe("ide-ruby");
    expect(provider.tips.length).toBe(1);
    expect(provider.tips[0]).toContain("Gemfile.lock");
  });
});

describe("ide-ruby runtime and gem environment", () => {
  let fixture, server;
  beforeEach(async () => {
    jasmine.useRealClock();
    fixture = createProject();
    await lumine.packages.activatePackage("ide-ruby");
    server = require("../lib/server");
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("ide-ruby");
    removeProject(fixture.rootPath);
  });
  it("skips directories on PATH", () => {
    fs.mkdirSync(path.join(fixture.rootPath, "ruby"));
    expect(server.findOnPath("ruby", { PATH: fixture.rootPath })).toBeNull();
  });
  it("rejects invalid explicit paths", async () => {
    await expectAsync(server.resolveRuby(fixture.rootPath)).toBeRejectedWithError(/file/);
    await expectAsync(server.resolveRuby(path.join(fixture.rootPath, "missing"))).toBeRejected();
  });
  it("prepends private gems and runtime bins while preserving all dependency paths", () => {
    const env = {
        PATH: "project-bin",
        GEM_PATH: "project-gems",
        GEM_HOME: "user-gems",
        BUNDLE_PATH: "vendor/bundle",
      },
      snapshot = { ...env };
    const overrides = server.gemEnvironment(
      { bindir: "ruby-bin", gemPaths: ["user-gems", "default-gems"] },
      "managed",
      env,
    );
    expect(overrides.GEM_HOME).toBe("managed");
    expect(overrides.GEM_PATH.split(path.delimiter)).toEqual([
      "managed",
      "project-gems",
      "user-gems",
      "default-gems",
    ]);
    expect(overrides.PATH.split(path.delimiter)).toEqual([
      "ruby-bin",
      path.join("managed", "bin"),
      "project-bin",
    ]);
    expect(env).toEqual(snapshot);
    expect(overrides.BUNDLE_PATH).toBeUndefined();
  });
  it("retains user gem environment when using an explicit or discovered server", () => {
    expect(
      server.gemEnvironment({ bindir: "ruby-bin", gemPaths: ["user-gems"] }, "", { PATH: "bin" }),
    ).toEqual({ PATH: `ruby-bin${path.delimiter}bin` });
  });
  it("returns no launch when Ruby is missing", async () => {
    spyOn(server, "resolveRuby").and.resolveTo(null);
    expect(await server.resolveServer({ rootPath: fixture.rootPath })).toBeNull();
  });
  if (process.env.RUBY_LSP_RUBY_PATH)
    it("validates the real runtime against a numeric project Ruby version", async () => {
      const ruby = await server.resolveRuby(process.env.RUBY_LSP_RUBY_PATH, fixture.rootPath);
      expect(ruby.version).toMatch(/^\d+\.\d+\.\d+/);
      fs.writeFileSync(path.join(fixture.rootPath, ".ruby-version"), ruby.version);
      expect((await server.resolveRuby(process.env.RUBY_LSP_RUBY_PATH, fixture.rootPath)).abi).toBe(
        ruby.abi,
      );
      fs.writeFileSync(path.join(fixture.rootPath, ".ruby-version"), "99.0.0");
      await expectAsync(
        server.resolveRuby(process.env.RUBY_LSP_RUBY_PATH, fixture.rootPath),
      ).toBeRejectedWithError(/project requires Ruby 99/);
    }, 30000);
  it("refuses native gems built for a different Ruby ABI", async () => {
    const gemHome = path.join(fixture.rootPath, "managed");
    fs.mkdirSync(path.join(gemHome, "bin"), { recursive: true });
    fs.writeFileSync(
      path.join(gemHome, "ruby-runtime.json"),
      JSON.stringify({ abi: "3.3.0", platform: "x64-mingw-ucrt" }),
    );
    spyOn(server, "resolveRuby").and.resolveTo({
      command: process.execPath,
      abi: "3.4.0",
      platform: "x64-mingw-ucrt",
      version: "3.4.11",
    });
    await expectAsync(
      server.resolveServer({
        rootPath: fixture.rootPath,
        managedServer: { modulePath: path.join(gemHome, "bin", "ruby-lsp") },
      }),
    ).toBeRejectedWithError(/Reinstall/);
  });
});
