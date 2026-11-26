import { expect, it, vi } from 'vitest';
import { zcodeBackend } from '../../../../src/main/features/local_agents/backends/zcode';
import type { LocalEvent } from '../../../../src/main/features/local_agents/backends/base';

vi.mock('../../../../src/main/features/local_agents/backends/base', async importOriginal => {
  const real = await importOriginal<typeof import('../../../../src/main/features/local_agents/backends/base')>();
  return {
    ...real,
    spawnCli: (script: string, args: string[], cwd: string) =>
      real.spawnCli(process.env.ORKAS_TEST_NODE || process.execPath, ['-e', script, '--', ...args], cwd),
  };
});

it.each(['fresh', 'resume', 'unsafe-mode', 'reject', 'failed', 'failed-without-detail', 'session-error', 'subscribe-error', 'send-error'] as const)('accepts only the scoped ZCode turn after %s', async mode => {
  const program = String.raw`
    const assert = require('node:assert/strict');
    assert.deepEqual(process.argv.slice(1), ['app-server','--stdio']);
    const mode = ${JSON.stringify(mode)};
    const send = message => process.stdout.write(JSON.stringify(message) + '\n');
    const event = (seq, type, payload, sessionId = 'bound', turnId = 'this-turn') =>
      send({method:'session/event',params:{seq,type,payload,sessionId,turnId}});
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const {id, method, params, result} = JSON.parse(line);
      if (method === 'session/create' || method === 'session/resume') {
        assert.equal(method, mode === 'resume' || mode === 'unsafe-mode' ? 'session/resume' : 'session/create');
        if (method === 'session/create') {
          assert.equal(params.mode, 'build');
          assert.equal(params.persistence, 'immediate');
        } else assert.equal('mode' in params, false);
        assert.deepEqual(params.mcpServers, [{name:'orkas',command:'bridge-node',args:[],env:[]}]);
        if (mode === 'session-error') { send({id,error:{code:-32603,message:'Native ' + mode}}); return; }
        send({id,result:{protocol:{name:'ZCode Protocol',version:1},session:{sessionId:'bound'},
          projection:{mode: mode === 'unsafe-mode' ? 'yolo' : 'build'}}});
      } else if (method === 'session/subscribe') {
        if (mode === 'subscribe-error') { send({id,error:{code:-32603,message:'Native ' + mode}}); return; }
        send({id,result:{sessionId:'bound',eventSeq:8,events:[]}});
      } else if (method === 'session/send') {
        assert.equal(mode === 'unsafe-mode', false);
        assert.ok(params.inputId);
        if (mode === 'send-error') { send({id,error:{code:-32603,message:'Native ' + mode}}); return; }
        send({id,result:{sessionId:'bound',accepted:true,stateRevision:1}});
        event(8,'turn.completed',{resultType:'success',response:'Old result'});
        event(9,'turn.completed',{resultType:'success',response:'Other session'},'another');
        event(10,'turn.started',{inputId:'foreign-input'},'bound','foreign-turn');
        event(11,'turn.failed',{error:{type:'execution',message:'Other turn error'},turnPhase:'execution'},'bound','foreign-turn');
        event(12,'turn.started',{inputId:params.inputId});
        event(13,'model.streaming',{kind:'text_delta',delta:'Read the workspace'});
        event(14,'tool.updated',{kind:'started',toolCallId:'read',toolName:'Read'});
        event(15,'tool.updated',{kind:'result',toolCallId:'read',result:{content:'Workspace read'}});
        send({id:'permission', method:'interaction/requestPermission', params:{
          sessionId:'bound',turnId:'this-turn',toolName:'Write',reason:'Write fixture',
          options:[{optionId:'once',response:{decision:'allow'}}]
        }});
      } else if (id === 'permission') {
        assert.deepEqual(result,{decision:mode === 'reject' ? 'deny' : 'allow'});
        event(16,'model.streaming',{kind:'text_delta',delta:'Provisional result'});
        if (mode === 'failed') event(17,'turn.failed',{error:{type:'execution',message:'Native turn error',stack:'Private stack'},turnPhase:'execution'});
        else if (mode === 'failed-without-detail') event(17,'turn.failed',{});
        else event(17,'turn.completed',{resultType:'success',response:'Current answer'});
      }
    });
  `;
  const events: LocalEvent[] = [];
  const requestPermission = vi.fn(async () => mode === 'reject' ? 'deny' as const : 'allow_once' as const);
  await zcodeBackend.run({
    binPath: program, cwd: process.cwd(), prompt: 'Finish my task',
    signal: new AbortController().signal, timeoutMs: 2500, requestPermission,
    resumeSessionId: mode === 'resume' || mode === 'unsafe-mode' ? 'bound' : undefined,
    bridge: { server: { command: 'bridge-node', args: [], env: {} }, mcpConfigPath: 'run-local.json' },
    onEvent: event => events.push(event),
  });
  expect(events.filter(event => event.type === 'done')).toHaveLength(1);
  if (mode === 'unsafe-mode') {
    expect(requestPermission).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ status: 'failed' });
  } else if (mode === 'session-error' || mode === 'subscribe-error' || mode === 'send-error') {
    expect(requestPermission).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ status: 'failed', nativeError: 'Native ' + mode });
  } else {
    expect(requestPermission).toHaveBeenCalledWith(expect.objectContaining({ tool: 'Write' }));
    expect(events.filter(event => event.type === 'text-delta')).toMatchObject([
      { text: 'Read the workspace', phase: 'pending' }, { text: 'Provisional result', phase: 'pending' },
    ]);
    const commentary = events.filter(event => event.type === 'commentary-finalized');
    const failed = mode === 'failed' || mode === 'failed-without-detail';
    expect(commentary.map(event => event.text)).toEqual(failed
      ? ['Read the workspace', 'Provisional result'] : ['Read the workspace']);
    expect(events.at(-1)).toMatchObject(failed
      ? { status: 'failed', output: '', sessionId: 'bound' }
      : { status: 'completed', output: 'Current answer', sessionId: 'bound' });
    if (mode === 'failed') expect(events.at(-1)?.nativeError).toBe('Native turn error');
    if (mode === 'failed-without-detail') expect(events.at(-1)).not.toHaveProperty('nativeError');
    expect(JSON.stringify(events.filter(event => event.type !== 'process-info'))).not.toMatch(/Private stack|Other turn error/);
  }
});
