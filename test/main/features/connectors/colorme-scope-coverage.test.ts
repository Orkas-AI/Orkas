import {createRequire} from 'node:module';
import {expect,it} from 'vitest';
import {findCatalogEntry} from '../../../../src/main/features/connectors/catalog';
const require=createRequire(import.meta.url),evidence=require('../../../fixtures/connectors/official-contracts/remaining-upstream-boundaries-20261001.json').colorme;
it('exposes the full documented MCP inventory within existing ColorMe scopes and excludes template-only scopes',()=>{
 const card=findCatalogEntry('colorme-shop')!;expect(card.required_oauth_scopes).toEqual(['openid','read_products','read_sales','read_shop_coupons','write_products','write_sales','write_shop_coupons','offline_access']);expect(card.allowed_tools).toHaveLength(45);expect([...card.allowed_tools!].sort()).toEqual(evidence.operations.filter((r:any)=>r.status==='same_scope_reviewed').map((r:any)=>r.name).sort());
 for(const name of ['getTemplates','getTemplatePreview','getTemplatePage','updateTemplatePage'])expect(card.allowed_tools).not.toContain(name);
 for(const name of ['getCustomer','getCustomers','postCustomers','updateCustomers','postCustomerPoints','updateCustomerMembership','deleteCustomerGroupMembership'])expect(evidence.operations.find((r:any)=>r.name===name).required_scopes.every((s:string)=>['read_sales','write_sales'].includes(s))).toBe(true);
});
it('keeps points and public store changes behind fresh approval and membership/pickup removal destructive',()=>{
 const policies=findCatalogEntry('colorme-shop')!.tool_policies!;
 for(const name of ['postCustomerPoints','postCustomers','updateCustomers','updateCustomerMembership','postProductPickup','putProductPickup','createProductGroup','updateProductGroup','createProductCategory','updateProductCategory','createProductCategoryChild','updateProductCategoryChild'])expect(policies[name]).toMatchObject({risk:'H',confirmation:'fresh',max_batch_size:1});
 for(const name of ['deleteCustomerGroupMembership','deleteProductPickup'])expect(policies[name]).toMatchObject({risk:'D',confirmation:'destructive',max_batch_size:1});
 for(const name of ['getCustomer','getCustomers','getProductAdvertisings','getPayments','getDeliveries','getDeliveryDateSetting','getGift'])expect(policies[name]).toMatchObject({risk:'R',confirmation:'none'});
});
