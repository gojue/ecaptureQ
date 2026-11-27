// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Execute the page's mutation and asynchronous readers with controlled responses.
// In particular, aborted reads may still settle after a successful mutation.
const app = readFileSync(new URL('../frontend/app.js',import.meta.url),'utf8');
const section = (start,end) => app.slice(app.indexOf(start),app.indexOf(end));
const source = [
  section('async function loadRecordDetail(row)','function matchesProcess('),
  section('function discardRecordView(status)',"$('#clear-records').addEventListener"),
  section('async function refreshLive(force','function updateLanguageControls()'),
].join('\n');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes,no) => {resolve=yes;reject=no;});
  return {promise,resolve,reject};
};
function setup() {
  const row = {id:'old-record',detailVersion:1};
  const status = {session:'same-session',revision:2,recordsRevision:2,sources:[{id:'source-1',generation:1}],artifacts:[{id:'native-file'}]};
  const calls = {confirm:0,post:[],read:[],pages:0,scheduled:0,applied:[],rendered:0,details:0,removed:[],toasts:[],timers:[]};
  const decoder = new AbortController();
  const context = vm.createContext({
    window:{confirm:()=>{calls.confirm++;return true;}},
    state:{mode:'live',paused:true,selected:row.id,bookmarks:new Set([row.id]),query:'keep-filter',protocol:'http'},
    workspace:{session:{startedAt:'same-session'},processes:[{id:'process-1'}],requests:[row],status:{...status,recordsRevision:1},page:{index:2,size:200,total:401,retained:401,bookmarks:[row.id],filterKey:'keep-filter'}},
    requests:[row],serverStatus:{...status,recordsRevision:1},serviceError:'',
    clearingRecords:false,refreshing:false,pageClosed:false,pageIndex:2,pageTimer:0,pollTimer:0,
    loadGeneration:1,revision:1,changeController:new AbortController(),loadController:new AbortController(),
    detailController:null,detailLoading:'',recordDetails:new Map([[row.id,{version:1,record:{...row,payload:'old'}}]]),
    decodedBodies:new Map([[row.id,{controller:decoder}]]),
    AbortController,URLSearchParams,
    t:value=>value,filterKey:()=>context.state.query,
    clearImagePreview:()=>{calls.removed.push('image');},
    $:selector=>({replaceChildren:()=>{calls.removed.push(selector);},classList:{remove:value=>{calls.removed.push(value);}}}),
    renderAll:()=>{calls.rendered++;},renderDetail:()=>{calls.details++;},isPaged:()=>true,
    updateCaptureControls:()=>{},toast:message=>{calls.toasts.push(message);},
    setTimeout:(fn,delay)=>{calls.timers.push({fn,delay});return calls.timers.length;},clearTimeout:()=>{},
    schedulePage:()=>{calls.scheduled++;},
    fetchWithTimeout:async (...args)=>{calls.post.push(args);return Response.json({status});},
    fetch:async (...args)=>{calls.read.push(args);return Response.json({...row,payload:'detail'});},
    fetchWorkspace:async ()=>{calls.pages++;return {requests:[{id:'new-record'}]};},
    applyWorkspace:next=>{calls.applied.push(next);context.workspace=next;context.requests=next.requests;},
  });
  vm.runInContext(source,context);
  return {context,calls,row,status,decoder};
}

test('cancel and non-live snapshots never send a clear request or change the view',async()=>{
  for (const mode of ['cancel','mock','snapshot','offline']) {
    const {context,calls,row} = setup();
    if (mode==='cancel') context.window.confirm=()=>false;
    if (mode==='mock') context.state.mode='mock';
    if (mode==='snapshot') context.window.__ECAPTURE_CAPTURE__={};
    if (mode==='offline') context.window.__ECAPTURE_MOCK__={};
    await context.clearRecords();
    assert.equal(calls.post.length,0,mode);
    assert.equal(context.requests[0],row,mode);
    assert.ok(context.state.bookmarks.has(row.id),mode);
    assert.equal(context.loadGeneration,1,mode);
  }
});

test('a pending clear excludes duplicate mutations and background readers; success clears all page caches',async()=>{
  const {context,calls,row,status,decoder} = setup();
  const pending=deferred();
  context.fetchWithTimeout=async (...args)=>{calls.post.push(args);return pending.promise;};
  const clearing=context.clearRecords();
  await context.clearRecords();
  await context.refreshLive(true);
  await context.pollChanges();
  await context.loadRecordDetail(row);
  assert.equal(calls.confirm,1);
  assert.equal(calls.post.length,1);
  assert.equal(calls.post[0][0],'api/records/clear');
  assert.equal(calls.post[0][1].method,'POST');
  assert.equal(calls.post[0][1].headers['X-Ecapture-UI'],'1');
  assert.equal(calls.pages,0);
  assert.equal(calls.read.length,0);
  assert.equal(context.requests.length,1,'The view must survive until the server acknowledges the clear');
  pending.resolve(Response.json({status}));
  await clearing;
  assert.equal(context.clearingRecords,false);
  assert.equal(context.requests.length,0);
  assert.equal(context.state.selected,null);
  assert.equal(context.state.bookmarks.size,0);
  assert.equal(context.pageIndex,0);
  assert.equal(context.workspace.page.index,0);
  assert.equal(context.workspace.page.retained,0);
  assert.equal(context.workspace.page.total,0);
  assert.equal(context.workspace.processes.length,0);
  assert.equal(context.recordDetails.size,0);
  assert.equal(context.decodedBodies.size,0);
  assert.ok(decoder.signal.aborted);
  assert.deepEqual(calls.removed,['image','#tab-content','detail-open']);
  assert.equal(context.state.paused,true);
  assert.equal(context.state.query,'keep-filter');
  assert.equal(context.state.protocol,'http');
  assert.equal(context.serverStatus.session,status.session);
  assert.deepEqual(context.serverStatus.sources,status.sources);
  assert.deepEqual(context.serverStatus.artifacts,status.artifacts);
  assert.equal(calls.pages,0,'Clearing a paused view must not resume refresh');
});

test('server and transport failures preserve records, stars and cached detail',async()=>{
  for (const failure of ['status','network']) {
    const {context,calls,row,decoder} = setup();
    context.fetchWithTimeout=async ()=>{
      if (failure==='network') throw new TypeError('offline');
      return new Response(null,{status:503});
    };
    await context.clearRecords();
    assert.equal(context.requests[0],row);
    assert.equal(context.state.selected,row.id);
    assert.ok(context.state.bookmarks.has(row.id));
    assert.equal(context.recordDetails.get(row.id).record.payload,'old');
    assert.equal(context.pageIndex,2);
    assert.equal(context.clearingRecords,false);
    assert.equal(decoder.signal.aborted,false);
    assert.equal(calls.rendered,0);
    assert.equal(calls.toasts.length,1);
    assert.equal(calls.pages,0);
    assert.equal(calls.scheduled,0,'An unchanged paused view must stay frozen after a failed clear');
  }
});

test('a failed clear retries a filter or page change made while its request was pending',async()=>{
  for (const change of ['filter','page']) {
    const {context,calls,row} = setup();
    const pending=deferred();
    context.fetchWithTimeout=()=>pending.promise;
    const clearing=context.clearRecords();
    if (change==='filter') context.state.query='new-filter';
    else context.pageIndex=3;
    await context.refreshLive(true);
    assert.equal(calls.pages,0,'The changed view is deferred while the clear is pending');
    pending.resolve(new Response(null,{status:503}));
    await clearing;
    assert.equal(context.state.paused,true);
    assert.equal(context.requests[0],row,'The failed mutation must retain existing records');
    assert.equal(calls.scheduled,1,change);
    assert.equal(context.state.query,change==='filter'?'new-filter':'keep-filter');
    assert.equal(context.pageIndex,change==='page'?3:2);
  }
});

test('responses from before a successful clear cannot restore the workspace or detail',async()=>{
  const {context,calls,row} = setup();
  const page=deferred(),detail=deferred();
  context.recordDetails.clear();
  context.fetchWorkspace=()=>page.promise;
  context.fetch=()=>detail.promise;
  const readingPage=context.refreshLive(true);
  const readingDetail=context.loadRecordDetail(row);
  const detailSignal=context.detailController.signal;
  await context.clearRecords();
  assert.ok(detailSignal.aborted);
  page.resolve({requests:[row],revision:1});
  detail.resolve(Response.json({...row,payload:'stale detail'}));
  await Promise.all([readingPage,readingDetail]);
  assert.equal(calls.applied.length,0);
  assert.equal(context.requests.length,0);
  assert.equal(context.recordDetails.size,0);
  assert.equal(context.state.selected,null);
});

test('failed clear retries selected detail even while the older detail read is still unresolved',async()=>{
  const {context,row} = setup();
  context.recordDetails.clear();
  const old=deferred(),fresh=deferred();
  let reads=0;
  context.fetch=()=>++reads===1 ? old.promise : fresh.promise;
  const oldRead=context.loadRecordDetail(row);
  let retried;
  context.renderDetail=()=>{if(!context.recordDetails.has(row.id)) retried=context.loadRecordDetail(row);};
  context.fetchWithTimeout=async ()=>new Response(null,{status:503});
  await context.clearRecords();
  assert.equal(reads,2,'A failed clear must restart detail instead of leaving its loading marker stuck');
  old.resolve(Response.json({...row,payload:'stale'}));
  await oldRead;
  assert.equal(context.detailLoading,row.id+':'+row.detailVersion,'The old reader must not remove the retry loading marker');
  fresh.resolve(Response.json({...row,payload:'fresh'}));
  await retried;
  assert.equal(context.recordDetails.get(row.id).record.payload,'fresh');
});

test('clearing an active view fetches new records without restoring cleared IDs',async()=>{
  const {context,calls} = setup();
  context.state.paused=false;
  await context.clearRecords();
  assert.equal(context.state.paused,false);
  assert.equal(calls.pages,1);
  assert.equal(calls.applied.length,1);
  assert.equal(context.requests.length,1);
  assert.equal(context.requests[0].id,'new-record');
});
