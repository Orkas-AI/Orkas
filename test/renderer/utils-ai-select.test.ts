import { describe, it, expect } from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const utils = require('../../src/renderer/modules/utils.js');
const { _aiSelectNextZIndex, _aiSelectNormalizeOptions } = utils as {
  _aiSelectNextZIndex: (values: unknown[], fallback?: number) => number;
  _aiSelectNormalizeOptions: (options: unknown) => Array<Record<string, unknown>>;
};

describe('AiSelect popover layering', () => {
  it('activates a footer action without selecting it or emitting a model change',()=>{
    const source=readFileSync(resolve(__dirname,'../../src/renderer/modules/utils.js'),'utf8'),body=source.slice(source.indexOf('function _aiSelectPick('),source.indexOf('// Test bridge'));
    const state={value:'chosen',multiple:false,options:[{value:'chosen'},{value:'configure',action:()=>calls.push('configure')}],onChange:()=>calls.push('change')},calls:string[]=[];
    const api={state,close:()=>calls.push('close'),setValue:()=>calls.push('value'),el:{dataset:{value:'chosen'}}};const sandbox:any={};runInNewContext(body,sandbox);sandbox._aiSelectPick(api,'configure');
    expect(calls).toEqual(['close','configure']);expect(state.value).toBe('chosen');expect(api.el.dataset.value).toBe('chosen');
  });
  it('stays at the base layer when no ancestor has a z-index', () => {
    expect(_aiSelectNextZIndex(['auto', '', undefined])).toBe(14000);
  });

  it('stays above the shared dialog overlay by default', () => {
    expect(_aiSelectNextZIndex(['auto', '13000', '100'])).toBe(14000);
  });

  it('raises above future overlay layers higher than the base layer', () => {
    expect(_aiSelectNextZIndex(['auto', '15000', '100'])).toBe(15001);
  });

  it('turns malformed option payloads into a safe empty list', () => {
    expect(_aiSelectNormalizeOptions(null)).toEqual([]);
    expect(_aiSelectNormalizeOptions('not-an-array')).toEqual([]);
    expect(_aiSelectNormalizeOptions([null, 3, {}, { value: 7, label: 'bad' }])).toEqual([]);
  });

  it('keeps the first unique string value and normalizes visible copy', () => {
    expect(_aiSelectNormalizeOptions([
      { value: 'a', label: 42, hint: null, iconName: 'sparkles' },
      { value: 'a', label: 'duplicate' },
      { value: 'b', disabled: true },
    ])).toEqual([
      { value: 'a', label: '42', hint: '', iconName: 'sparkles' },
      { value: 'b', label: 'b', hint: '', iconName: '', disabled: true },
    ]);
  });
});
