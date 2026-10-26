import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fixture=fs.mkdtempSync(path.join(root,'.fixture-empty-'));
const {configureDataRoot,dataRoot}=await import('../app/lib/io-root.js');
test('unconfigured production storage fails closed instead of reading HANA_HOME',()=>{
 const old=process.env.HANA_APP_TEST_FIXTURE;delete process.env.HANA_APP_TEST_FIXTURE;
 try{assert.throws(()=>dataRoot('kc-system'),/未配置/);}finally{if(old!==undefined)process.env.HANA_APP_TEST_FIXTURE=old;}
});
test('host dataDir wins over a legacy environment override and starts with no records',async()=>{
 configureDataRoot(fixture);
 const old=process.env.KC_DATA_DIR;process.env.KC_DATA_DIR=path.join(fixture,'synthetic-legacy-override');
 try{
  const io=await import('../app/lib/jsonl-io.js');
  assert.equal(io.resolveDataDir(),path.join(fixture,'data'));
  const {readRepository}=await import('../app/lib/repository.js');
  const repo=readRepository({includeInactive:true});
  assert.equal(repo.ok,true);assert.equal(repo.complete,true);assert.equal(repo.cards.length,0);
  const {listCandidates}=await import('../app/lib/candidate-store.js');
  const candidates=await listCandidates({status:'all',limit:50});
  assert.equal(candidates.ok,true);assert.equal(candidates.items.length,0);
  const {listCards}=await import('../app/lib/ui-api.js');const list=await listCards({status:'all'});
  assert.equal(list.total,0);assert.deepEqual(list.facets.agents,{});
 }finally{if(old===undefined)delete process.env.KC_DATA_DIR;else process.env.KC_DATA_DIR=old;}
});
