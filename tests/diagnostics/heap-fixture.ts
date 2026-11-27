export const calibrationMemoryModule = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 5, 6, 1, 1, 128, 2, 128, 4, 7, 10, 1, 6, 109,
  101, 109, 111, 114, 121, 2, 0,
]);

export function heapFixtureFiles(probe: string): Record<string, string> {
  return {
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: "Kotoba heap calibration fixture",
      version: "0.0.0",
      permissions: ["offscreen"],
      background: { service_worker: "background.js" },
      content_security_policy: {
        extension_pages:
          "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self'; worker-src 'self'",
      },
    }),
    "background.js": `let phase="";chrome.runtime.onMessage.addListener((m,s,r)=>{if(m.type==="start"){chrome.offscreen.createDocument({url:"offscreen.html",reasons:["WORKERS"],justification:"Local numeric memory calibration"}).then(()=>r({ok:true}));return true;}if(m.type==="phase"){phase=m.phase;return false;}if(m.type==="state"){r({phase});return false;}});`,
    "popup.html": "<!doctype html><title>Local heap calibration</title>",
    "offscreen.html": '<script type="module" src="offscreen.js"></script>',
    "offscreen.js": `const worker=new Worker(chrome.runtime.getURL("worker.js"),{type:"module"});worker.onmessage=e=>chrome.runtime.sendMessage({type:"phase",phase:e.data.phase});chrome.runtime.onMessage.addListener(m=>{if(m.type==="allocate"&&["wasm","array-buffer","js"].includes(m.phase))worker.postMessage(m.phase);});`,
    "worker.js": `import "./probe.mjs";const holds={};self.onmessage=async e=>{if(e.data==="wasm"){const result=await WebAssembly.instantiate(new Uint8Array(${JSON.stringify([...calibrationMemoryModule])}));holds.memory=result.instance.exports.memory;new Uint8Array(holds.memory.buffer).fill(7);}else if(e.data==="array-buffer"){holds.array=new Uint8Array(8*1024*1024);holds.array.fill(7);}else if(e.data==="js"){holds.js=new Array(1000000).fill(7);}else return;postMessage({phase:e.data});};postMessage({phase:"baseline"});`,
    "probe.mjs": probe,
  };
}
