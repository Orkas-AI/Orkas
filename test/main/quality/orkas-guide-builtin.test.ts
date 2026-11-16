import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compactPromptDescription } from '../../../src/main/model/core-agent/skill-registry';
import { CATALOG, OAUTH_PROVIDERS } from '../../../src/main/model/provider_catalog';
import { validateSkillDir } from '../../../src/main/quality';
const here = path.dirname(fileURLToPath(import.meta.url));
const pcRoot = path.resolve(here, '../../..');
const skillDir = path.join(pcRoot, 'resources', 'builtin', 'system', 'skills', 'orkas-guide');
const referenceDir = path.join(skillDir, 'references');
it('explains shared to-do notification prerequisites and click destination in the in-app guide', () => {
    const guide = fs.readFileSync(path.join(referenceDir, 'projects-and-automation.md'), 'utf8');
    expect(guide).toContain('system notification permission');
    expect(guide).toContain('locate and highlight');
    expect(guide).toContain('first sync');
});
it('documents capability-based publishing, independent runtime data and non-destructive suspension', () => {
    const guide = fs.readFileSync(path.join(referenceDir, 'library-search-and-apps.md'), 'utf8');
    expect(guide).toMatch(/Apps that need desktop-only features cannot be published|Desktop-only dependencies block publication/);
    expect(guide).toContain('review and send the request yourself');
    expect(guide).toContain('show your publication allowance');
    expect(guide).not.toContain('Only web apps can be published');
    expect(guide).toContain('Platform suspension');
    expect(guide).toContain('data is retained');
    expect(guide).toContain('**Update publication** and **Unpublish**');
    expect(guide).toContain('**Delete** is hidden until unpublishing completes');
    expect(guide).not.toContain('local deletion leaves the publication online');
    expect(guide).not.toContain('Review any Orkas capability warning');
});
const expectedReferences = [
    'agents-skills-and-connectors.md',
    'common-recovery.md',
    'editions.md',
    'file-inputs.md',
    'getting-started.md',
    'library-search-and-apps.md',
    'projects-and-automation.md',
    'settings-data-and-safety.md',
    'tasks-and-conversations.md',
];
function read(file: string): string {
    return fs.readFileSync(file, 'utf8');
}
function combinedGuide(): string {
    return [
        read(path.join(skillDir, 'SKILL.md')),
        ...expectedReferences.map((file) => read(path.join(referenceDir, file))),
    ].join('\n');
}
describe('Orkas Guide builtin contract', () => {
    it('routes feature selection to the overview and distinguishes work tracking from scheduled execution', () => {
        const skill = read(path.join(skillDir, 'SKILL.md'));
        const overviewRoute = skill.split('\n').find((line) => line.startsWith('|') && line.includes('(references/getting-started.md)'));
        expect(overviewRoute).toMatch(/choose features for ongoing work/i);
        const overview = read(path.join(referenceDir, 'getting-started.md'));
        for (const feature of ['Task / conversation', 'Project', 'Goals & rules', 'To-do', 'Auto', 'Agent', 'Skill', 'Connector', 'Library', 'Memory', 'App', 'Model', 'Workspace']) {
            expect(overview.includes(`| **${feature}** |`), feature).toBe(true);
        }
        const projectGuide = read(path.join(referenceDir, 'projects-and-automation.md'));
        expect(projectGuide.includes('does not calculate business-metric progress')).toBe(true);
        expect(projectGuide.includes('Completing to-dos measures work progress')).toBe(true);
        expect(projectGuide.includes('auto-advance is separate from scheduled Automation')).toBe(true);
        expect(projectGuide.includes('does not start work merely because it exists')).toBe(true);
        expect(projectGuide).toContain('**Auto** on **To-do**');
        expect(projectGuide).toContain('off by default');
        expect(projectGuide).toContain('due date is a deadline');
        const resources = read(path.join(referenceDir, 'agents-skills-and-connectors.md'));
        expect(resources.includes("caller's available connections and permissions")).toBe(true);
    });
    it('keeps creation guidance aligned with explicit requests or accepted offers in the in-app guide', () => {
        const projectGuide = read(path.join(referenceDir, 'projects-and-automation.md'));
        expect(projectGuide.includes('when the user asks for one or accepts its offer')).toBe(true);
        expect(projectGuide).toContain('does not require a second confirmation');
        expect(projectGuide.includes('without asking first')).toBe(false);
        const keepingWork = read(path.join(pcRoot, 'src/main/prompts/followup_offer_guidance.md'));
        expect(keepingWork.includes('Create one only when the')).toBe(true);
    });
    it('documents automatic background running, direct native-menu quit and startup without obsolete switches', () => {
        const guide = read(path.join(referenceDir, 'settings-data-and-safety.md'));
        for (const fact of ['**Open Orkas**', '**Quit Orkas**', 'without confirmation', 'Sleep, shutdown', 'window hidden', 'off by default'])
            expect(guide).toContain(fact);
        expect(guide).not.toContain('**Run in background**');
    });
    it('explains expiry recovery without promising cloud data survives cleanup', () => {
        const guide = read(path.join(referenceDir, 'settings-data-and-safety.md'));
        expect(guide).toContain('**Renew to resume sync**');
        expect(guide).toContain('Local data is kept');
        expect(guide).toContain('enable sync again');
    });
    it('documents project selection, all history and reversible deletion', () => {
        const guide = read(path.join(referenceDir, 'settings-data-and-safety.md'));
        for (const fact of ['**Account settings > Data > Clean up task history**', '**7, 14, 30, 60, 90, or 180 days**',
            'default **30**', 'unsent drafts are deleted', 'inline confirmation',
            'Tasks of all statuses', 'pinned and unread tasks', 'automation runs', 'no tasks are selected',
            'Tasks without a Project appear at the top level', 'project-wide selection includes all pages',
            'Projects themselves and their other content are kept',
            'stopped automatically after cleanup is confirmed', 'If stopping fails, the task is kept',
            'project tasks return to their original Project',
            '**Recycle Bin > Local > Restore**', 'deletion also propagates to other devices',
            'disk space is only freed after permanently deleting or emptying'])
            expect(guide).toContain(fact);
    });
    it('explains shared Project privacy, local saves and departure recovery', () => {
        const guide = read(path.join(referenceDir, 'projects-and-automation.md'));
        for (const fact of ['**Members > Invite members**', '**Start sharing and create link**',
            '**Tasks** and **Automation** remain private', 'External CLI Agents remain private',
            'Saved does not mean other members have received', 'turning off personal sync does not stop collaboration',
            '**Refresh**', '**Project conflicts**',
            'only processes to-dos assigned to the current user', 'to-dos not assigned to you removed',
            'Project automations are paused', 'separate shared Project', '**Cancel** discards them']) {
            expect(guide, fact).toContain(fact);
        }
        expect(guide).not.toContain('**Retry publication**');
    });
    it('explains background task browsing and automatic human handback without expanding task access', () => {
        const guide = read(path.join(referenceDir, 'agents-skills-and-connectors.md'));
        expect(guide).toContain('switch to other Orkas pages');
        expect(guide).toContain('Other conversations and external browser windows are outside its access');
        expect(guide).toContain('after 10 seconds without input');
        expect(guide).toContain('once held keys, dragging, or input-method composition have ended');
        expect(guide).not.toContain('Allow AI control');
        expect(guide).not.toContain('Keep that task open for page operations');
        expect(guide).toContain('fill and submit fields including passwords');
        expect(guide).toContain('Attach external files to the conversation');
        expect(guide).toContain('If a website requires a system file dialog, complete that step yourself');
        expect(guide).not.toContain('Use the native file picker when an external');
    });
    it('explains saved Agent defaults without promising automatic or exclusive Skill use', () => {
        const guide = read(path.join(referenceDir, 'agents-skills-and-connectors.md'));
        expect(guide).toContain('saved defaults');
        expect(guide).toContain('across tasks and restarts');
        expect(guide).toContain('they do not run automatically');
        expect(guide).toContain('Other available Skills can still be selected for a task');
        expect(guide).toContain('Selecting a Skill for one task does not rewrite saved defaults');
        expect(guide).toContain('External CLI Agents');
    });
    it('explains app permission, cost, data continuity and recovery in the in-app guide', () => {
        const apps = read(path.join(referenceDir, 'library-search-and-apps.md'));
        for (const fact of ['cannot edit the original', 'new filename', 'Model generation can incur charges',
            'does not ask for separate app consent', 'existing tool permissions', '**Allow for this use**',
            'Closing and reopening requires a new approval', 'other apps do not share it',
            '**Trusted** runs available actions without confirmation', 'Prohibited actions', 'Cloud storage syncs', 'not moved automatically', 'independent', 'configure', 'close and reopen',
            'older apps do not gain', 'standalone HTML export'])
            expect(apps).toContain(fact);
        expect(apps).not.toMatch(/window\.orkasApp|orkas-app\.json|__orkas\/sdk/);
    });
    it('ships as a valid hidden system skill with one English routing description', () => {
        const skill = read(path.join(skillDir, 'SKILL.md'));
        const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
        const keys = frontmatter.split('\n')
            .map((line) => line.match(/^([a-z_]+):/)?.[1])
            .filter(Boolean);
        expect(keys).toEqual(['name', 'description']);
        expect(frontmatter).toMatch(/answering or carrying out a request|questions or actions/);
        expect(frontmatter).toMatch(/what Orkas supports and under which conditions|Orkas support, usage conditions/);
        expect(frontmatter).toMatch(/configured or operated|configuration, operation/);
        expect(frontmatter).toMatch(/recover a blocked workflow|recovery facts/);
        expect(frontmatter).toMatch(/Owns product facts|supplies facts/);
        expect(frontmatter).toMatch(/not task ownership or operation authori(?:zation|ty)/);
        expect(skill).toContain('Do not load it merely because requested work happens inside Orkas');
        expect(skill).toContain('It does not authorize an operation or prove that one succeeded');
        const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1] ?? '';
        const advertisedDescription = compactPromptDescription(description);
        expect(advertisedDescription).toBe(description);
        // Selection happens before the body is read: a complete tool contract and
        // current state must make ordinary operations a nonmatch in this index.
        expect(advertisedDescription).toContain('Skip operations fully specified by tool descriptions and current app state.');
        expect(advertisedDescription).toMatch(/product assumptions embedded in task requirements|implicit product assumptions/);
        // Credit questions ("does my own key make video free?") were answered from
        // web search instead of the guide; the routing index must name them.
        expect(advertisedDescription).toMatch(/credits and costs/);
        expect(advertisedDescription).toMatch(/Ordinary content work independent of Orkas-specific behavior needs no guide|Not for Orkas-independent content/);
        expect(advertisedDescription).toMatch(/not task ownership or operation authori(?:zation|ty)/);
        expect(skill).toContain('## Choose the support shape');
        expect(skill).toContain("pair the path with the app's click-to-open affordance");
        expect(skill).toContain('inspect the smallest available sanitized app-status domain');
        expect(skill).toMatch(/\*\*Execute:\*\* supply the relevant product facts, prerequisites, visible results, and recovery/);
        expect(skill).toContain('Judge support against the requested outcome');
        expect(skill).toContain('say that explicitly before offering an alternative or carrying out the supported part');
        expect(skill).toContain('which part of the requested outcome it achieves and which part remains unmet');
        expect(skill).toContain('only after its owning workflow returns success evidence');
        const report = validateSkillDir(skillDir);
        expect(report.ok, JSON.stringify(report.violations, null, 2)).toBe(true);
        expect(report.violations.filter((violation) => violation.level === 'HIGH')).toEqual([]);
        expect(fs.existsSync(path.join(skillDir, '_meta.json'))).toBe(false);
        const systemManifest = JSON.parse(read(path.join(pcRoot, 'resources', 'builtin', 'system', 'skills', '_system.json')));
        expect(systemManifest).toContainEqual(expect.objectContaining({
            id: 'orkas-guide',
            update_at: expect.anything(),
        }));
        expect(fs.existsSync(path.join(pcRoot, 'resources', 'builtin', 'marketplace', 'skills', 'ce2c4f7ff688'))).toBe(false);
    });
    it('routes every concise user-journey reference directly from SKILL.md', () => {
        const skill = read(path.join(skillDir, 'SKILL.md'));
        const actual = fs.readdirSync(referenceDir)
            .filter((file) => file.endsWith('.md'))
            .sort();
        const routed = [...skill.matchAll(/\(references\/([^)]+\.md)\)/g)]
            .map((match) => match[1])
            .filter((file, index, files) => files.indexOf(file) === index)
            .sort();
        expect(actual).toEqual(expectedReferences);
        expect(routed).toEqual(expectedReferences);
        for (const file of actual) {
            expect(read(path.join(referenceDir, file)).split('\n').length, file).toBeLessThan(100);
        }
    });
    it('covers common/core user outcomes without becoming an exhaustive technical manual', () => {
        const guide = combinedGuide();
        for (const topic of [
            'Commander',
            'Projects',
            'Auto',
            'AI Team',
            'Skills',
            'Connectors',
            'Library',
            'Apps',
            'Settings',
            'Account',
            'Credits',
            'Membership',
            'Data',
            'Models',
            'General',
            'Workspace',
            '**Search**',
            'Cloud sync',
            '**Recycle Bin**',
            'Cautious',
            'Standard',
            'Trusted',
            'retry',
        ]) {
            expect(guide, topic).toContain(topic);
        }
        for (const excluded of [
            /update_at/i,
            /_system\.json/i,
            /template[- ]generate/i,
            /generated UI/i,
            /locale key/i,
            /surface id/i,
            /\bopen_app_view\b/,
            /\bapp_health\b/,
            /\bskill_search\b/,
            /\bmanagement\.(?:app|skills|marketplace|automation)\b/,
            /\bsettings\.(?:models|general|account|data)\b/,
            /\b(?:surface_id|target_id)\b/,
            /IPC route/i,
            /custom MCP/i,
            /stdio/i,
            /benchmark/i,
        ]) {
            expect(guide).not.toMatch(excluded);
        }
        const settingsGuide = read(path.join(referenceDir, 'settings-data-and-safety.md'));
        expect(settingsGuide).toContain('Using a Skill keeps that same task model');
        expect(settingsGuide).toContain('no per-Agent or per-Skill binding for its underlying model or model API key');
        expect(settingsGuide).toContain('switch it in the task input');
        expect(settingsGuide).toContain('additional services can have their own charges');
        expect(settingsGuide).toContain('An external CLI Agent instead uses its bound CLI');
        expect(settingsGuide).toContain('current Account card');
        // Labels come from the shipped model picker group headings.
        const pickerEn = JSON.parse(read(path.join(pcRoot, 'src', 'renderer', 'locales', 'en.json')));
        expect(settingsGuide).toContain(`**${pickerEn['new_chat.model_picker.group_official']}**`);
        expect(settingsGuide).toContain(`**${pickerEn['new_chat.model_picker.group_custom']}**`);
        expect(settingsGuide).toContain('Do not compare membership tiers');
        expect(settingsGuide).toContain('permission, confirmation, or interactive-input gates');
        expect(settingsGuide).toContain('Offer a provider API key only when the user asks for one');
        expect(settingsGuide).toContain('Do not present adding a key as a way to stop using credits');
        expect(settingsGuide).not.toMatch(/\b(?:Free|Lite|Pro|Max)\b/);
        expect(settingsGuide).not.toMatch(/[$¥€]\s*\d|\b\d+(?:\.\d+)?\s*(?:credits?|积分)\b/i);
        const gettingStarted = read(path.join(referenceDir, 'getting-started.md'));
        expect(gettingStarted).toContain("external CLI Agent's details");
        expect(gettingStarted).toContain('Open **AI Team** and choose **Connect an agent**');
        expect(gettingStarted).toContain('**Account settings > Models**');
        expect(gettingStarted).not.toContain('upper-right action');
        expect(gettingStarted).not.toContain('Settings > Credentials');
        expect(gettingStarted).toContain('model, thinking, and permission controls that CLI supports');
        expect(gettingStarted).toContain('Model or thinking **Default** choices clear that Agent\'s override');
        expect(gettingStarted).toContain('**Use CLI default** leaves permissions at the CLI\'s own default');
        expect(gettingStarted).toContain('OpenCode instead runs with fixed **Full access**');
        expect(gettingStarted).toContain('native approval requests appear in the shared Orkas confirmation dialog');
        expect(gettingStarted).toContain('do not change global CLI settings or other Agents');
        expect(gettingStarted).not.toMatch(/Sonnet|Opus|Haiku/);
        const fileGuide = read(path.join(referenceDir, 'file-inputs.md'));
        expect(fileGuide).toMatch(/ZIP attachments are only for importing Skills; they cannot be read as ordinary documents/);
        expect(fileGuide).toMatch(/attach it in\s+\*\*Commander\*\*/);
        expect(fileGuide).toContain('Library or Project Library does not');
        expect(fileGuide).toContain('Use the **Workspace** chip');
        expect(fileGuide).toContain('Task files do not sync with their task');
        expect(fileGuide).not.toContain('ZIP and other archive files are not accepted as task attachments');
        const resourceGuide = read(path.join(referenceDir, 'agents-skills-and-connectors.md'));
        expect(resourceGuide).toContain('**Manual**');
        expect(resourceGuide).toContain('**From URL**');
        expect(resourceGuide).toContain('**From folder**');
        expect(resourceGuide).toContain('does not provide a general Agent JSON import screen');
        expect(resourceGuide).toContain('**Connectors > Add MCP server**');
        expect(resourceGuide).toContain('Claude Code, Codex, or OpenCode');
        expect(resourceGuide).toContain('For CLIs with selectable permissions, the default is **Use CLI default**');
        expect(resourceGuide).toContain('the CLI action or selected path');
        expect(resourceGuide).toContain('asks for your decision');
        expect(resourceGuide).toContain('OpenCode instead runs with fixed **Full access** and shows no permission selector');
        expect(resourceGuide).toContain("keep the workspace default or choose a custom project directory");
        expect(resourceGuide).toContain("a task inside a Project uses that Project's workspace");
        expect(resourceGuide).toContain('after you choose an existing folder, the task continues in that directory');
        expect(resourceGuide).toContain('If a custom project directory was moved or removed');
        const projectGuide = read(path.join(referenceDir, 'projects-and-automation.md'));
        expect(projectGuide).toContain('Projects are scoped to the active Orkas account');
        expect(projectGuide).not.toContain('Project membership');
        const taskGuide = read(path.join(referenceDir, 'tasks-and-conversations.md'));
        expect(taskGuide).toContain('Files are not included by default');
        expect(taskGuide).toContain('lists only files that the public page can preview');
        expect(taskGuide).toContain('converted on this device to an anonymous read-only HTML preview');
        expect(taskGuide).toContain('up to 10 MB, with a 30 MB total per share');
        expect(taskGuide).toContain('Files without a supported preview do not show Share');
        expect(taskGuide).toContain('not filenames, sizes, download actions, local device paths, or neighboring files');
        expect(taskGuide).not.toContain('other files appear as downloads');
        expect(taskGuide).not.toContain('authoritative message time');
        expect(taskGuide).not.toMatch(/fifteen points|at most twelve/i);
        const recoveryGuide = read(path.join(referenceDir, 'common-recovery.md'));
        expect(recoveryGuide).toContain('Commander can inspect sanitized model, connector');
        expect(recoveryGuide).toContain('offer a click-to-open shortcut');
        expect(recoveryGuide).toContain('card three-dot menu > Reauthorize');
        expect(recoveryGuide).not.toContain('card shows missing permissions');
        expect(recoveryGuide).toMatch(/cannot read credentials or replace a\s+protected/);
        expect(settingsGuide).toContain('Enter model API keys only in the protected fields');
        expect(settingsGuide).toContain('never ask the user to paste an API key into an ordinary task');
        expect(settingsGuide).toContain('**AI Team > Agent details > Runtime settings > Permission level**');
        expect(settingsGuide).not.toContain('32,768');
        expect(settingsGuide).not.toContain('Runway · Gen-4.5');
    });
    it('makes the Project instructions limit discoverable in the in-app guide', () => {
        const projectGuide = read(path.join(referenceDir, 'projects-and-automation.md'));
        expect(projectGuide).toMatch(/\*\*Goals & rules\*\*[^.]*\b4000 characters\b/);
    });
    it('gives the user-run Skill disable, delete and Marketplace uninstall path with the shipped labels in the in-app guide', () => {
        // Commander has no Skill removal workflow; without this documented path it
        // tried file deletion (Commander app-assist regression, 2026-10-16).
        const rendererEn = JSON.parse(read(path.join(pcRoot, 'src', 'renderer', 'locales', 'en.json')));
        const skillsLabel = rendererEn['sidebar.skills'];
        const disableLabel = rendererEn['component.disable'];
        const enableLabel = rendererEn['component.enable'];
        const deleteLabel = rendererEn['skills.delete'];
        const uninstallLabel = rendererEn['marketplace.uninstall'];
        for (const label of [skillsLabel, disableLabel, enableLabel, deleteLabel, uninstallLabel])
            expect(label).toBeTruthy();
        const skillsMenu = read(path.join(pcRoot, 'src', 'renderer', 'modules', 'skills.js'));
        expect(skillsMenu).toContain("t('component.disable')");
        expect(skillsMenu).toContain("t('skills.delete')");
        const guide = read(path.join(referenceDir, 'agents-skills-and-connectors.md')).replace(/\s+/g, ' ');
        const start = guide.indexOf('The user pauses or removes a Skill.');
        expect(start).toBeGreaterThanOrEqual(0);
        const section = guide.slice(start, guide.indexOf('## Add a local external agent'));
        expect(section).toContain(`**${skillsLabel}**`);
        expect(section).toMatch(new RegExp(`\\*\\*⋯\\*\\* menu in \\*\\*${skillsLabel}\\*\\* and choose \\*\\*${disableLabel}\\*\\*`));
        expect(section).toContain(`**${enableLabel}**`);
        expect(section).toContain(`Choose **${deleteLabel}**`);
        expect(section).toMatch(new RegExp(`\\*\\*Marketplace\\*\\* and choose \\*\\*${uninstallLabel}\\*\\*`));
        // Removal requests route to skill-creator as Skill mutations; its root must
        // send them to the reference that states the same user-run path.
        const creatorDir = path.join(pcRoot, 'resources', 'builtin', 'system', 'skills', 'skill-creator');
        expect(read(path.join(creatorDir, 'SKILL.md'))).toMatch(/removing a whole Skill → \[file-deletion\.md\]/);
        const creatorRemoval = read(path.join(creatorDir, 'references', 'file-deletion.md')).replace(/\s+/g, ' ');
        for (const label of [skillsLabel, disableLabel, deleteLabel, uninstallLabel])
            expect(creatorRemoval).toContain(`**${label}**`);
        const wholeRemoval = creatorRemoval.split('## Files inside a Skill')[0];
        expect(wholeRemoval).toContain('has no protocol here. The user does it:');
        expect(wholeRemoval).not.toContain('Give that path and stop');
        // Whole-resource handoff must not erase the separate confirmation stop for
        // deleting a file inside a Skill, or duplicate Commander's card policy.
        expect(creatorRemoval).toContain('Do not call the tool again in that turn');
        expect(wholeRemoval).not.toMatch(/open_app_view|entry card/i);
    });
    it('routes a ChatGPT plan to account authorization, not the separately billed OpenAI API key, in the in-app guide', () => {
        const codex = CATALOG.find((p) => p.id === 'openai-codex');
        const openai = CATALOG.find((p) => p.id === 'openai');
        expect(codex?.oauthOnly).toBe(true);
        expect(openai?.oauthOnly).toBeFalsy();
        const rendererEn = JSON.parse(read(path.join(pcRoot, 'src', 'renderer', 'locales', 'en.json')));
        const authorizeLabel = rendererEn['settings.modal.method_oauth_title'];
        expect(authorizeLabel).toBeTruthy();
        const settingsGuide = read(path.join(referenceDir, 'settings-data-and-safety.md')).replace(/\s+/g, ' ');
        expect(settingsGuide).toMatch(new RegExp(`ChatGPT plan[^.]*\\*\\*${codex!.label}\\*\\*`));
        expect(settingsGuide).toContain(`**${authorizeLabel}**`);
        expect(settingsGuide).toMatch(new RegExp(`\\*\\*${openai!.label}\\*\\*[^.]*API key[^.]*billed separately`));
        expect(settingsGuide).not.toContain('To add OpenAI/ChatGPT');
    });
    it('routes a Claude plan to Anthropic account authorization, not its separately billed API key, in the in-app guide', () => {
        const anthropic = CATALOG.find((p) => p.id === 'anthropic');
        expect(anthropic?.oauthOnly).toBeFalsy();
        expect(OAUTH_PROVIDERS.some((p) => p.id === 'anthropic')).toBe(true);
        const rendererEn = JSON.parse(read(path.join(pcRoot, 'src', 'renderer', 'locales', 'en.json')));
        const authorizeLabel = rendererEn['settings.modal.method_oauth_title'];
        const apiKeyLabel = rendererEn['settings.modal.method_api_title'];
        const settingsGuide = read(path.join(referenceDir, 'settings-data-and-safety.md')).replace(/\s+/g, ' ');
        expect(settingsGuide).toMatch(new RegExp(`Claude plan[^.]*\\*\\*${anthropic!.label}\\*\\*[^.]*\\*\\*${authorizeLabel}\\*\\*[^.]*\\*\\*${apiKeyLabel}\\*\\*[^.]*billed separately`));
    });
    it('explains direct-chat setup versus ordinary use and simple authorization versus extra assistance', () => {
        const guide = read(path.join(referenceDir, 'agents-skills-and-connectors.md')).replace(/\s+/g, ' ');
        expect(guide).toContain('Not connected does not mean unsupported');
        expect(guide).toContain('Simple OAuth only needs the connection entry and your login/consent');
        expect(guide).toContain('Extra configuration uses the connector\'s concise guide and browser assistance');
        expect(guide).toContain('Ordinary work with an existing connection does not need setup discovery');
    });
});
it('explains welcome-card CLI connection, default configuration and retry without promising automatic task execution', () => {
    const guide = read(path.join(referenceDir, 'getting-started.md'));
    expect(guide).toContain('welcome card');
    expect(guide).toContain('default configuration');
    expect(guide).toContain('does not start a task');
});

it('runs the public guide launcher with the guide body and edition owners', () => {
  expect(fs.existsSync(path.join(pcRoot, 'scripts/update-orkas-guide-skill.cjs'))).toBe(false);
  const pkg = JSON.parse(read(path.join(pcRoot, 'package.json')));
  expect(pkg.scripts['guide:update']).toBeUndefined();
  expect(pkg.scripts['guide:check']).toBeUndefined();
  expect(pkg.scripts['test:orkas-guide']).toContain('test/main/quality/orkas-guide-builtin.test.ts');
  expect(pkg.scripts['test:orkas-guide']).toContain('test/main/quality/orkas-guide-editions.test.ts');
  expect(pkg.scripts['test:orkas-guide']).toContain('test/main/util/builtin-resource-gate.test.ts');
  expect(pkg.scripts['test:orkas-guide']).not.toContain('benchmark');
  expect(pkg.scripts['benchmark:orkas-guide']).toBeUndefined();
});
