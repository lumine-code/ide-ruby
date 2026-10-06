const { resolutionContext, findOnPath } = require("./helpers/server-resolution");
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
    expect(findOnPath("ruby", { PATH: fixture.rootPath })).toBeNull();
  });
  it("rejects invalid explicit paths", async () => {
    await expectAsync(
      server.resolveRuby(resolutionContext({}), fixture.rootPath),
    ).toBeRejectedWithError(/file/);
    await expectAsync(
      server.resolveRuby(resolutionContext({}), path.join(fixture.rootPath, "missing")),
    ).toBeRejected();
  });
  it("tries later Ruby runtimes after a discovered runtime fails its project validation", async () => {
    const folders = ["old-ruby", "project-ruby"].map((name) => path.join(fixture.rootPath, name));
    const native = process.platform === "win32" ? "ruby.exe" : "ruby";
    for (const folder of folders) {
      fs.mkdirSync(folder);
      fs.copyFileSync(process.execPath, path.join(folder, native));
      fs.chmodSync(path.join(folder, native), 0o755);
    }
    spyOn(server, "probeRuby").and.callFake(async (command) => {
      if (command.startsWith(folders[0])) throw new Error("Project requires Ruby 3.4");
      return { command, version: "3.4.11" };
    });
    const env = { PATH: folders.join(path.delimiter) };
    const context = resolutionContext({ rootPath: fixture.rootPath });
    expect((await server.resolveRuby(context, "", env)).path).toBe(path.join(folders[1], native));
    await expectAsync(
      server.resolveRuby(context, path.join(folders[0], native)),
    ).toBeRejectedWithError(/Project requires Ruby/);
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
    expect(
      await server.resolveServer(resolutionContext({ rootPath: fixture.rootPath }), {}),
    ).toBeNull();
  });
  if (process.env.RUBY_LSP_RUBY_PATH)
    it("validates the real runtime against a numeric project Ruby version", async () => {
      const ruby =
        (
          await server.resolveRuby(
            resolutionContext({ rootPath: fixture.rootPath }),
            process.env.RUBY_LSP_RUBY_PATH,
          )
        )?.data ?? null;
      expect(ruby.version).toMatch(/^\d+\.\d+\.\d+/);
      fs.writeFileSync(path.join(fixture.rootPath, ".ruby-version"), ruby.version);
      expect(
        (
          (
            await server.resolveRuby(
              resolutionContext({ rootPath: fixture.rootPath }),
              process.env.RUBY_LSP_RUBY_PATH,
            )
          )?.data ?? null
        ).abi,
      ).toBe(ruby.abi);
      fs.writeFileSync(path.join(fixture.rootPath, ".ruby-version"), "99.0.0");
      await expectAsync(
        server.resolveRuby(
          resolutionContext({ rootPath: fixture.rootPath }),
          process.env.RUBY_LSP_RUBY_PATH,
        ),
      ).toBeRejectedWithError(/project requires Ruby 99/);
    }, 30000);
  it("refuses native gems built for a different Ruby ABI", async () => {
    const gemHome = path.join(fixture.rootPath, "managed");
    fs.mkdirSync(path.join(gemHome, "bin"), { recursive: true });
    fs.writeFileSync(path.join(gemHome, "bin", "ruby-lsp"), "# managed script\n");
    fs.writeFileSync(
      path.join(gemHome, "ruby-runtime.json"),
      JSON.stringify({ abi: "3.3.0", platform: "x64-mingw-ucrt" }),
    );
    spyOn(server, "resolveRuby").and.resolveTo({
      path: process.execPath,
      kind: "executable",
      data: {
        command: process.execPath,
        abi: "3.4.0",
        platform: "x64-mingw-ucrt",
        version: "3.4.11",
      },
    });
    await expectAsync(
      server.resolveServer(
        resolutionContext({
          rootPath: fixture.rootPath,
          managedServer: { modulePath: path.join(gemHome, "bin", "ruby-lsp") },
        }),
        {},
      ),
    ).toBeRejectedWithError(/Reinstall/);
  });
  it("uses an explicit script without reading a corrupt managed installation", async () => {
    const script = path.join(fixture.rootPath, "ruby-lsp");
    fs.writeFileSync(script, "# configured Ruby script\n");
    const getManagedServer = jasmine
      .createSpy("getManagedServer")
      .and.throwError("Corrupt managed record");
    const resolver = resolutionContext().resolver;
    const select = resolver.select;
    spyOn(resolver, "select").and.callFake(async (options) => {
      const selected = await select(options);
      expect(selected.source).toBe("configured");
      expect(selected.data.gemHome).toBe("");
      throw new Error("Selected configured script");
    });
    spyOn(server, "resolveRuby").and.resolveTo({
      path: process.execPath,
      kind: "executable",
      data: {},
    });
    const context = resolutionContext({ ...fixture, getManagedServer, resolver });
    await expectAsync(server.resolveServer(context, { serverPath: script })).toBeRejectedWithError(
      "Selected configured script",
    );
    expect(getManagedServer).not.toHaveBeenCalled();
    await expectAsync(server.resolveServer(context)).toBeRejectedWithError(
      "Corrupt managed record",
    );
  });
});
