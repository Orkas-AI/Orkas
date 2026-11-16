import {describe,it,expect} from 'vitest';
const m=require('../../resources/builtin/apps/builtin-content-workbench/model.js');

describe('Content workspace saved-history recovery',()=>{
 const row=()=>({id:'original',kind:'image',title:'Preserved title',summary:'Preserved request',status:'completed',assetIds:['source'],resultAssetIds:['result'],updatedAt:'2026-11-12T00:00:00.000Z'});
 const state=(record:any)=>({schemaVersion:1,works:[record],assets:[],drafts:{}});
 it('keeps old optional fields absent and current valid history intact without mutating either',()=>{
  const legacy={id:'legacy',kind:'audio',title:'Earlier recording'},current=row(),before=JSON.stringify(current);
  expect(m.readIndex(state(legacy)).works).toEqual([legacy]);
  expect(m.readIndex(state(current)).works).toEqual([current]);expect(JSON.stringify(current)).toBe(before);
  expect(m.readIndex(state({...current,assetIds:[],resultAssetIds:[],status:'',updatedAt:''})).works).toHaveLength(1);
 });
 it('retains the full supported source and result reference counts and summary length',()=>{
  const current={...row(),summary:'x'.repeat(160),assetIds:Array.from({length:19},(_,i)=>'source'+i),resultAssetIds:Array.from({length:500},(_,i)=>'result'+i),status:'unknown'};
  expect(m.readIndex(state(current)).works[0]).toEqual(current);
 });
 it('retains a structured failure code beside the original reply without rewriting either',()=>{
  const failed={...row(),status:'failed',failureText:'The model claimed completion.',errorCode:'E_OUTPUT_MISSING'},before=JSON.stringify(failed);
  expect(m.readIndex(state(failed)).works[0]).toEqual(failed);expect(JSON.stringify(failed)).toBe(before);
 });
 it.each([
  {assetIds:'source'}, {assetIds:[null]}, {assetIds:['../private']}, {assetIds:Array.from({length:20},(_,i)=>'file'+i)},
  {resultAssetIds:'result'}, {resultAssetIds:['../result']}, {resultAssetIds:Array.from({length:501},(_,i)=>'file'+i)},
  {summary:{}}, {summary:'x'.repeat(161)}, {status:'invented-success'}, {updatedAt:7}, {updatedAt:'not-a-date'},
  {collectionPending:'false'}, {collectionError:1}, {autoSaved:'yes'}, {collectionFailures:-1}, {collectionFailures:0.5},
  {errorCode:'private provider body'}, {errorCode:7}, {errorCode:'E_'}
 ])('rejects a malformed history field before a renderer can consume it: %j',change=>{
  const original=state({...row(),...change}),before=JSON.stringify(original);
  expect(()=>m.readIndex(original)).toThrow('DATA');expect(JSON.stringify(original)).toBe(before);
 });
});
