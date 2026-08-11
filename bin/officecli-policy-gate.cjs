#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');

const REQUIRED_APP_EXEC_DENIALS = Object.freeze([
  '/Applications',
  '/System/Applications',
  '/System/Cryptexes/App/System/Applications',
]);

const MAC_OFFICECLI_SANDBOX_PROFILE = Object.freeze([
  '(version 1)',
  '(allow default)',
  ...REQUIRED_APP_EXEC_DENIALS.map((deniedRoot) => `(deny process-exec (subpath "${deniedRoot}"))`),
].join(''));

const POLICY_FILES = Object.freeze({
  engine: 'src/main/features/office/office_engine.ts',
  renderer: 'src/main/features/office/office_page_renderer.ts',
  tools: 'src/main/model/core-agent/office-tools.ts',
  smoke: 'scripts/run-office-artifact-smoke.mjs',
});

function fail(message) {
  throw new Error(`[officecli-policy] ${message}`);
}

function readRequired(pcRoot, relativeFile) {
  const file = path.join(pcRoot, relativeFile);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    fail(`missing required policy owner ${relativeFile}: ${err.message}`);
  }
}

function requirePattern(source, pattern, message) {
  if (!pattern.test(source)) fail(message);
}

function walkTypeScriptFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) fail(`main-process source root is missing: ${root}`);
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) visit(abs);
      else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(abs);
    }
  };
  visit(root);
  return files.sort();
}

function sourceLocation(sourceFile, node) {
  const point = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${sourceFile.fileName}:${point.line + 1}`;
}

function collectPolicyBindings(sourceFile) {
  const runNames = new Set();
  const officeEngineNamespaces = new Set();
  const binaryPathNames = new Set();
  const pathNamespaces = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const moduleName = statement.moduleSpecifier.text;
    const bindings = statement.importClause && statement.importClause.namedBindings;
    if (/(?:^|\/)office_engine$/.test(moduleName) && bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        const imported = binding.propertyName ? binding.propertyName.text : binding.name.text;
        if (imported === 'runOfficeCli') runNames.add(binding.name.text);
      }
    } else if (/(?:^|\/)office_engine$/.test(moduleName) && bindings && ts.isNamespaceImport(bindings)) {
      officeEngineNamespaces.add(bindings.name.text);
    }
    if (/(?:^|\/)paths$/.test(moduleName) && bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        const imported = binding.propertyName ? binding.propertyName.text : binding.name.text;
        if (imported === 'officeCliBinaryPath') binaryPathNames.add(binding.name.text);
      }
    } else if (/(?:^|\/)paths$/.test(moduleName) && bindings && ts.isNamespaceImport(bindings)) {
      pathNamespaces.add(bindings.name.text);
    }
  }
  return { runNames, officeEngineNamespaces, binaryPathNames, pathNamespaces };
}

function isRunOfficeCliCall(node, bindings) {
  if (!ts.isCallExpression(node)) return false;
  if (ts.isIdentifier(node.expression)) {
    return node.expression.text === 'runOfficeCli' || bindings.runNames.has(node.expression.text);
  }
  return ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && bindings.officeEngineNamespaces.has(node.expression.expression.text)
    && node.expression.name.text === 'runOfficeCli';
}

function isOfficeCliBinaryPathCall(node, bindings) {
  if (!ts.isCallExpression(node)) return false;
  if (ts.isIdentifier(node.expression)) {
    return node.expression.text === 'officeCliBinaryPath' || bindings.binaryPathNames.has(node.expression.text);
  }
  return ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && bindings.pathNamespaces.has(node.expression.expression.text)
    && node.expression.name.text === 'officeCliBinaryPath';
}

function containsExactString(node, value) {
  let found = false;
  const visit = (current) => {
    if (found) return;
    if ((ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current))
      && current.text === value) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function verifyMainProcessCallSites(pcRoot) {
  const mainRoot = path.join(pcRoot, 'src', 'main');
  const allowedBinaryOwners = new Set([
    path.normalize(path.join(pcRoot, 'src/main/paths.ts')),
    path.normalize(path.join(pcRoot, POLICY_FILES.engine)),
  ]);
  const violations = [];

  for (const file of walkTypeScriptFiles(mainRoot)) {
    const source = fs.readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const bindings = collectPolicyBindings(sourceFile);
    const fileContainsScreenshotToken = containsExactString(sourceFile, 'screenshot');

    const visit = (node) => {
      if (isRunOfficeCliCall(node, bindings)) {
        const argv = node.arguments[0];
        if (argv && (containsExactString(argv, 'screenshot')
          || (!ts.isArrayLiteralExpression(argv) && fileContainsScreenshotToken))) {
          violations.push(`${sourceLocation(sourceFile, node)} calls the forbidden OfficeCLI screenshot backend`);
        }
      }
      if (isOfficeCliBinaryPathCall(node, bindings) && !allowedBinaryOwners.has(path.normalize(file))) {
        violations.push(`${sourceLocation(sourceFile, node)} resolves the OfficeCLI binary outside the sole engine owner`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  if (violations.length) fail(`main-process call-site policy failed:\n- ${violations.join('\n- ')}`);
}

function verifyOfficeCliRuntimePolicy(pcRoot) {
  const root = path.resolve(pcRoot);
  const engine = readRequired(root, POLICY_FILES.engine);
  const renderer = readRequired(root, POLICY_FILES.renderer);
  const tools = readRequired(root, POLICY_FILES.tools);
  const smoke = readRequired(root, POLICY_FILES.smoke);

  requirePattern(
    engine,
    /OFFICECLI_SKIP_UPDATE\s*:\s*['"]1['"]/,
    'OfficeCLI runtime self-update must remain disabled',
  );
  requirePattern(
    engine,
    /command\s*:\s*['"]\/usr\/bin\/sandbox-exec['"]/,
    'macOS OfficeCLI launches must remain wrapped by sandbox-exec',
  );
  requirePattern(
    engine,
    /spawn\(launch\.command\s*,\s*launch\.args\s*,/,
    'runOfficeCli must spawn the guarded launch command, not the binary directly',
  );
  for (const deniedRoot of REQUIRED_APP_EXEC_DENIALS) {
    if (!engine.includes(`(deny process-exec (subpath "${deniedRoot}"))`)) {
      fail(`macOS process sandbox no longer denies installed app execution under ${deniedRoot}`);
    }
  }

  requirePattern(
    renderer,
    /\[['"]view['"]\s*,\s*file\s*,\s*['"]html['"]\s*,\s*['"]-o['"]\s*,\s*htmlPath\s*,\s*['"]--page['"]\s*,\s*page\]/,
    'embedded renderer must obtain HTML from OfficeCLI with the reviewed argv contract',
  );
  requirePattern(renderer, /import\(['"]electron['"]\)/, 'Office previews must use the embedded Electron runtime');
  requirePattern(renderer, /new BrowserWindow\s*\(/, 'Office previews must be captured by an embedded BrowserWindow');
  requirePattern(renderer, /hardenedWebPreferences\s*\(/, 'Office preview BrowserWindow hardening was removed');
  requirePattern(renderer, /isolateRenderSession\s*\(/, 'Office preview session isolation was removed');
  requirePattern(
    tools,
    /renderOfficePageToPng\s*\(file\s*,\s*cwd\s*,\s*page\s*,\s*signal\)/,
    'Office tools must route previews through the embedded page renderer',
  );
  requirePattern(
    smoke,
    /guardedOfficeCliInvocation\s*\(/,
    'real-binary Office artifact smoke must use the installed-App execution guard',
  );
  requirePattern(
    smoke,
    /\[['"]view['"]\s*,\s*file\s*,\s*['"]html['"]/,
    'real-binary Office artifact smoke must validate browserless HTML rendering',
  );
  if (/['"]screenshot['"]/.test(smoke)) {
    fail('real-binary Office artifact smoke must not invoke the OfficeCLI screenshot backend');
  }

  verifyMainProcessCallSites(root);
  return Object.freeze([
    'runtime-self-update-disabled',
    'mac-app-exec-denied',
    'embedded-electron-renderer',
    'isolated-render-session',
    'single-officecli-spawn-owner',
    'no-officecli-screenshot-calls',
    'browserless-guarded-artifact-smoke',
  ]);
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function verifyHostOfficeCliBinary(pcRoot, options = {}) {
  const root = path.resolve(pcRoot);
  const spec = require(path.join(root, 'scripts', 'fetch-officecli.cjs'));
  const platformKey = `${process.platform}-${process.arch}`;
  const asset = spec.ASSETS[platformKey];
  if (!asset) {
    if (options.required) fail(`no pinned OfficeCLI asset is declared for host ${platformKey}`);
    return Object.freeze([]);
  }
  const binary = path.join(root, 'resources', 'officecli', asset);
  if (!fs.existsSync(binary)) {
    if (options.required) fail(`host OfficeCLI binary is missing: ${binary}`);
    return Object.freeze([]);
  }
  const actualHash = sha256File(binary);
  if (actualHash !== spec.SHA256[asset]) {
    fail(`host OfficeCLI sha256 mismatch for ${asset}: expected ${spec.SHA256[asset]}, got ${actualHash}`);
  }

  const runProbe = options.spawnSync || spawnSync;
  const probeOptions = {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, OFFICECLI_SKIP_UPDATE: '1' },
  };
  const version = runProbe(binary, ['--version'], probeOptions);
  if (version.error || version.status !== 0) {
    fail(`host OfficeCLI --version failed: ${version.error ? version.error.message : version.stderr}`);
  }
  const expectedVersion = String(spec.VERSION).replace(/^v/, '');
  if (String(version.stdout || '').trim() !== expectedVersion) {
    fail(`host OfficeCLI version mismatch: expected ${expectedVersion}, got ${String(version.stdout || '').trim()}`);
  }

  const help = runProbe(binary, ['view', '--help'], probeOptions);
  const helpText = `${help.stdout || ''}\n${help.stderr || ''}`;
  if (help.error || help.status !== 0) {
    fail(`host OfficeCLI view --help failed: ${help.error ? help.error.message : helpText}`);
  }
  for (const token of ['html', '--page', '--out']) {
    if (!helpText.includes(token)) fail(`host OfficeCLI view contract is missing ${token}`);
  }
  return Object.freeze(['pinned-host-binary', 'host-version-match', 'view-html-cli-contract']);
}

function parseArgs(argv) {
  const options = { root: path.resolve(__dirname, '..'), requireHostBinary: false };
  for (const arg of argv) {
    if (arg === '--require-host-binary') options.requireHostBinary = true;
    else if (arg.startsWith('--root=')) options.root = path.resolve(arg.slice('--root='.length));
    else fail(`unknown argument: ${arg}`);
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const verified = [
    ...verifyOfficeCliRuntimePolicy(options.root),
    ...verifyHostOfficeCliBinary(options.root, { required: options.requireHostBinary }),
  ];
  console.log(`[officecli-policy] verified: ${verified.join(', ')}`);
}

module.exports = Object.freeze({
  POLICY_FILES,
  MAC_OFFICECLI_SANDBOX_PROFILE,
  REQUIRED_APP_EXEC_DENIALS,
  verifyHostOfficeCliBinary,
  verifyOfficeCliRuntimePolicy,
});

if (require.main === module) {
  try { main(); }
  catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
