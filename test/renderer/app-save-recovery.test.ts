import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import vm from 'node:vm';
import {expect,it,vi} from 'vitest';

const source=readFileSync(resolve(__dirname,'../../src/renderer/modules/app-save-recovery.js'),'utf8');
for(const artifact of [true,false]) {
  const channel=artifact?'conversations.artifacts.save':'savedApps.saveFromPath';
  const args=artifact?{cid:'task',artifactId:'artifact',mode:'auto'}:{path:'/workspace/app/index.html',cid:'task',mode:'auto'};
  const impactChannel=artifact?'conversations.artifacts.dataImpact':'savedApps.dataImpactFromPath';
  const exportChannel=artifact?'conversations.artifacts.exportData':'savedApps.exportDataFromPath';
  const impact={ok:true,appId:'original',version:7,fingerprint:'confirmed-code',tables:[{name:'notes',count:2,fields:['body']}]};
  const setup=(options:{clear?:boolean;export?:boolean;exportResult?:any;impactResult?:any;throwMigration?:boolean}={})=>{
    const invoke=vi.fn(async(name:string,payload:any)=>{
      if(name===impactChannel)return options.impactResult||impact;
      if(name===exportChannel)return options.exportResult||{ok:true};
      if(payload.recovery)return {ok:true,id:'original'};
      if(options.throwMigration)throw Object.assign(new Error('migration'),{code:'app_edit_data_migration'});
      return {ok:false,code:'app_edit_data_migration'};
    });
    const context:any={window:{orkas:{invoke}},uiConfirm:vi.fn(async()=>options.export??true),uiConfirmDanger:vi.fn(async()=>options.clear??true)};
    vm.createContext(context);vm.runInContext(source,context);
    return {...context,invoke,save:(payload=args)=>context.window.OrkasAppSave.save(channel,payload,(key:string)=>key)};
  };
  it(`${channel}: exports before an explicitly confirmed retry and binds consent to the inspected app`,async()=>{
    const h=setup();expect(await h.save()).toEqual({ok:true,id:'original'});
    expect(h.invoke.mock.calls.map(call=>call[0])).toEqual([channel,impactChannel,exportChannel,channel]);
    expect(h.invoke.mock.calls[2][1]).toMatchObject({appId:'original'});
    expect(h.invoke.mock.calls[3][1]).toEqual({...args,mode:'update',recovery:{appId:'original',clearVersion:7,clearFingerprint:'confirmed-code'}});
    expect(h.uiConfirm.mock.calls[0][0].message).toContain('notes: 2 (body)');
  });
  it.each([{ok:true,canceled:true},{ok:false,code:'app_edit_data_export_failed'}])(`${channel}: stops on unsuccessful export %j`,async exportResult=>{
    const h=setup({exportResult});expect(await h.save()).toEqual(exportResult);expect(h.uiConfirmDanger).not.toHaveBeenCalled();expect(h.invoke.mock.calls.filter(call=>call[0]===channel)).toHaveLength(1);
  });
  it(`${channel}: canceling clear never retries or reports success`,async()=>{
    const h=setup({clear:false,export:false});expect(await h.save()).toEqual({ok:true,canceled:true});expect(h.invoke).toHaveBeenCalledTimes(2);
  });
  it(`${channel}: cannot recover when the target is missing`,async()=>{
    const impactResult={ok:false,error:'app_edit_target_missing'},h=setup({impactResult});expect(await h.save()).toEqual(impactResult);expect(h.uiConfirm).not.toHaveBeenCalled();
  });
  it(`${channel}: supports structured IPC rejection but never clears on Save as new`,async()=>{
    const h=setup({throwMigration:true,export:false});expect(await h.save()).toEqual({ok:true,id:'original'});
    const copy=setup();expect(await copy.save({...args,mode:'new'})).toMatchObject({ok:false});expect(copy.invoke).toHaveBeenCalledTimes(1);expect(copy.uiConfirm).not.toHaveBeenCalled();
  });
}
