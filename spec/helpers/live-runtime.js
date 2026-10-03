const childProcess = require("node:child_process");

// Finding Ruby alone does not make the live suite runnable. Hosted runners may
// ship Ruby without Bundler or the language tools, including their native gems.
const prerequisites = `require 'json'; require 'rbconfig'; require 'rubygems'
if Gem::Version.new(RUBY_VERSION) < Gem::Version.new('3.0')
  warn 'Ruby LSP requires Ruby 3.0 or newer.'
  exit 20
end
if (home = ENV['RUBY_LSP_GEM_HOME']) && !home.empty?
  Gem.paths = { 'GEM_HOME' => home, 'GEM_PATH' => ([home] + Gem.path).uniq.join(File::PATH_SEPARATOR) }
end
begin
  gem 'ruby-lsp', ENV['RUBY_LSP_VERSION'] if ENV['RUBY_LSP_VERSION']
  gem 'rubocop', ENV.fetch('RUBY_RUBOCOP_VERSION', '1.91.0')
  require 'bundler'; require 'ruby-lsp'; require 'rubocop'
rescue LoadError => error
  warn error.message
  exit 20
end
puts JSON.generate({ gemPaths: Gem.path, bindir: RbConfig::CONFIG['bindir'] })`;

exports.resolveLiveRuntime = (env = process.env) => {
  const server = require("../../lib/server");
  const runtime = env.RUBY_LSP_RUBY_PATH || server.findOnPath("ruby", env);
  const required = env.REQUIRE_RUBY_LSP || env.REQUIRE_RUBY_MANAGED_INSTALL;
  const message = "CI requires Ruby, Bundler, Ruby LSP and the fixture's RuboCop gems.";
  if (!runtime) {
    if (required) throw new Error(message);
    return null;
  }
  try {
    const options = {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 15000,
    };
    const ruby = JSON.parse(childProcess.execFileSync(runtime, ["-e", prerequisites], options));
    childProcess.execFileSync(runtime, ["-S", "bundle", "--version"], {
      ...options,
      env: { ...env, ...server.gemEnvironment(ruby, env.RUBY_LSP_GEM_HOME, env) },
    });
    return runtime;
  } catch (error) {
    const missing =
      error.code === "ENOENT" ||
      error.status === 20 ||
      (error.status === 1 &&
        /No such file or directory -- bundle \(LoadError\)/.test(String(error.stderr)));
    if (!missing) throw error;
    if (required) throw new Error(message, { cause: error });
    return null;
  }
};
