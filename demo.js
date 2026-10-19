// Authentic package usage. Run with lumine/script/demo.js; fixtures stay in demo/.
module.exports = {
  version: 1,
  dependencies: [
    "language-ruby",
    "marker",
    "linter",
    "diagnostics",
    "documentation-view",
    "hover",
    "ide",
  ],
  viewport: { width: 1100, height: 490 },
  async before(context) {
    const { lumine, state, fixture } = context;
    for (const p of lumine.packages.getActivePackages())
      if (
        p.name.startsWith("ide-") &&
        p.name !== "ide-ruby" &&
        state.serverInstall?.[p.name]?.status !== "installing"
      )
        await lumine.packages.deactivatePackage(p.name);
    state.rubyGemfile = process.env.BUNDLE_GEMFILE;
    process.env.BUNDLE_GEMFILE = fixture("ide-ruby/Gemfile");
  },
  async prepare(context) {
    const { lumine, state, fixture, open } = context;
    state.editor = await open("ide-ruby/signal.rb");
    await lumine.project.setPaths([fixture("ide-ruby")]);
    lumine.grammars.assignLanguageMode(state.editor.getBuffer(), "source.ruby");
    await state.editor.getBuffer().getLanguageMode().ready;
    await state.editor.getBuffer().getLanguageMode().atGrammarSettlement?.();
  },
  scenes: [
    {
      id: "scene-1",
      file: "demo.png",
      caption: "Ruby LSP points out an unfinished method definition.",
      timeout: 60000,
      async run(context) {
        const { lumine, state } = context;
        {
          for (let n = 0; n < 60; n++) {
            if (
              [
                ...lumine.packages.getActivePackage("ide").mainModule.manager.sessions.values(),
              ].some((s) => s.adapter.id === "ide-ruby" && s.state === "running") &&
              lumine.packages
                .getActivePackage("linter")
                .mainModule.provideMcpTools()[0]
                .execute({ filePath: state.editor.getPath() })
                .messages.filter((m) => m.linterName === "Ruby LSP").length
            )
              break;
            await new Promise((r) => setTimeout(r, 500));
          }
          if (
            ![...lumine.packages.getActivePackage("ide").mainModule.manager.sessions.values()].some(
              (s) => s.adapter.id === "ide-ruby" && s.state === "running",
            )
          )
            throw new Error("The actual language server did not start");
          const messages = lumine.packages
            .getActivePackage("linter")
            .mainModule.provideMcpTools()[0]
            .execute({ filePath: state.editor.getPath() })
            .messages.filter((m) => m.linterName === "Ruby LSP");
          if (!messages.length) throw new Error("No diagnostic from the expected server");
          const message = messages.find((m) => m.severity === "error") || messages[0];
          state.evidence = {
            adapter: "ide-ruby",
            provider: message.linterName,
            diagnostic: message.excerpt,
          };
          state.editor.setCursorBufferPosition(message.range.start);
          state.editor.scrollToCursorPosition();
          lumine.views.getView(state.editor).focus();
        }
      },
      async afterPointerMove(context) {
        const { lumine, state } = context;
        await lumine.packages
          .getActivePackage("hover")
          .mainModule.getManager(lumine.workspace.getMainWindow())
          .showHoverOverlay(state.editor, state.editor.getCursorBufferPosition(), { gutter: true });
      },
      ready() {
        return Boolean(
          (() => {
            const e = document.querySelector("lumine-overlay.hover-overlay");
            const r = e?.getBoundingClientRect();
            return e?.innerText.includes("Ruby LSP") && r.top >= 36 && r.bottom <= innerHeight - 24;
          })(),
        );
      },
    },
  ],
  async cleanup(context) {
    const { state } = context;
    if (state.rubyGemfile === undefined) delete process.env.BUNDLE_GEMFILE;
    else process.env.BUNDLE_GEMFILE = state.rubyGemfile;
  },
};
