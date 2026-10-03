const childProcess = require("node:child_process");
const { resolveLiveRuntime } = require("./helpers/live-runtime");

describe("ide-ruby live test prerequisites", () => {
  it("does not treat a Ruby executable without language tools as a live environment", () => {
    spyOn(childProcess, "execFileSync").and.callFake(() => {
      throw Object.assign(new Error("cannot load such file -- ruby-lsp"), { status: 20 });
    });
    expect(resolveLiveRuntime({ RUBY_LSP_RUBY_PATH: "ruby" })).toBeNull();
    expect(() =>
      resolveLiveRuntime({ RUBY_LSP_RUBY_PATH: "ruby", REQUIRE_RUBY_LSP: "1" }),
    ).toThrowError(/CI requires Ruby, Bundler, Ruby LSP/);
  });

  it("requires a working Bundler command before starting the live fixtures", () => {
    spyOn(childProcess, "execFileSync").and.callFake((_command, args) => {
      if (args[0] === "-S")
        throw Object.assign(new Error("bundle command missing"), {
          status: 1,
          stderr: "ruby: No such file or directory -- bundle (LoadError)",
        });
      return JSON.stringify({ gemPaths: ["default-gems"], bindir: "ruby-bin" });
    });
    expect(resolveLiveRuntime({ RUBY_LSP_RUBY_PATH: "ruby" })).toBeNull();
    expect(() =>
      resolveLiveRuntime({ RUBY_LSP_RUBY_PATH: "ruby", REQUIRE_RUBY_MANAGED_INSTALL: "1" }),
    ).toThrowError(/CI requires Ruby, Bundler, Ruby LSP/);
  });

  it("keeps required integration runs strict when Ruby is absent", () => {
    expect(resolveLiveRuntime({ PATH: "" })).toBeNull();
    expect(() => resolveLiveRuntime({ PATH: "", REQUIRE_RUBY_LSP: "1" })).toThrowError(
      /CI requires Ruby, Bundler, Ruby LSP/,
    );
  });

  it("surfaces unexpected probe failures and timeouts instead of skipping live tests", () => {
    const execute = spyOn(childProcess, "execFileSync");
    for (const error of [new Error("unexpected Ruby failure"), { code: "ETIMEDOUT" }]) {
      execute.and.callFake(() => {
        throw error;
      });
      expect(() => resolveLiveRuntime({ RUBY_LSP_RUBY_PATH: "ruby" })).toThrow(error);
    }
    execute.and.returnValue("invalid JSON");
    expect(() => resolveLiveRuntime({ RUBY_LSP_RUBY_PATH: "ruby" })).toThrowError(SyntaxError);
  });

  it("checks Bundler in the same private gem environment used by the fixtures", () => {
    const execute = spyOn(childProcess, "execFileSync").and.returnValue(
      JSON.stringify({ gemPaths: ["default-gems"], bindir: "ruby-bin" }),
    );
    expect(
      resolveLiveRuntime({
        RUBY_LSP_RUBY_PATH: "ruby",
        RUBY_LSP_GEM_HOME: "private-gems",
        REQUIRE_RUBY_LSP: "1",
      }),
    ).toBe("ruby");
    const options = execute.calls.argsFor(1)[2];
    expect(options.env.GEM_HOME).toBe("private-gems");
    expect(options.env.GEM_PATH.split(require("node:path").delimiter)).toEqual([
      "private-gems",
      "default-gems",
    ]);
  });
});
