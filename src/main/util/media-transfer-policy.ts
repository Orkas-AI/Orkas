// Generated JSON is shared with Server; update Common/config/media-transfer-policy.json.
import policy from './media-transfer-policy.json';
export const MEDIA_TRANSFER_POLICY = Object.freeze({
  connectMs: policy.connect_seconds * 1000,
  legacyCreateMs: policy.legacy_create_seconds * 1000,
  controlMs: policy.control_seconds * 1000,
  transferMs: policy.transfer_seconds * 1000,
  pollMs: policy.poll_seconds * 1000,
  preparationMs: policy.preparation_seconds * 1000,
  referenceUrlSeconds: policy.reference_url_seconds,
});
