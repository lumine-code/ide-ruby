const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const runFile = promisify(execFile);
const rubyInfo = `require 'json'; require 'rbconfig'; require 'rubygems'; puts JSON.generate({version: RUBY_VERSION, abi: RbConfig::CONFIG['ruby_version'], platform: RUBY_PLATFORM, gemPaths: Gem.path, bindir: RbConfig::CONFIG['bindir']})`;

exports.probeRuby = async (command, rootPath = process.cwd(), env = process.env, signal) => {
  const { stdout } = await runFile(command, ["-e", rubyInfo], {
    cwd: rootPath,
    env,
    windowsHide: true,
    timeout: 15000,
    signal,
  });
  const info = JSON.parse(stdout.trim());
  if (Number(info.version.split(".")[0]) < 3)
    throw new Error("Ruby LSP requires Ruby 3.0 or newer.");
  const versionFile = path.join(rootPath, ".ruby-version");
  if (fs.existsSync(versionFile)) {
    const expected = fs
      .readFileSync(versionFile, "utf8")
      .trim()
      .replace(/^ruby-/, "");
    if (
      /^\d+(?:\.\d+){0,2}$/.test(expected) &&
      info.version !== expected &&
      !info.version.startsWith(`${expected}.`)
    )
      throw new Error(
        `This project requires Ruby ${expected}, but Ruby Path selected ${info.version}. Select the project's Ruby executable or launch the editor with its version manager active.`,
      );
  }
  return { command, ...info };
};
exports.resolveRuby = async (context, configuredPath = "", env = process.env) =>
  context.resolver.select({
    configuredPath,
    kind: "executable",
    names: ["ruby"],
    cwd: context.rootPath,
    env,
    signal: context.signal,
    validate: (command, { signal }) => exports.probeRuby(command, context.rootPath, env, signal),
  });

exports.gemEnvironment = (ruby, gemHome, env = process.env) => {
  const paths = [gemHome, ...(env.GEM_PATH || "").split(path.delimiter), ...ruby.gemPaths].filter(
    Boolean,
  );
  const binPaths = [ruby.bindir, gemHome && path.join(gemHome, "bin"), env.PATH || env.Path].filter(
    Boolean,
  );
  return {
    PATH: binPaths.join(path.delimiter),
    ...(gemHome ? { GEM_HOME: gemHome, GEM_PATH: [...new Set(paths)].join(path.delimiter) } : {}),
  };
};

exports.resolveServer = async (context, { rubyPath = "", serverPath = "" } = {}) => {
  const runtime = await exports.resolveRuby(context, rubyPath);
  if (!runtime) return null;
  const ruby = runtime.data;
  const selected = await context.resolver.select({
    configuredPath: serverPath,
    managedPath: context.managedServer?.modulePath,
    kind: "file",
    signal: context.signal,
    candidates: async () => {
      try {
        const { stdout } = await runFile(
          runtime.path,
          [
            "-rrubygems",
            "-e",
            "spec = Gem::Specification.find_by_name('ruby-lsp'); puts File.join(spec.full_gem_path, spec.bindir, 'ruby-lsp')",
          ],
          {
            cwd: context.rootPath,
            env: { ...process.env, ...exports.gemEnvironment(ruby, "") },
            windowsHide: true,
            timeout: 15000,
            signal: context.signal,
          },
        );
        return [stdout.trim()].filter(Boolean);
      } catch (error) {
        if (String(error.stderr).includes("Gem::MissingSpecError")) return [];
        throw error;
      }
    },
    async validate(script, { source }) {
      if (/\.(cmd|bat|exe)$/i.test(script))
        throw new Error(
          "Server Path must name the Ruby script, without a batch or native executable suffix.",
        );
      const gemHome = source === "managed" ? path.dirname(path.dirname(script)) : "";
      if (gemHome) {
        const installed = JSON.parse(
          await fs.promises.readFile(path.join(gemHome, "ruby-runtime.json"), "utf8"),
        );
        if (installed.abi !== ruby.abi || installed.platform !== ruby.platform)
          throw new Error(
            `The managed Ruby LSP was installed for ${installed.platform} Ruby ABI ${installed.abi}. Reinstall it with Ruby ${ruby.version} before using this runtime.`,
          );
      }
      return { gemHome };
    },
  });
  if (!selected) return null;
  const env = exports.gemEnvironment(ruby, selected.data.gemHome);
  // RUBYLIB supports paths with spaces and survives Ruby LSP's Bundler re-exec.
  // The preload fixes only the affected upstream 0.26.x Prism range helpers.
  env.RUBYLIB = [__dirname, process.env.RUBYLIB].filter(Boolean).join(path.delimiter);
  env.RUBYOPT = [process.env.RUBYOPT, "-rlumine_ruby_lsp_positions"].filter(Boolean).join(" ");
  const { stdout } = await runFile(runtime.path, [selected.path, "--version"], {
    cwd: context.rootPath,
    env: { ...process.env, ...env },
    windowsHide: true,
    timeout: 15000,
    signal: context.signal,
  });
  const version = stdout.trim();
  if (!/^\d+\.\d+\.\d+(?:[.-][\w.]+)?$/.test(version))
    throw new Error("Ruby LSP did not report its version.");
  return context.resolver.launch(runtime, {
    signal: context.signal,
    args: [selected.path],
    env,
    cwd: context.rootPath,
    version,
    transport: "stdio",
  });
};

const gemMetadata = async (version) => {
  const endpoint = version
    ? `v2/rubygems/ruby-lsp/versions/${encodeURIComponent(version)}.json`
    : "v1/gems/ruby-lsp.json";
  const response = await fetch(`https://rubygems.org/api/${endpoint}`, {
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`RubyGems returned HTTP ${response.status} for Ruby LSP.`);
  const metadata = await response.json();
  if (
    !/^\d+\.\d+\.\d+(?:[.-][\w.]+)?$/.test(metadata.version || metadata.number) ||
    !/^[a-f0-9]{64}$/i.test(metadata.sha)
  )
    throw new Error("RubyGems returned invalid Ruby LSP version or SHA256 metadata.");
  return { ...metadata, version: metadata.version || metadata.number };
};

exports.latestServerVersion = async () => (await gemMetadata()).version;

exports.installServer = async ({ storagePath, api, version }, { rubyPath = "" } = {}) => {
  const runtime = await exports.resolveRuby({ resolver: api.resolver }, rubyPath);
  if (!runtime)
    throw new Error("Install Ruby 3.0 or newer and select Ruby Path before installing Ruby LSP.");
  const ruby = runtime.data;
  api.setServerInstallationStatus("checking");
  const metadata = await gemMetadata(version);
  const archive = path.join(storagePath, `ruby-lsp-${metadata.version}.gem`);
  await fs.promises.mkdir(storagePath, { recursive: true });
  api.setServerInstallationStatus("downloading");
  await api.downloadFile(`https://rubygems.org/gems/ruby-lsp-${metadata.version}.gem`, archive, {
    type: "uncompressed",
    digest: `sha256:${metadata.sha}`,
  });
  api.setServerInstallationStatus("installing");
  // Only the install process drops Bundler variables; server startup retains them.
  const env = { ...process.env, ...exports.gemEnvironment(ruby, storagePath) };
  // Install every non-default dependency into the staged payload, even when a
  // user or project gem path already holds a compatible version.
  env.GEM_PATH = storagePath;
  for (const key of Object.keys(env)) if (key.startsWith("BUNDLE_")) delete env[key];
  delete env.RUBYOPT;
  await runFile(
    ruby.command,
    [
      "-rrubygems/gem_runner",
      "-e",
      "Gem::GemRunner.new.run(ARGV)",
      "--",
      "install",
      archive,
      "--no-document",
      "--install-dir",
      storagePath,
      "--bindir",
      path.join(storagePath, "bin"),
    ],
    {
      env,
      windowsHide: true,
      timeout: 600000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  await fs.promises.writeFile(
    path.join(storagePath, "ruby-runtime.json"),
    JSON.stringify({ abi: ruby.abi, platform: ruby.platform, version: ruby.version }),
  );
  await fs.promises.unlink(archive);
  return { version: metadata.version, module: path.join("bin", "ruby-lsp") };
};
