// Run dynamic imports in a real Node module, outside Playwright's VM evaluator.
module.exports = async function installOAuthOwnerFixture(root) {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const workspace = fs.realpathSync(process.env.ORKAS_WORKSPACE_ROOT || '');
  const relative = path.relative(fs.realpathSync(os.tmpdir()), workspace);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Isolated native fixture workspace required');
  }
  const users = require(`${root}/src/main/features/users`);
  const auth = require(`${root}/src/main/features/auth`);
  const { pathToFileURL } = require('node:url');
  const oauth = await import(pathToFileURL(`${root}/src/core-agent/src/auth/oauth-compat.ts`).href);
  const paths = require(`${root}/src/main/paths`);
  const owner = users.getActiveUserId();
  const other = 'native-oauth-owner-other';
  for (const uid of [owner, other]) {
    users.activateUser(uid);
    await auth.addApiKey('openai', 'synthetic-native-owner-key', 'owner');
  }
  users.activateUser(owner);
  const files = [owner, other].map(uid => paths.userAuthProfilesFile(uid));
  const before = files.map(file => fs.readFileSync(file));
  let release, reject;
  const gate = new Promise((resolve, fail) => { release = resolve; reject = fail; });
  const control = { owner, other, users, auth, oauth, files, before, fs, release, reject, calls: 0, callbacks: null };
  oauth.registerOAuthProvider({
    id: 'e2e-auth-owner', name: 'Controlled OAuth fixture',
    login(callbacks) {
      control.calls += 1; control.callbacks = callbacks;
      return gate.then(() => ({ access: 'synthetic-late-access', refresh: 'synthetic-late-refresh', expires: Date.now() + 3_600_000 }));
    },
    refreshToken() { throw new Error('Native fixture must not refresh'); },
    getApiKey(credentials) { return credentials.access; },
  });
  globalThis.__oauthOwnerControl = control;
};
