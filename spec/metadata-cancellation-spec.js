const path = require("node:path");
const fs = require("node:fs");

describe("Ruby metadata request lifetime", () => {
  let server, controller;
  const version = "0.26.8",
    metadata = { version, sha: "a".repeat(64) };
  const response = (data) => ({ ok: true, json: async () => data });
  function deferred() {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("ide-ruby");
    server = require("../lib/server");
    controller = new AbortController();
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("ide-ruby");
    await lumine.packages.deactivatePackage("ide");
  });
  it("does not fetch for an already cancelled API", async () => {
    const fetch = spyOn(global, "fetch").and.resolveTo(response(metadata));
    controller.abort(new Error("cancelled lookup"));
    await expectAsync(
      server.latestServerVersion({ signal: controller.signal }),
    ).toBeRejectedWithError("cancelled lookup");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects a fetch completing after cancellation", async () => {
    const held = deferred();
    spyOn(global, "fetch").and.returnValue(held.promise);
    const pending = server.latestServerVersion({ signal: controller.signal });
    controller.abort(new Error("cancelled fetch"));
    held.resolve(response(metadata));
    await expectAsync(pending).toBeRejectedWithError("cancelled fetch");
  });
  it("rejects a JSON body completing after cancellation", async () => {
    const held = deferred();
    let reading = false;
    spyOn(global, "fetch").and.resolveTo({
      ok: true,
      json() {
        reading = true;
        return held.promise;
      },
    });
    const pending = server.latestServerVersion({ signal: controller.signal });
    await conditionPromise(() => reading);
    controller.abort(new Error("cancelled body"));
    held.resolve(metadata);
    await expectAsync(pending).toBeRejectedWithError("cancelled body");
  });
  it("keeps the 30-second deadline through body parsing", async () => {
    const timeout = new AbortController(),
      held = deferred();
    let reading = false;
    const deadline = spyOn(AbortSignal, "timeout").and.returnValue(timeout.signal);
    spyOn(global, "fetch").and.resolveTo({
      ok: true,
      json() {
        reading = true;
        return held.promise;
      },
    });
    const pending = server.latestServerVersion({ signal: controller.signal });
    await conditionPromise(() => reading);
    timeout.abort(new Error("metadata deadline"));
    held.resolve(metadata);
    await expectAsync(pending).toBeRejectedWithError("metadata deadline");
    expect(deadline).toHaveBeenCalledOnceWith(30000);
  });
  it("preserves current HTTP/network and digest validation errors", async () => {
    const fetch = spyOn(global, "fetch").and.resolveTo({ ok: false, status: 503 });
    await expectAsync(
      server.latestServerVersion({ signal: controller.signal }),
    ).toBeRejectedWithError(/HTTP 503/);
    fetch.and.rejectWith(new Error("network offline"));
    await expectAsync(
      server.latestServerVersion({ signal: controller.signal }),
    ).toBeRejectedWithError("network offline");
    fetch.and.resolveTo(response({ version, sha: "bad" }));
    await expectAsync(
      server.latestServerVersion({ signal: controller.signal }),
    ).toBeRejectedWithError(/invalid/);
  });
  it("does not write staging or call transfers after gem metadata cancellation", async () => {
    const held = deferred();
    let reading = false;
    spyOn(server, "resolveRuby").and.resolveTo({
      data: {
        command: process.execPath,
        version: "3.3.0",
        gemPaths: [],
        bindir: "unused",
        abi: "3.3.0",
        platform: "fixture",
      },
    });
    spyOn(global, "fetch").and.resolveTo({
      ok: true,
      json() {
        reading = true;
        return held.promise;
      },
    });
    const mkdir = spyOn(fs.promises, "mkdir").and.resolveTo();
    const status = jasmine.createSpy("status").and.callFake(() => {
      if (controller.signal.aborted) throw new Error("expired API invoked");
    });
    const api = {
      signal: controller.signal,
      resolver: {},
      setServerInstallationStatus: status,
      downloadFile: jasmine.createSpy("download").and.resolveTo(),
    };
    const pending = server.installServer({
      version,
      api,
      storagePath: path.join(lumine.getConfigDirPath(), "unused-ruby-stage"),
    });
    await conditionPromise(() => reading);
    controller.abort(new Error("cancelled gem metadata"));
    held.resolve(metadata);
    await expectAsync(pending).toBeRejectedWithError("cancelled gem metadata");
    expect(mkdir).not.toHaveBeenCalled();
    expect(api.downloadFile).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalledWith("downloading");
  });
  for (const mode of ["caller cancellation", "adapter withdrawal"]) {
    it(`cancels real ManagedServers transport on ${mode}`, async () => {
      await lumine.packages.deactivatePackage("ide-ruby");
      const ide = (await lumine.packages.activatePackage("ide")).mainModule;
      await lumine.packages.activatePackage("ide-ruby");
      const managed = ide.ensureManagedServers(),
        held = deferred();
      let signal;
      spyOn(global, "fetch").and.callFake((_url, options) => {
        signal = options.signal;
        return held.promise;
      });
      const pending = managed.latestVersion(managed.adapterFor("ide-ruby"), {
        force: true,
        signal: controller.signal,
      });
      await conditionPromise(() => signal);
      if (mode === "caller cancellation") controller.abort();
      else await lumine.packages.deactivatePackage("ide-ruby");
      await expectAsync(pending).toBeRejected();
      expect(signal.aborted).toBe(true);
      held.resolve(response(metadata));
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
      expect(managed.latest.has("ide-ruby")).toBe(false);
    });
  }
});
