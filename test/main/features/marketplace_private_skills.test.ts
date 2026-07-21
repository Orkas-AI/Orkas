import { describe, expect, it } from 'vitest';

import AdmZip from 'adm-zip';

import { agentPrivateSkillIdsFromBundle } from '../../../src/main/features/marketplace_private_skills';

describe('marketplace private skill bundles', () => {
  it('recognizes only top-level skill directories containing SKILL.md', () => {
    const zip = new AdmZip();
    zip.addFile('video-router/SKILL.md', Buffer.from('---\nname: video-router\n---\n'));
    zip.addFile('video-router/references/routing.md', Buffer.from('# Routing\n'));
    zip.addFile('stage-compose/SKILL.md', Buffer.from('---\nname: stage-compose\n---\n'));
    zip.addFile('nested/not-a-root-skill/SKILL.md', Buffer.from('ignored'));
    zip.addFile('readme-only/README.md', Buffer.from('ignored'));

    expect([...agentPrivateSkillIdsFromBundle(zip)].sort()).toEqual([
      'stage-compose',
      'video-router',
    ]);
  });

  it('returns an empty set when no private bundle exists', () => {
    expect(agentPrivateSkillIdsFromBundle(null)).toEqual(new Set());
  });
});
