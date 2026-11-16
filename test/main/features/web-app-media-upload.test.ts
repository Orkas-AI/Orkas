import {it,expect,vi} from 'vitest';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
it('uploads only app-owned bytes to a Shopify-issued destination and refuses a forged host',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'app-media-'));const bytes=Buffer.from('selected-product-image');await fs.writeFile(path.join(dir,'cup.png'),bytes);
 const {uploadProductAsset}=await import('../../../src/main/features/web_apps/media-upload');const upload=vi.fn(async()=>new Response('',{status:201}));
 const invoke=vi.fn(async()=>({content:JSON.stringify({provider:'shopify',result:{stagedTargets:[{url:'https://shopify-staged-uploads.storage.googleapis.com/',resourceUrl:'https://shopify-staged-uploads.storage.googleapis.com/cup.png',parameters:[{name:'key',value:'selected-cup'}]}]}})}));
 try{const result=await uploadProductAsset(dir,'cup.png',invoke,new AbortController().signal,upload);expect(result.sourceUrl).toContain('/cup.png');expect(upload).toHaveBeenCalledOnce();const body=upload.mock.calls[0][1].body as FormData;expect(Buffer.from(await (body.get('file') as File).arrayBuffer())).toEqual(bytes);
  invoke.mockResolvedValueOnce({content:JSON.stringify({provider:'shopify',result:{stagedTargets:[{url:'https://127.0.0.1/private',resourceUrl:'https://shopify-staged-uploads.storage.googleapis.com/cup.png',parameters:[]}]}})});await expect(uploadProductAsset(dir,'cup.png',invoke,new AbortController().signal,upload)).rejects.toMatchObject({code:'E_FILE'});expect(upload).toHaveBeenCalledOnce();
  await fs.symlink(path.join(dir,'cup.png'),path.join(dir,'linked.png'));await expect(uploadProductAsset(dir,'linked.png',invoke,new AbortController().signal,upload)).rejects.toMatchObject({code:'E_FILE'});expect(invoke).toHaveBeenCalledTimes(2);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
