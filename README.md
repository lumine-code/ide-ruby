# ide-ruby

Provide Ruby language intelligence through Ruby LSP.

The adapter connects [Shopify's Ruby LSP](https://shopify.github.io/ruby-lsp/) to ide-client. Ruby LSP uses the selected Ruby runtime and the project's locked gems; the editor supplies the language feature interfaces.

## Features

- **Intelligence**: method completion, documentation, signatures, definitions and document or workspace symbols.
- **Navigation**: constant references and rename, superclass and mixin hierarchy, folding and selection ranges.
- **Diagnostics**: syntax errors and linter diagnostics from integrations in the project bundle.
- **Formatting**: document, range and on-type formatting where the selected formatter supports them, plus code actions and refactorings.
- **Annotations**: semantic highlighting and optional hints for implicit rescue classes or shorthand hash values.
- **Managed server**: verified Ruby LSP gem downloads and a private native gem installation for the selected Ruby ABI.

## Installation

Install ide-ruby, ide-client and language-ruby from the editor's Install tab. Install [Ruby 3.0 or newer](https://www.ruby-lang.org/en/downloads/) and make the project's runtime available on PATH, or set **Ruby Path** to its executable. On Windows, RubyInstaller with its Devkit provides the compiler needed by native gem dependencies.

Use **Manage Servers** to install Ruby LSP, or run `gem install ruby-lsp`. **Server Path** can select an existing Ruby `ruby-lsp` executable script; select the file without `.bat` or `.cmd`. An explicit script wins over the managed copy, followed by Ruby LSP installed in the selected runtime's gems.

## Usage

Open a project folder and a Ruby file. Run `bundle install` when the project has a Gemfile: Ruby LSP requires its Gemfile.lock. The adapter launches the official executable without `bundle exec`, so Ruby LSP can compose `.ruby-lsp/Gemfile` using the project's locked dependency versions. Its generated directory is automatically ignored. Existing `GEM_PATH`, project Bundler settings, version-manager environment and Ruby options remain available to the server. An explicitly inherited `BUNDLE_GEMFILE` keeps Ruby LSP in that selected bundle, as its executable specifies.

Use the editor's IDE commands for navigation, rename, formatting and code actions. Add RuboCop or Syntax Tree to the project Gemfile for formatting. **Formatter** defaults to upstream automatic detection; **Linters** defaults to detection from the same project bundle. Standard and Rubyfmt need their corresponding Ruby LSP integrations. Both implicit inlay hints default to off, matching Ruby LSP.

The adapter checks a numeric `.ruby-version` against the selected runtime. Activate the project's version manager before starting the editor, or select its Ruby explicitly. A managed installation records the Ruby ABI and platform; reinstall it after switching to an incompatible Ruby. Ruby LSP may defer references, rename and workspace symbols when it detects Sorbet.

Ruby LSP has no call hierarchy and its type hierarchy currently resolves ancestors, not subtypes. Its test lenses name `rubyLsp.runTest`, `rubyLsp.runTestInTerminal` and `rubyLsp.debugTest` client commands; this adapter disables those lenses because the editor does not implement their execution contract. Custom test discovery and bundle composition requests are not exposed as commands.

Ruby LSP 0.26.x returns byte columns from some Prism range helpers despite negotiating UTF-16. The adapter preloads a narrow server-side correction for those helpers, so references, rename and workspace edits remain correct after non-ASCII characters, including in closed files. Existing Ruby options and load paths are preserved; later server versions use their own helpers.

## Development

Run `npm ci`, `npm run lint`, `npm run format:check`, `npm audit --audit-level=high` and `npm pack --dry-run`. Run `lumine --test spec` for the editor suite. The real protocol and editor tests require Ruby LSP 0.26.11 and RuboCop 1.91.0; set `REQUIRE_RUBY_LSP=1` to make missing prerequisites fail, and `REQUIRE_RUBY_MANAGED_INSTALL=1` to exercise a fresh managed installation. Optional `RUBY_LSP_RUBY_PATH`, `RUBY_LSP_SERVER_PATH` and `RUBY_LSP_GEM_HOME` select isolated test runtimes. CI provisions the package service dependencies explicitly and runs the same tests against Linux Lumine.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
