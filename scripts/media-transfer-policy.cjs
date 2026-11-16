// Verify independently packaged media policy without requiring monorepo files.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
function verifyMediaTransferPolicy(pcRoot) {
  const target = path.join(pcRoot, 'src/main/util/media-transfer-policy.json');
  const bytes = fs.readFileSync(target);
  const policy = JSON.parse(bytes);
  const keys = ['version', 'connect_seconds', 'control_seconds', 'transfer_seconds', 'poll_seconds',
    'preparation_seconds', 'upload_signature_seconds', 'reference_url_seconds', 'temp_retention_days', 'legacy_create_seconds'];
  if (Object.keys(policy).length !== keys.length || keys.some(key => !Number.isSafeInteger(policy[key]) || policy[key] <= 0)
    || policy.version !== 1 || policy.upload_signature_seconds < policy.transfer_seconds + policy.control_seconds
    || policy.reference_url_seconds <= policy.preparation_seconds) throw new Error('Invalid media transfer policy');
  const canonical = path.join(pcRoot, '../Common/config/media-transfer-policy.json');
  if (fs.existsSync(canonical) && !bytes.equals(fs.readFileSync(canonical))) {
    throw new Error('Stale media transfer policy; run Common/scripts/sync-media-transfer-policy.py');
  }
}
module.exports = { verifyMediaTransferPolicy };
