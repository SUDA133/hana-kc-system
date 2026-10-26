import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');const fixture=fs.mkdtempSync(path.join(root,'.fixture-manage-'));
const {configureDataRoot}=await import('../app/lib/io-root.js');configureDataRoot(fixture);
const {storeCard}=await import('../app/lib/card-writer.js');const {readRepository}=await import('../app/lib/repository.js');const {readLifecycle,annotateLifecycle}=await import('../app/lib/lifecycle.js');
const {getCard,listCards}=await import('../app/lib/ui-api.js');const {manageCard,deletePreview}=await import('../app/lib/ui-management.js');
const {execute:deleteCard}=await import('../app/tools/knowledge-delete.js');
async function seed(id,agent='hanako'){const r=await storeCard({agent,id,keywords:['manage'],summary:id,content:'原始正文 '+id},{expectedDigest:'absent'});assert.ok(r.ok,JSON.stringify(r));return (await getCard({identity:agent+'::'+id})).card;}
async function command(identity,action,extra={}){const view=await getCard({identity});return manageCard({action,identity,expectedDigest:view.card.contentDigest,expectedLifecycleRevision:view.lifecycleRevision,reason:'人工管理测试说明',confirm:true,...extra});}

test('archive and restore change visibility without changing formal content bytes or scope',async()=>{
 const card=await seed('archive');assert.equal((await getCard({identity:card.identity})).canManage,true);
 const annotated=await annotateLifecycle({agent:'hanako',id:'archive',metadata:{status:'active',sourceRefs:['证据'],scope:{project:'p'},verifiedAt:'2026-01-01',validUntil:'2099-01-01'},expectedRevision:0,expectedDigest:card.contentDigest,reason:'test seed'});assert.equal(annotated.ok,true);
 const shard=path.join(fixture,'data','hanako.notes.jsonl'),bytes=fs.readFileSync(shard);
 assert.equal((await command(card.identity,'archive')).ok,true);
 assert.equal((await getCard({identity:card.identity})).card.lifecycle.status,'archived');
 assert.equal((await listCards({})).items.some(c=>c.identity===card.identity),false);
 assert.deepEqual(fs.readFileSync(shard),bytes);
 assert.equal((await command(card.identity,'restore')).ok,true);
 const lc=(await getCard({identity:card.identity})).card.lifecycle;
 assert.deepEqual(lc.scope,{project:'p'});assert.deepEqual(lc.sourceRefs,['证据']);assert.equal(lc.verifiedAt,'2026-01-01');assert.equal(lc.validUntil,null);
 assert.deepEqual(fs.readFileSync(shard),bytes);
});

test('expiry and coarse filters stay consistent, archived expiry is only in archive group',async()=>{
 const c=await seed('expiry');assert.equal((await command(c.identity,'set-expiry',{validUntil:'2099-01-01T00:00:00.000Z'})).ok,true);
 assert.equal((await command(c.identity,'expire')).ok,true);let view=await getCard({identity:c.identity});assert.equal(view.card.expired,true);
 assert.ok((await listCards({status:'disabled'})).items.some(x=>x.identity===c.identity));
 assert.equal((await command(c.identity,'archive')).ok,true);
 assert.ok(!(await listCards({status:'disabled'})).items.some(x=>x.identity===c.identity));
 assert.ok((await listCards({status:'archived'})).items.some(x=>x.identity===c.identity));
 assert.equal((await command(c.identity,'clear-expiry')).ok,true);assert.equal((await getCard({identity:c.identity})).card.lifecycle.status,'archived');
 assert.equal((await command(c.identity,'restore')).ok,true);assert.equal((await getCard({identity:c.identity})).card.available,true);
 assert.equal((await command(c.identity,'deprecate')).ok,true);assert.ok((await listCards({status:'disabled'})).items.some(x=>x.identity===c.identity));
});

test('stale lifecycle version and digest cannot overwrite a newer card',async()=>{
 const c=await seed('cas');const view=await getCard({identity:c.identity});await command(c.identity,'archive');
 const stale=await manageCard({action:'deprecate',identity:c.identity,expectedDigest:c.contentDigest,expectedLifecycleRevision:view.lifecycleRevision,reason:'陈旧页面',confirm:true});assert.equal(stale.code,'REVISION_CONFLICT');
 const current=await getCard({identity:c.identity});assert.equal((await storeCard({agent:c.agent,id:c.id,keywords:['manage'],summary:c.id,content:'他人新正文'},{expectedDigest:c.contentDigest,reason:'intervening edit'})).ok,true);
 const bytes=fs.readFileSync(path.join(fixture,'data','hanako.notes.jsonl'));
 const denied=await manageCard({action:'archive',identity:c.identity,expectedDigest:c.contentDigest,expectedLifecycleRevision:current.lifecycleRevision,reason:'old digest',confirm:true});assert.equal(denied.code,'DIGEST_MISMATCH');assert.deepEqual(fs.readFileSync(path.join(fixture,'data','hanako.notes.jsonl')),bytes);
});

test('delete preview is read-only and confirmed single composite target preserves other agent same id',async()=>{
 await seed('same-id');await seed('same-id','ming');const identity='hanako::same-id';const before=fs.readFileSync(path.join(fixture,'data','hanako.notes.jsonl'));
 const preview=await deletePreview({identity});assert.equal(preview.ok,true);assert.equal(preview.identity,identity);assert.deepEqual(fs.readFileSync(path.join(fixture,'data','hanako.notes.jsonl')),before);
 const r=await manageCard({action:'delete',identity,expectedDigest:preview.contentDigest,expectedLifecycleRevision:preview.lifecycleRevision,reason:'确认删除这一张',confirm:true},{principal:{principalId:'fixture-owner'}});assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.committed,true);assert.equal(r.removedCount,1);
 assert.equal((await getCard({identity})).code,'CARD_NOT_FOUND');assert.equal((await getCard({identity:'ming::same-id'})).ok,true);
 const archives=fs.readdirSync(path.join(fixture,'data','deleted'));assert.ok(archives.length>0);assert.ok(archives.some(f=>fs.readFileSync(path.join(fixture,'data','deleted',f),'utf8').includes('same-id')));assert.ok(archives.some(f=>fs.readFileSync(path.join(fixture,'data','deleted',f),'utf8').includes('ui:fixture-owner')));
});

test('delete compares digest and lifecycle revision inside locked reread',async()=>{
 const c=await seed('delete-cas');const p=await deletePreview({identity:c.identity});
 const input={ids:[c.id],agent:c.agent,reason:'确认旧目标',confirm:true,expectedDigest:p.contentDigest,expectedLifecycleRevision:p.lifecycleRevision};
 await command(c.identity,'archive');const r=await deleteCard(input);assert.equal(r.details.code,'REVISION_CONFLICT');assert.equal(r.details.removedCount,0);
 const fresh=await deletePreview({identity:c.identity});await storeCard({agent:c.agent,id:c.id,keywords:['manage'],summary:c.id,content:'new content'},{expectedDigest:c.contentDigest,reason:'changed'});
 const r2=await deleteCard({...input,expectedLifecycleRevision:fresh.lifecycleRevision});assert.equal(r2.details.code,'DIGEST_MISMATCH');assert.equal((await getCard({identity:c.identity})).ok,true);
});

test('referenced replacement card cannot be deleted into a dangling lifecycle relation',async()=>{
 const old=await seed('old-ref'),next=await seed('new-ref');let view=await getCard({identity:old.identity});
 assert.equal((await annotateLifecycle({agent:old.agent,id:old.id,metadata:{status:'superseded',supersededBy:next.identity},expectedRevision:view.lifecycleRevision,expectedDigest:old.contentDigest,reason:'replacement'})).ok,true);
 assert.equal((await deletePreview({identity:next.identity})).code,'TARGET_REFERENCED');assert.equal((await command(next.identity,'delete')).code,'TARGET_REFERENCED');assert.equal(readRepository({includeInactive:true}).complete,true);
});

test('stale lifecycle declarations cannot be rebound or carry old verification onto new content',async()=>{
 const c=await seed('stale-meta');let v=await getCard({identity:c.identity});
 await annotateLifecycle({agent:c.agent,id:c.id,metadata:{status:'active',verifiedAt:'2026-01-01'},expectedRevision:v.lifecycleRevision,expectedDigest:c.contentDigest,reason:'verified old content'});
 await storeCard({agent:c.agent,id:c.id,keywords:['manage'],summary:c.id,content:'new unreviewed content'},{expectedDigest:c.contentDigest,reason:'new content'});
 v=await getCard({identity:c.identity});assert.equal(v.canManage,false);assert.equal(v.card.lifecycle.verifiedAt,null);
 const lifeBefore=fs.readFileSync(path.join(fixture,'data','lifecycle.json'));const r=await command(c.identity,'archive');assert.equal(r.code,'MANAGEMENT_UNAVAILABLE');assert.deepEqual(fs.readFileSync(path.join(fixture,'data','lifecycle.json')),lifeBefore);
});

test('legacy delete calls without CAS retain original single-card behavior',async()=>{
 const c=await seed('legacy-delete');const r=await deleteCard({ids:[c.id],agent:c.agent,confirm:true,reason:'legacy tool contract'});assert.equal(r.details.ok,true);assert.equal(r.details.removedCount,1);assert.equal((await getCard({identity:c.identity})).code,'CARD_NOT_FOUND');
});

test('unconfirmed, unknown, bad date and damaged repository operations are rejected',async()=>{
 const c=await seed('invalid');const v=await getCard({identity:c.identity});const base={identity:c.identity,expectedDigest:c.contentDigest,expectedLifecycleRevision:v.lifecycleRevision,reason:'人工操作',confirm:true};
 assert.equal((await manageCard({...base,action:'archive',confirm:false})).ok,false);assert.equal((await manageCard({...base,action:'reindex'})).ok,false);assert.equal((await manageCard({...base,action:'set-expiry',validUntil:'2026-02-30'})).ok,false);
 fs.appendFileSync(path.join(fixture,'data','ming.notes.jsonl'),'{broken\n');assert.equal((await command(c.identity,'archive')).code,'MANAGEMENT_UNAVAILABLE');
});

test.after(()=>{assert.ok(fixture.startsWith(path.join(root,'.fixture-manage-')));fs.rmSync(fixture,{recursive:true,force:true});});
