const server = require("./server");
const setting = (key) => lumine.config.get(`ide-ruby.${key}`);

module.exports = {
  consumeIdeClient(service) {
    return service.registerAdapter({
      id: "ide-ruby",
      displayName: "Ruby LSP",
      grammarScopes: ["source.ruby"],
      languageId: "ruby",
      sessionScope: "project-root",
      restartKeyPaths: [
        "ide-ruby.rubyPath",
        "ide-ruby.serverPath",
        "ide-ruby.formatter",
        "ide-ruby.linters",
        "ide-ruby.inlayHints",
      ],
      // Ruby LSP test lenses call editor-specific commands rather than LSP commands.
      features: { codeLens: false },
      transformServerCapabilities(capabilities) {
        return { ...capabilities, codeLensProvider: false };
      },
      managedServerDisplayName: "Ruby LSP",
      latestServerVersion: server.latestServerVersion,
      installServer(context) {
        return server.installServer(context, { rubyPath: setting("rubyPath") });
      },
      async resolveServer(context) {
        const launch = await server.resolveServer(context, {
          rubyPath: setting("rubyPath"),
          serverPath: setting("serverPath"),
        });
        if (!launch)
          service.reportMissingServer("ide-ruby", {
            description:
              "Install [Ruby](https://www.ruby-lang.org/en/downloads/) and the `ruby-lsp` gem, or select Ruby Path in the ide-ruby settings. Once Ruby is available, Manage Servers can install Ruby LSP for you.",
          });
        return launch;
      },
      getInitializationOptions() {
        const linters = setting("linters");
        return {
          enabledFeatures: { codeLens: false },
          formatter: setting("formatter"),
          ...(linters?.length ? { linters } : {}),
          featuresConfiguration: { inlayHint: setting("inlayHints") },
        };
      },
    });
  },
  provideBackgroundTips() {
    return {
      packageName: "ide-ruby",
      tips: [
        "Ruby LSP uses your project's Gemfile.lock to index the exact gems you use. Add RuboCop or Syntax Tree to the project bundle to enable formatting.",
      ],
    };
  },
};
