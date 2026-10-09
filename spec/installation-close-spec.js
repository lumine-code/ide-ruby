const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

describe("Ruby installation process retirement", () => {
  let server, directory, child, complete;
  beforeEach(async () => {
    await lumine.packages.deactivatePackage("ide-ruby");
    if (lumine.packages.isPackageLoaded("ide-ruby"))
      await lumine.packages.unloadPackage("ide-ruby");
    child = new EventEmitter();
    spyOn(childProcess, "execFile").and.callFake((_command, _args, _options, callback) => {
      complete = callback;
      return child;
    });
    spyOn(global, "fetch").and.resolveTo({
      ok: true,
      json: async () => ({ version: "0.26.11", sha: "a".repeat(64) }),
    });
    await lumine.packages.activatePackage("ide-ruby");
    server = require("../lib/server");
    spyOn(server, "resolveRuby").and.resolveTo({
      data: {
        command: "controlled-ruby",
        gemPaths: [],
        abi: "3.4.0",
        platform: "controlled-platform",
        version: "3.4.1",
      },
    });
    directory = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "ruby-install-close-")),
    );
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("ide-ruby");
    const relative = path.relative(fs.realpathSync.native(os.tmpdir()), directory);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("Unsafe Ruby fixture cleanup");
    await fs.promises.rm(directory, { recursive: true, force: true });
  });
  function task(signal) {
    return {
      storagePath: directory,
      signal,
      api: {
        signal,
        resolver: {},
        setServerInstallationStatus() {},
        downloadFile: async (_url, target) =>
          fs.promises.writeFile(target, "Controlled gem payload"),
      },
    };
  }
  it("keeps the staging operation pending until a cancelled gem process closes", async () => {
    const controller = new AbortController();
    const reason = new Error("Ruby installation cancelled");
    let settled = false;
    const pending = server.installServer(task(controller.signal));
    const observed = pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await conditionPromise(() => childProcess.execFile.calls.any());
    controller.abort(reason);
    complete(reason, "", "");
    try {
      await new Promise(setImmediate);
      expect(settled).toBe(false);
      expect(fs.existsSync(path.join(directory, "ruby-lsp-0.26.11.gem"))).toBe(true);
    } finally {
      child.emit("close", null, "SIGTERM");
      await observed;
    }
    await expectAsync(pending).toBeRejectedWith(reason);
  });
  it("publishes the current ABI record and retires the gem archive after a successful process", async () => {
    const pending = server.installServer(task(new AbortController().signal));
    await conditionPromise(() => childProcess.execFile.calls.any());
    complete(null, "", "");
    child.emit("close", 0, null);
    expect(await pending).toEqual({ version: "0.26.11", module: path.join("bin", "ruby-lsp") });
    expect(JSON.parse(fs.readFileSync(path.join(directory, "ruby-runtime.json"), "utf8"))).toEqual({
      abi: "3.4.0",
      platform: "controlled-platform",
      version: "3.4.1",
    });
    expect(fs.existsSync(path.join(directory, "ruby-lsp-0.26.11.gem"))).toBe(false);
  });
});
