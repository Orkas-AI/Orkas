import { describe, it, expect, vi } from 'vitest';
import { handleAcpMessage } from '../../../../src/main/features/local_agents/backends/_acp';

function makeHandlers() {
  return {
    onSessionNew: vi.fn(),
    onTextDelta: vi.fn(),
    onThinking: vi.fn(),
    onToolUse: vi.fn(),
    onToolResult: vi.fn(),
    onPromptResult: vi.fn(),
    onUnknown: vi.fn(),
  };
}

describe('local_agents/backends/_acp › handleAcpMessage', () => {
  it('routes session/new response to onSessionNew', () => {
    const h = makeHandlers();
    handleAcpMessage({ jsonrpc: '2.0', id: 2, result: { sessionId: 'sess-x' } }, h);
    expect(h.onSessionNew).toHaveBeenCalledWith('sess-x');
  });

  it('routes session/update agent_message_chunk to onTextDelta (kind field)', () => {
    const h = makeHandlers();
    handleAcpMessage({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 's', update: { kind: 'agent_message_chunk', content: { text: 'hello' } } },
    }, h);
    expect(h.onTextDelta).toHaveBeenCalledWith('hello');
  });

  it('routes session/update agent_message_chunk via sessionUpdate field (Hermes wire format)', () => {
    const h = makeHandlers();
    handleAcpMessage({
      method: 'session/update',
      params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'hi' } } },
    }, h);
    expect(h.onTextDelta).toHaveBeenCalledWith('hi');
  });

  it('routes agent_thought_chunk to onThinking', () => {
    const h = makeHandlers();
    handleAcpMessage({
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_thought_chunk', content: { text: '(◔_◔) mulling' } } },
    }, h);
    expect(h.onThinking).toHaveBeenCalledWith('(◔_◔) mulling');
  });

  it('available_commands_update goes to onUnknown (not pretending to be a tool)', () => {
    const h = makeHandlers();
    handleAcpMessage({
      method: 'session/update',
      params: { update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'help' }] } },
    }, h);
    expect(h.onToolUse).not.toHaveBeenCalled();
    expect(h.onUnknown).toHaveBeenCalled();
  });

  it('routes tool_call to onToolUse', () => {
    const h = makeHandlers();
    handleAcpMessage({
      method: 'session/update',
      params: { update: { kind: 'tool_call', tool: { id: 'c1', name: 'read_file', input: { path: 'x.md' } } } },
    }, h);
    expect(h.onToolUse).toHaveBeenCalledWith({ name: 'read_file', callId: 'c1', input: { path: 'x.md' } });
  });

  it('routes tool_call_update to onToolResult, stringifying non-string output', () => {
    const h = makeHandlers();
    handleAcpMessage({
      method: 'session/update',
      params: { update: { kind: 'tool_call_update', tool: { id: 'c1', name: 'read_file', output: { lines: 4 } } } },
    }, h);
    expect(h.onToolResult).toHaveBeenCalledWith({ name: 'read_file', callId: 'c1', output: '{"lines":4}' });
  });

  it('marks prompt response (id=100) ok=true on end_turn', () => {
    const h = makeHandlers();
    handleAcpMessage({ id: 100, result: { stopReason: 'end_turn' } }, h);
    expect(h.onPromptResult).toHaveBeenCalledWith({ ok: true, error: undefined });
  });

  it('marks prompt response ok=false for non-end_turn stop reasons', () => {
    const h = makeHandlers();
    handleAcpMessage({ id: 100, result: { stopReason: 'cancelled' } }, h);
    expect(h.onPromptResult).toHaveBeenCalledWith({ ok: false, error: 'cancelled' });
  });

  it('marks prompt response ok=false on rpc error envelope', () => {
    const h = makeHandlers();
    handleAcpMessage({ id: 100, error: { message: 'auth fail' } }, h);
    expect(h.onPromptResult).toHaveBeenCalledWith({ ok: false, error: 'auth fail' });
  });

  it('forwards unknown session/update kinds to onUnknown', () => {
    const h = makeHandlers();
    handleAcpMessage({
      method: 'session/update',
      params: { update: { kind: 'something_new', payload: 1 } },
    }, h);
    expect(h.onUnknown).toHaveBeenCalled();
  });

  it('ignores unrelated request errors silently', () => {
    const h = makeHandlers();
    handleAcpMessage({ id: 3, error: { message: 'unknown method' } }, h);
    expect(h.onPromptResult).not.toHaveBeenCalled();
  });
});
