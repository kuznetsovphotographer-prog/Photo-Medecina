'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('./storage.js');
const { createHash } = require('node:crypto');
const { createHandler, validatedPayload, fingerprintPayload } = require('./index.js');
const { buildMail, sendMail, createDrainHandler, POSTBOX_URL, CRM_URL } = require('./postbox.js');
const env = { ENDPOINT:'grpcs://example.test:2135',DATABASE:'/test/database',DELIVERY_MODE:'postbox',
  POSTBOX_FROM_EMAIL:'notifications@prointeriors.ru',POSTBOX_TO_EMAIL:'TheAlexMay@yandex.ru' };
const context = { token:{access_token:'synthetic-iam-token'} };
const lead = { name:'Тест',contact:'+79990000000',contactMethod:'phone',source:'modal',consent:true,
  phoneCountry:'RU',consentVersion:'2026-11-18-medical-postbox-1',consentAcceptedAt:new Date().toISOString(),
  submissionId:'00000000-0000-4000-8000-000000000001',formId:'modal-general',deviceType:'phone',osFamily:'android' };
const event = (value=lead,origin='https://promedphoto.ru')=>({httpMethod:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(value)});
const now = ()=>new Date().toISOString();
const save = (db, request=lead, mode=true) => {
 const received = new Date(lead.consentAcceptedAt); const parsed=validatedPayload(request,received);
 const hash=createHash('sha256').update(JSON.stringify(fingerprintPayload(parsed))).digest('hex');
 return db.store.save(parsed, received, hash, context.token.access_token);
};

// In-memory SDK transaction model: exercises production SQL, transaction boundaries and rollback.
// It is not a substitute for the deferred release-time YDB integration check.
function database(mode = 'postbox') {
  let state={leads:{},consent_events:{},notification_outbox:{}}, staged, serial=Promise.resolve();
  const stats={commits:0,rollbacks:0,writes:0,failWrite:false,failFinish:false};
  const native=rows=>({resultSets:[rows]});
  const session={
    describeTable:async()=>({columns:[]}),alterTable:async()=>{},prepareQuery:async q=>q,
    beginTransaction:async options=>{assert.deepEqual(options,{serializableReadWrite:{}});staged=structuredClone(state);return {id:'tx'};},
    commitTransaction:async tx=>{assert.deepEqual(tx,{txId:'tx'});state=staged;staged=undefined;stats.commits++;},
    rollbackTransaction:async()=>{staged=undefined;stats.rollbacks++;},
    executeQuery:async(q,p={},tx)=>{
      const v=Object.fromEntries(Object.entries(p).map(([k,value])=>[k,value.value]));
      const db=tx ? staged : state;
      if(tx)assert.deepEqual(tx,{txId:'tx'});
      if(q.includes('SELECT fingerprint, server_received_at FROM leads'))return native(db.leads[v.$id]?[db.leads[v.$id]]:[]);
      if(q.includes('SELECT submission_id FROM notification_outbox WHERE submission_id'))return native(db.notification_outbox[v.$id]?[db.notification_outbox[v.$id]]:[]);
      if(q.includes('INSERT INTO ')){
        assert.ok(tx,'all web writes must be in the explicit transaction');
        const table=q.match(/INSERT INTO (\w+)/)[1];
        const id=v.$submission_id;assert.equal(db[table][id],undefined);
        const record=Object.fromEntries(Object.entries(v).map(([key,value])=>[key.slice(1),value]));
        db[table][id]=record;
        if(stats.failWrite && table==='notification_outbox')throw Error('synthetic write failure');
        stats.writes++;return native([]);
      }
      if(q.includes('SELECT state, site_host'))return native(db.notification_outbox[v.$id]?[db.notification_outbox[v.$id]]:[]);
      if(q.includes('SELECT submission_id FROM notification_outbox'))return native(Object.values(db.notification_outbox)
        .filter(row=>['postbox-pending','postbox-retry-1','postbox-retry-2'].includes(row.state)&&new Date(row.expires_at)>new Date()).slice(0,5));
      if(q.includes('UPDATE notification_outbox')){
        const row=db.notification_outbox[v.$id];
        if(v.$claim&&row?.state!==v.$claim)return native([]);
        if(stats.failFinish&&v.$claim)throw Error('synthetic finish write failure');
        if(row){row.state=v.$state;if(v.$message!==undefined)row.message_id=v.$message;}return native([]);
      }
      throw Error('Unexpected test query');
    },
  };
  class Driver{constructor(){this.tableClient={withSessionRetry:callback=>{
    const pending=serial.then(()=>callback(session));serial=pending.catch(()=>{});return pending;
  }};}async ready(){return true;}}
  class Column{constructor(name,type){this.name=name;this.type=type;}}
  class AlterTableDescription{withAddColumn(){return this;}}
  const typed=value=>({value});
  const sdk={Driver,Column,AlterTableDescription,Types:{UTF8:'utf8',UINT64:'uint64',TIMESTAMP:'timestamp',optional:value=>value},
    TypedValues:{utf8:typed,timestamp:typed},TypedData:{createNativeObjects:rows=>rows}};
  return {store:createStore({env:{...env,DELIVERY_MODE:mode},sdk}),state:()=>state,stats};
}

test('mail allowlist contains no client fields and both links retain the protected CRM card for the medical domain',()=>{
  for(const siteHost of ['promedphoto.ru']){
    const mail=buildMail({...lead,siteHost,serverReceivedAt:'2026-11-18T12:00:00Z',bookingDetails:'PRIVATE-TEXT'},
      {from:env.POSTBOX_FROM_EMAIL,to:env.POSTBOX_TO_EMAIL});
    assert.equal(mail.Content.Simple.Subject.Data,`Новая заявка с сайта ${siteHost}`);
    assert.deepEqual(mail.Content.Simple.Headers,[{Name:'X-Submission-Id',Value:lead.submissionId},{Name:'X-Source-Site',Value:siteHost}]);
    assert.deepEqual(mail.Destination,{ToAddresses:[env.POSTBOX_TO_EMAIL]});
    const text=JSON.stringify(mail);for(const forbidden of [lead.name,lead.contact,'PRIVATE-TEXT',lead.consentVersion])assert.ok(!text.includes(forbidden));
    assert.match(mail.Content.Simple.Body.Text.Data,/15:00:00/);
    const links=[...mail.Content.Simple.Body.Html.Data.matchAll(/href="([^"]+)"/g)].map(m=>m[1].replaceAll('&amp;','&'));
    assert.equal(links.length,2);assert.equal(links[0],links[1]);
    const url=new URL(links[0]);assert.equal(url.origin+url.pathname,CRM_URL);
    assert.deepEqual([...url.searchParams],[['admin','1'],['lead',lead.submissionId]]);
  }
  assert.throws(()=>buildMail({submissionId:lead.submissionId,siteHost:'evil.test',serverReceivedAt:now()},{from:'a@test.test',to:'b@test.test'}));
});

test('disabled delivery and low remaining time perform no provider request',async()=>{
  const db=database();await save(db);
  const forbidden=()=>assert.fail('must not send');
  assert.deepEqual(await createDrainHandler({env:{...env,DELIVERY_MODE:'storage-only'},store:db.store,fetchImpl:forbidden})({},context),{attempted:0,disabled:true});
  assert.deepEqual(await createDrainHandler({env,store:db.store,fetchImpl:forbidden})({},
    {...context,getRemainingTimeInMillis:()=>20000}),{attempted:0});
  assert.equal(db.state().notification_outbox[lead.submissionId].state,'postbox-pending');
  assert.deepEqual(await createDrainHandler({env,store:db.store,fetchImpl:forbidden})({prepare:true},context),{prepared:true,attempted:0});
  assert.equal(db.state().notification_outbox[lead.submissionId].state,'postbox-pending');
});

test('all ambiguous provider responses stop automatic retries',async()=>{
  for(const status of [200,408,500,502,503,302]){
    const result=await sendMail({},'synthetic',async()=>({status,json:async()=>({})}));assert.equal(result.outcome,'uncertain');
  }
  for(const status of [400,401,403,404])assert.equal((await sendMail({},'synthetic',async()=>({status}))).outcome,'failed');
  assert.equal((await sendMail({},'synthetic',async()=>{throw {cause:{code:'ENOTFOUND'}};})).outcome,'retry');
  assert.equal((await sendMail({},'synthetic',async()=>{throw {cause:{code:'ECONNRESET'}};})).outcome,'uncertain');
});

test('atomic inserts, concurrent identical replay, immutable consent and historical no-backfill',async()=>{
  const db=database();
  const results=await Promise.all([save(db),save(db)]);
  assert.deepEqual(results.map(result=>result.created),[true,false]);
  assert.equal(db.stats.writes,3);
  assert.equal(db.state().notification_outbox[lead.submissionId].site_host,'promedphoto.ru');
  assert.equal(db.state().notification_outbox[lead.submissionId].state,'postbox-pending');
  db.state().leads[lead.submissionId].status='contacted';
  await save(db);
  assert.equal(db.state().leads[lead.submissionId].status,'contacted');
  assert.equal(db.state().consent_events[lead.submissionId].consent_version,lead.consentVersion);
  await assert.rejects(save(db,{...lead,contact:'+79990000001'}),{code:'SUBMISSION_CONFLICT'});
  delete db.state().notification_outbox[lead.submissionId];
  assert.equal((await save(db)).created,false);
  assert.deepEqual(db.state().notification_outbox,{});
});

test('failure after inserting the outbox rolls back all three rows',async()=>{
  const db=database();db.stats.failWrite=true;
  await assert.rejects(save(db));
  assert.deepEqual(db.state(),{leads:{},consent_events:{},notification_outbox:{}});
  assert.equal(db.stats.rollbacks,1);
});

test('success after commit is independent of mail rejection, timeout or failed finish; replay never resends',async()=>{
  for(const scenario of ['success','reject','timeout','finish-failure']){
    const db=database();
    const handle=createHandler({env,store:db.store,now:()=>new Date(lead.consentAcceptedAt),
      fetchImpl:()=>assert.fail('public receiver must not call the network')});
    const response=await handle(event(),context);
    assert.equal(response.statusCode,202);assert.equal(JSON.parse(response.body).ok,true);
    let calls=0;
    const drain=createDrainHandler({env,store:db.store,fetchImpl:async(url,options)=>{
      calls++;assert.equal(url,POSTBOX_URL);
      assert.equal(options.headers['X-YaCloud-SubjectToken'],context.token.access_token);
      assert.equal(Object.keys(db.state().leads).length,1);
      assert.equal(Object.keys(db.state().consent_events).length,1);
      if(scenario==='timeout')throw Object.assign(Error('timeout'),{name:'TimeoutError'});
      return {status:scenario==='reject'?403:200,json:async()=>({MessageId:'synthetic-message-id'})};
    }});
    db.stats.failFinish=scenario==='finish-failure';
    if(db.stats.failFinish)await assert.rejects(drain({},context));else await drain({},context);
    assert.equal(JSON.parse((await handle(event(),context)).body).notification,'already-recorded');
    await drain({},context);assert.equal(calls,1);
    assert.equal(db.state().notification_outbox[lead.submissionId].state,
      {success:'postbox-sent',reject:'postbox-failed',timeout:'postbox-uncertain','finish-failure':'postbox-sending-1'}[scenario]);
  }
});

test('one concurrent claim and at most three explicit rejection retries; legacy relay rows stay untouched',async()=>{
  const db=database();await save(db);
  const claims=await Promise.all([db.store.claimPostbox(lead.submissionId,context.token.access_token),
    db.store.claimPostbox(lead.submissionId,context.token.access_token)]);
  assert.equal(claims.filter(Boolean).length,1);
  const fresh=database();await save(fresh);
  let calls=0;const drain=createDrainHandler({env,store:fresh.store,fetchImpl:async()=>{calls++;return {status:429};}});
  for(let attempt=0;attempt<5;attempt++)await drain({},context);
  assert.equal(calls,3);assert.equal(fresh.state().notification_outbox[lead.submissionId].state,'postbox-failed');
  for(const state of ['pending','sending','failed','sent','uncertain','disabled']){
    fresh.state().notification_outbox[lead.submissionId].state=state;
    await drain({},context);assert.equal(calls,3);
  }
});

test('new and previous medical consent editions retain their actual version; disabled intake is never queued',async()=>{
  for(const consentVersion of ['2026-10-27-medical-1','2026-11-18-medical-postbox-1']){
    const db=database();const handle=createHandler({env,store:db.store,now:()=>new Date(lead.consentAcceptedAt)});
    assert.equal((await handle(event({...lead,consentVersion}),context)).statusCode,202);
    assert.equal(db.state().consent_events[lead.submissionId].consent_version,consentVersion);
    assert.equal(db.state().leads[lead.submissionId].site_host,'promedphoto.ru');
  }
  const db=database('storage-only');await save(db);
  assert.equal(db.state().notification_outbox[lead.submissionId].state,'disabled');
  assert.deepEqual(await db.store.listPostbox(context.token.access_token),[]);
  await assert.rejects(createDrainHandler({env,store:db.store})({},{}),/CONFIGURATION_MISSING/);
});

