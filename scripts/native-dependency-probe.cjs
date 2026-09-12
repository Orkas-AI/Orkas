'use strict';

// These functions are also embedded in the packaged-app smoke process. Keep
// them self-contained: resolve packages from the runtime being verified.
async function probeSqlite(requirePackage, resolveExtensionPath = value => value) {
  let db;
  let dependency = 'better-sqlite3';
  try {
    const Database = requirePackage(dependency);
    db = new Database(':memory:');
    if (db.prepare('SELECT 42 AS answer').get().answer !== 42) {
      throw new Error('SQL round trip failed');
    }
    dependency = 'sqlite-vec';
    const sqliteVec = requirePackage(dependency);
    db.loadExtension(resolveExtensionPath(sqliteVec.getLoadablePath()));
    const row = db.prepare("SELECT vec_version() AS version, vec_distance_L2('[0,0]', '[3,4]') AS distance").get();
    if (typeof row.version !== 'string' || !row.version || row.distance !== 5) {
      throw new Error('Vector round trip failed');
    }
    return { sqliteVec: row.version, vectorDistance: row.distance };
  } catch (error) {
    // Do not expose native-loader paths or unrestricted exception messages.
    throw new Error(`${dependency} could not complete its native operation; run npm run native:repair in the source checkout, or reinstall the matching desktop installer.`);
  } finally {
    if (db) db.close();
  }
}

module.exports = { probeSqlite };
