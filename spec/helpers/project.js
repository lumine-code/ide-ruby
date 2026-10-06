const { resolutionContext } = require("./server-resolution");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const source = `# frozen_string_literal: true

# A common calculator base.
class BaseCalculator
end

# Arithmetic helpers.
class Calculator < BaseCalculator
  # Add two values.
  def self.add(left, right = 2)
    left + right
  end
end

answer = Calculator.add(1, 2)
unicode = "😀"; result = Calculator.add(4, 5)
hash = { answer: }
begin
  Calculator.add(1)
rescue
  nil
end
`;
const position = (text, fragment, inside = 0) => {
  const index = text.indexOf(fragment);
  if (index < 0) throw new Error(`Fixture has no '${fragment}'.`);
  const lines = text.slice(0, index + inside).split("\n");
  return { line: lines.length - 1, character: lines.at(-1).length };
};
const offset = (text, point) =>
  text
    .split("\n")
    .slice(0, point.line)
    .reduce((sum, line) => sum + line.length + 1, 0) + point.character;
const applyEdits = (text, edits) => {
  for (const edit of [...edits].sort(
    (a, b) => offset(text, b.range.start) - offset(text, a.range.start),
  ))
    text =
      text.slice(0, offset(text, edit.range.start)) +
      edit.newText +
      text.slice(offset(text, edit.range.end));
  return text;
};
const sameUri = (left, right) => {
  const normalize = (uri) => {
    const filePath = fileURLToPath(uri);
    return process.platform === "win32" ? filePath.toLowerCase() : filePath;
  };
  return normalize(left) === normalize(right);
};
const editsFor = (edit, uri) => [
  ...Object.entries(edit.changes || {})
    .filter(([key]) => sameUri(key, uri))
    .flatMap(([, edits]) => edits),
  ...(edit.documentChanges || [])
    .filter((item) => item.textDocument?.uri && sameUri(item.textDocument.uri, uri))
    .flatMap((item) => item.edits || []),
];
const createProject = () => {
  const temp = fs.realpathSync.native(os.tmpdir());
  const rootPath = fs.mkdtempSync(path.join(temp, "ide-ruby-spec-"));
  const filePath = path.join(rootPath, "main.rb");
  const linkedPath = path.join(rootPath, "linked.rb");
  const linkedText = 'class WorkspaceHelper\nend\nmarker = "😀"; object = Calculator\n';
  fs.writeFileSync(filePath, source);
  fs.writeFileSync(linkedPath, linkedText);
  fs.writeFileSync(
    path.join(rootPath, "Gemfile"),
    `source "https://rubygems.org"\ngem "rubocop", "${process.env.RUBY_RUBOCOP_VERSION || "1.91.0"}"\ngem "project_dependency", path: "dependency"\n`,
  );
  fs.mkdirSync(path.join(rootPath, "dependency", "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(rootPath, "dependency", "project_dependency.gemspec"),
    `Gem::Specification.new do |s|\n  s.name = "project_dependency"\n  s.version = "1.0.0"\n  s.summary = "Integration fixture"\n  s.authors = ["lumine-code"]\n  s.files = ["lib/project_dependency.rb"]\nend\n`,
  );
  fs.writeFileSync(
    path.join(rootPath, "dependency", "lib", "project_dependency.rb"),
    "class ProjectDependency\nend\n",
  );
  fs.writeFileSync(
    path.join(rootPath, ".rubocop.yml"),
    "AllCops:\n  NewCops: disable\n  TargetRubyVersion: 3.4\nLayout/SpaceAroundOperators:\n  Enabled: true\n",
  );
  return {
    rootPath,
    filePath,
    linkedPath,
    linkedText,
    linkedUri: pathToFileURL(linkedPath).href,
    uri: pathToFileURL(filePath).href,
    text: source,
  };
};
const prepareProject = async (fixture, rubyPath, gemHome) => {
  const server = require("../../lib/server");
  const ruby =
    (await server.resolveRuby(resolutionContext({ rootPath: fixture.rootPath }), rubyPath))?.data ??
    null;
  await promisify(execFile)(ruby.command, ["-S", "bundle", "install", "--quiet"], {
    cwd: fixture.rootPath,
    env: { ...process.env, ...server.gemEnvironment(ruby, gemHome) },
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
};
const removeProject = (rootPath) => {
  const temp = fs.realpathSync.native(os.tmpdir());
  const relative = path.relative(temp, path.resolve(rootPath));
  if (
    path.isAbsolute(relative) ||
    relative.startsWith("..") ||
    !relative.startsWith("ide-ruby-spec-")
  )
    throw new Error(`Refusing to remove an unexpected scratch path: ${rootPath}`);
  fs.rmSync(rootPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
};
module.exports = {
  sameUri,
  source,
  position,
  applyEdits,
  editsFor,
  createProject,
  prepareProject,
  removeProject,
};
