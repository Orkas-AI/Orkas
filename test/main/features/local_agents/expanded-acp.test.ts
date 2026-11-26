import { expect, it, vi } from 'vitest';
import { makeAcpBackend } from '../../../../src/main/features/local_agents/backends/_acp';
import {
  antigravityBackend, copilotBackend, cursorBackend, dshBackend, kimiBackend, traecliBackend,
} from '../../../../src/main/features/local_agents/backends/expanded-acp';
import type { LocalEvent } from '../../../../src/main/features/local_agents/backends/base';

vi.mock('../../../../src/main/features/local_agents/backends/base', async importOriginal => {
  const real = await importOriginal<typeof import('../../../../src/main/features/local_agents/backends/base')>();
  return {
    ...real,
    spawnCli: (bin: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) =>
      bin.startsWith('fixture:')
        ? real.spawnCli(process.env.ORKAS_TEST_NODE || process.execPath, ['-e', bin.slice(8), '--', ...args], cwd, env)
        : real.spawnCli(bin, args, cwd, env),
  };
});

it.each(['new', 'resume', 'load', 'auth-required', 'init-error', 'session-error', 'prompt-error', 'tool-only', 'cancelled', 'unacknowledged'] as const)(
  'keeps an expanded ACP run scoped across %s', async mode => {
    const events: LocalEvent[] = [];
    const program = String.raw`
      const mode = ${JSON.stringify(mode)};
      const assert = require('node:assert/strict');
      const send = record => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...record}) + '\n');
      let opened = false;
      require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write('null\n');
          if (mode === 'init-error') {
            send({id:msg.id,error:{code:-32603,message:'Native ' + mode}});
            return;
          }
          if (mode !== 'unacknowledged') send({id:msg.id,result:{protocolVersion:1,agentCapabilities:{
            loadSession:true, sessionCapabilities:mode === 'resume' ? {resume:{}} : {}
          }}});
        } else if (msg.method.startsWith('session/') && ['new','resume','load'].includes(msg.method.split('/')[1])) {
          assert.equal(msg.method, 'session/' + (mode === 'resume' || mode === 'load' ? mode : 'new'));
          assert.deepEqual(msg.params.mcpServers, [{name:'orkas',command:'bridge-node',args:['bridge.cjs'],env:[]}]);
          if (mode === 'auth-required') {
            send({id:msg.id,error:{code:-32000,message:'Private upstream detail'}});
            return;
          }
          if (mode === 'session-error') {
            send({id:msg.id,error:{code:-32603,message:'Native ' + mode}});
            return;
          }
          if (mode === 'load') send({method:'session/update',params:{sessionId:'bound',update:{sessionUpdate:'agent_message_chunk',content:{text:'Old reply'}}}});
          opened = true;
          send({id:msg.id,result:mode === 'resume' || mode === 'load' ? {} : {sessionId:'bound'}});
        } else if (msg.method === 'session/prompt') {
          assert.equal(opened, true);
          assert.equal(msg.params.sessionId, 'bound');
          if (mode === 'prompt-error') {
            send({id:msg.id,error:{code:-32603,message:'Native ' + mode}});
            return;
          }
          send({method:'session/update',params:{sessionId:'another',update:{sessionUpdate:'agent_message_chunk',content:{text:'Foreign reply'}}}});
          send({method:'session/update',params:{sessionId:'bound',update:{sessionUpdate:'agent_message_chunk',content:{text:'Current reply'}}}});
          if (mode === 'tool-only') send({method:'session/update',params:{sessionId:'bound',update:{
            sessionUpdate:'tool_call',toolCallId:'last-tool',title:'Read inputs'
          }}});
          send({id:msg.id,result:{stopReason:mode === 'cancelled' ? 'cancelled' : 'end_turn'}});
        }
      });
    `;
    await makeAcpBackend({
      logName: 'local-agents:test-expanded-acp', argv: ['-e', program],
      clientName: 'orkas-test', cliName: 'Test CLI', resume: 'negotiated',
    }).run({
      binPath: process.env.ORKAS_TEST_NODE || process.execPath,
      cwd: process.cwd(), prompt: 'Continue the task',
      signal: new AbortController().signal, timeoutMs: mode === 'unacknowledged' ? 800 : 3000,
      resumeSessionId: mode === 'resume' || mode === 'load' ? 'bound' : undefined,
      bridge: { server: { command: 'bridge-node', args: ['bridge.cjs'], env: {} }, mcpConfigPath: 'run-local.json' },
      onEvent: event => events.push(event),
    });
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
    expect(events.filter(event => event.type === 'stderr-line')).toEqual([]);
    if (mode === 'auth-required') {
      expect(events.at(-1)).toMatchObject({ status: 'failed' });
      expect(JSON.stringify(events.filter(event => event.type !== 'process-info'))).not.toContain('Private upstream detail');
    } else if (mode === 'init-error' || mode === 'session-error' || mode === 'prompt-error') {
      expect(events.at(-1)).toMatchObject({ status: 'failed', nativeError: 'Native ' + mode });
    } else if (mode === 'unacknowledged') {
      expect(events.at(-1)).toMatchObject({ status: 'timeout', output: '' });
    } else if (mode === 'tool-only' || mode === 'cancelled') {
      expect(events.filter(event => event.type === 'commentary-finalized')).toEqual([
        { type: 'commentary-finalized', text: 'Current reply' },
      ]);
      expect(events.at(-1)).toMatchObject({ status: mode === 'cancelled' ? 'cancelled' : 'completed', output: '' });
    } else {
      expect(events.at(-1)).toMatchObject({ status: 'completed', sessionId: 'bound', output: 'Current reply' });
    }
  },
);

it.each([
  { vendor: 'Kimi', backend: kimiBackend, args: ['acp'] },
  { vendor: 'DSH', backend: dshBackend, args: ['--profile', 'acp'] },
  { vendor: 'TraeCode', backend: traecliBackend, args: ['acp', 'serve'] },
  { vendor: 'Copilot', backend: copilotBackend, args: ['--acp', '--stdio'] },
  { vendor: 'Cursor', backend: cursorBackend, args: ['acp'] },
  { vendor: 'Antigravity', backend: antigravityBackend, args: ['acp'] },
])('launches $vendor in its native ACP mode and honors denial', async ({ backend, args }) => {
  const fixture = String.raw`
    const assert = require('node:assert/strict');
    assert.deepEqual(process.argv.slice(1), ${JSON.stringify(args)});
    const send = row => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...row}) + '\n');
    let prompt;
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const {id,method,params,result} = JSON.parse(line);
      if (method === 'initialize') send({id,result:{protocolVersion:1}});
      if (method === 'session/new') send({id,result:{sessionId:'vendor-task'}});
      if (method === 'session/prompt') {
        prompt = id;
        const update = update => send({method:'session/update',params:{sessionId:'vendor-task',update}});
        update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Read the project.'}});
        update({sessionUpdate:'tool_call',toolCallId:'read',title:'Read project',kind:'read'});
        update({sessionUpdate:'tool_call_update',toolCallId:'read',status:'completed'});
        update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Check the proposed change.'}});
        update({sessionUpdate:'tool_call',toolCallId:'edit',title:'Edit fixture',kind:'edit'});
        send({id:'approval',method:'session/request_permission',params:{
          sessionId:'vendor-task',toolCall:{kind:'edit',title:'Write fixture'},
          options:[{kind:'allow_once',optionId:'allow-once'},{kind:'reject_once',optionId:'reject-once'}]
        }});
      }
      if (id === 'approval') {
        assert.deepEqual(result,{outcome:{outcome:'selected',optionId:'reject-once'}});
        send({method:'session/update',params:{sessionId:'vendor-task',update:{
          sessionUpdate:'agent_message_chunk',content:{text:'The edit was declined'}
        }}});
        send({id:prompt,result:{stopReason:'end_turn'}});
      }
    });
  `;
  const events: LocalEvent[] = [];
  const deny = vi.fn(async () => 'deny' as const);
  await backend.run({
    binPath: 'fixture:' + fixture, cwd: process.cwd(), prompt: 'Change the fixture',
    permissionPolicy: 'inherit', requestPermission: deny,
    signal: new AbortController().signal, timeoutMs: 2500,
    onEvent: event => events.push(event),
  });
  expect(deny).toHaveBeenCalledWith(expect.objectContaining({ tool: 'edit', description: 'Write fixture' }));
  expect(events.filter(event => event.type === 'stderr-line')).toEqual([]);
  expect(events.filter(event => event.type === 'commentary-finalized' || (event.type === 'tool-event' && event.phase === 'use')))
    .toMatchObject([
      { type: 'commentary-finalized', text: 'Read the project.' }, { type: 'tool-event', callId: 'read' },
      { type: 'commentary-finalized', text: 'Check the proposed change.' }, { type: 'tool-event', callId: 'edit' },
    ]);
  expect(events.at(-1)).toMatchObject({ status: 'completed', output: 'The edit was declined' });
});
