import test from 'node:test';
import assert from 'node:assert/strict';
import {adsCaptureSchema,adsIdentifiers} from '../src/google-ads-attribution.js';
import {adsConversionBody,adsRequestState} from '../src/google-ads-worker.js';
import {adsSettingsSchema} from '../src/google-ads-connection.js';

test('Ads 点击标识限制、90 天有效期及独立同意',()=>{
  const now=Date.now(),input={consent:'unset' as const,updatedAt:now,capturedAt:now,gclid:'fixture-click',gbraid:'fixture-braid'};
  assert.deepEqual(adsIdentifiers(input,now),{gclid:'fixture-click',gbraid:'fixture-braid'});
  assert.deepEqual(adsIdentifiers({...input,consent:'denied'},now),{});
  assert.deepEqual(adsIdentifiers({...input,capturedAt:now-91*86400000},now),{});
  assert.deepEqual(adsIdentifiers({...input,capturedAt:now+120000},now),{});
  assert.equal(adsCaptureSchema.safeParse({...input,gclid:'x'.repeat(513)}).success,false);
  assert.equal(adsCaptureSchema.safeParse({...input,gclid:'email@example.com'}).success,false);
});
test('Ads 请求只携带允许字段，API 接收与最终状态分离',()=>{
  const body=adsConversionBody({id:'event',created_at:'2026-11-19T00:00:00Z',identifiers:{wbraid:'click'},destination:{productDestinationId:'123'},consent:'unset',event_params:{value:12,currency:'USD',email:'private@example.com',items:[{name:'private'}]}});
  assert.equal(body.events[0].consent,undefined);
  assert.doesNotMatch(JSON.stringify(body),/private|items|email/);
  assert.equal(adsRequestState({}).state,'accepted');
  assert.equal(adsRequestState({requestStatusPerDestination:[{requestStatus:'PROCESSING'}]}).state,'accepted');
  assert.equal(adsRequestState({requestStatusPerDestination:[{requestStatus:'SUCCESS'}]}).state,'sent');
  assert.equal(adsRequestState({requestStatusPerDestination:[{requestStatus:'PARTIAL_SUCCESS'}]}).state,'failed');
});
test('Ads 默认关闭，启用必须有客户 ID 和转化动作',()=>{
  const settings={enabled:false,customerId:'',loginCustomerId:'',qualifyLeadAction:'',closeConvertLeadAction:'',purchaseAction:'',revision:0};
  assert.ok(adsSettingsSchema.safeParse(settings).success);
  assert.ok(!adsSettingsSchema.safeParse({...settings,enabled:true}).success);
  assert.ok(adsSettingsSchema.safeParse({...settings,enabled:true,customerId:'1234567890',purchaseAction:'123'}).success);
});
