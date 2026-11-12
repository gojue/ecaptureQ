// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0

// Page.reload/Page.navigate acknowledgements do not mean the new document is
// ready for Runtime.evaluate. Subscribe before triggering navigation so even a
// cached document that loads before the command reply is observed.
export async function navigateDocument({send,events,sessionId,trigger,timeout=10000}) {
  const {frameTree:{frame}}=await send('Page.getFrameTree',{},sessionId);
  await send('Page.setLifecycleEventsEnabled',{enabled:true},sessionId);
  let timer,onLifecycle,onDetached;
  const loaded=new Promise((resolve,reject)=>{
    onLifecycle=message=>{
      const event=message.params;
      if(message.sessionId===sessionId && event.frameId===frame.id &&
          event.loaderId && event.loaderId!==frame.loaderId && event.name==='DOMContentLoaded')resolve();
    };
    onDetached=message=>{
      if(message.params.sessionId===sessionId)reject(new Error('Navigation target detached'));
    };
    events.on('Page.lifecycleEvent',onLifecycle);
    events.on('Target.detachedFromTarget',onDetached);
    timer=setTimeout(()=>reject(new Error(`New document did not load within ${timeout}ms`)),timeout);
  });
  try {
    await Promise.all([loaded,(async()=>{
      const result=await trigger();
      if(result?.errorText)throw new Error('Navigation failed: '+result.errorText);
    })()]);
  } finally {
    clearTimeout(timer);
    events.off('Page.lifecycleEvent',onLifecycle);
    events.off('Target.detachedFromTarget',onDetached);
  }
}
