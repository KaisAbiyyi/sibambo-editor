import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
const repo=fileURLToPath(new URL('../../',import.meta.url)).replaceAll('\\','/').replace(/\/$/,'');
const require=createRequire(new URL('../../package.json',import.meta.url));
const {chromium}=require('@playwright/test');
const out=resolve(process.env.SIB_OUT_DIR||'');
if(!/^[dD]:[\\/]/.test(out)||!process.env.SIB_OUT_DIR)throw Error('SIB_OUT_DIR must be a new D: directory');
mkdirSync(out);
const sha=b=>createHash('sha256').update(b).digest('hex');
function crc(bytes){let v=0xffffffff;for(const byte of bytes){v^=byte;for(let bit=0;bit<8;bit++)v=(v&1)?0xedb88320^(v>>>1):v>>>1;}return(v^0xffffffff)>>>0;}
function chunk(type,data=Buffer.alloc(0)){const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(type,4);b.set(data,8);b.writeUInt32BE(crc(b.subarray(4,b.length-4)),b.length-4);return b;}
function png(rgba){const h=Buffer.alloc(13);h.writeUInt32BE(2);h.writeUInt32BE(2,4);h[8]=8;h[9]=6;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('iTXt',Buffer.from([78,0,0,0,0,0,198])),chunk('IDAT',deflateSync(Buffer.concat([Buffer.from([0]),rgba.subarray(0,8),Buffer.from([0]),rgba.subarray(8)]))),chunk('IEND')]);}
const raw=Buffer.from([255,0,99,0,0,255,0,127,0,0,255,255,11,22,33,255]);
const gray=Buffer.from([64,64,64,0,128,128,128,127,255,255,255,255,0,0,0,255]);
const grayExpected=Buffer.from([64,64,64,0,128,128,128,127,255,255,255,255,2,2,2,255]);
const fixtures={'synthetic.png':png(raw),'gray.png':png(gray)};
const bad=Buffer.from(fixtures['synthetic.png']);bad[45]^=1;fixtures['bad.png']=bad;
let realMissing=true;
if(process.env.SIB_REAL_PNG_FIXTURE){const real=readFileSync(process.env.SIB_REAL_PNG_FIXTURE);if(sha(real)!=='a9484148d775915145c45bb68de279711811bba15bbd16279cf17e791b7f9f63')throw Error('Real fixture hash mismatch');fixtures['real.png']=real;realMissing=false;}
const sourceFile=repo+'/packages/e4-import/src/image-pixel-codec.ts';const before=sha(readFileSync(sourceFile));
const workerCode=`import {defaultImagePixelCodec} from '/@fs/${repo}/packages/e4-import/src/image-pixel-codec.ts';
const digest=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b))).map(x=>x.toString(16).padStart(2,'0')).join('');
onmessage=async({data})=>{try{let bytes=new Uint8Array(await(await fetch('/fixture/'+data.fixture)).arrayBuffer());if(data.offset){const b=new Uint8Array(bytes.length+17);b.set(bytes,7);bytes=b.subarray(7,7+bytes.length);}if(data.truncate)bytes=bytes.subarray(0,40);const original=await digest(bytes);
if(data.semantic){const {hydrateSemanticMaterials}=await import('/@fs/${repo}/packages/e4-import/src/bomc-loader.ts');const materials=[{name:'synthetic',rgba:[255,255,255,255],opacity:1,texture:0,textureWidthM:1,textureHeightM:1,semantic:{materialType:2,colorizeMode:1,deltas:[0,0,0],outputRgbaSha256:data.expectedHash}}];const textures=[{media:1,sourceMedia:1,encodedHashVerified:true,width:2,height:2,hash:original,bytes,assetPath:'synthetic.png',payloadByteLength:bytes.length}];const result=await hydrateSemanticMaterials(materials,textures);postMessage({ok:true,verified:result.diagnostics.verifiedCount,unchanged:original===await digest(bytes)});return;}
const frame=await defaultImagePixelCodec.decode({media:1,bytes,width:data.width||2,height:data.height||2},()=>!!data.cancel);postMessage({ok:true,width:frame.width,height:frame.height,sha256:await digest(frame.data),unchanged:original===await digest(bytes)});
}catch(e){postMessage({ok:false,error:String(e.message)});}};`;
const server=await createServer({configFile:false,root:repo,cacheDir:out+'/vite-cache',logLevel:'error',resolve:{alias:[{find:/^@sibambo\/scene-runtime$/,replacement:repo+'/packages/scene-runtime/src/index.ts'},{find:/^@sibambo\/contracts$/,replacement:repo+'/packages/contracts/src/index.ts'}]},plugins:[{name:'readiness',configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url==='/proof'){res.setHeader('Content-Type','text/html');res.end('<title>PNG pixel proof</title>');}else if(req.url==='/proof-worker.js'){res.setHeader('Content-Type','text/javascript');res.end(workerCode);}else if(req.url?.startsWith('/fixture/')){const b=fixtures[req.url.slice(9)];if(!b){res.statusCode=404;res.end();}else res.end(b);}else next();});}}],optimizeDeps:{include:['three'],noDiscovery:true},server:{host:'127.0.0.1',port:0,fs:{allow:[repo]}}});
const result={schema:'sibambo-png-pixel-readiness-v1',repo,real_fixture:realMissing?'NOT_RUN_MISSING_FIXTURE':'hash_pinned',checks:[],source_sha256:before};
let browser;
try{console.log('PNG readiness: starting Vite');await server.listen();console.log('PNG readiness: launching Chromium');browser=await chromium.launch({headless:true,timeout:15000,...(process.env.SIB_PLAYWRIGHT_CHANNEL?{channel:process.env.SIB_PLAYWRIGHT_CHANNEL}:{})});result.browser=browser.version();const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/proof');console.log('PNG readiness: browser page loaded');
const cases=[['transparent_rgba',{fixture:'synthetic.png'},sha(raw)],['subarray',{fixture:'synthetic.png',offset:true},sha(raw)],['bad_removed_text_crc',{fixture:'bad.png'},null],['truncated',{fixture:'synthetic.png',truncate:true},null],['dimension_mismatch',{fixture:'synthetic.png',width:3},null],['cancelled',{fixture:'synthetic.png',cancel:true},null],['semantic_verified',{fixture:'gray.png',semantic:true,expectedHash:sha(grayExpected)},'semantic'],['semantic_wrong_hash',{fixture:'gray.png',semantic:true,expectedHash:'01'.repeat(32)},null]];
if(!realMissing)cases.push(['real_texture43',{fixture:'real.png',width:256,height:512},'2bec9517bbabc4a5ef619c67b1e481808b2e5aaf4ad9e85e4deadbd34970faa8']);
for(const[name,input,expected]of cases){console.log('PNG readiness case: '+name);const value=await page.evaluate(input=>new Promise((resolve,reject)=>{const worker=new Worker('/proof-worker.js',{type:'module'});const timeout=setTimeout(()=>{worker.terminate();reject(Error('Worker proof timeout'));},30000);worker.onmessage=({data})=>{clearTimeout(timeout);worker.terminate();resolve(data);};worker.onerror=e=>{clearTimeout(timeout);worker.terminate();reject(Error(e.message));};worker.postMessage(input);}),input);const pass=expected===null?!value.ok:expected==='semantic'?value.ok&&value.verified===1&&value.unchanged:value.ok&&value.sha256===expected&&value.unchanged;result.checks.push({name,pass,...value});if(!pass)throw Error(name+': '+JSON.stringify(value));}
result.status=realMissing?'NOT_RUN_REAL_FIXTURE':'pass';await page.close();
}catch(e){result.status='failed';result.error=String(e.stack);process.exitCode=1;}finally{if(browser)await browser.close();await server.close();result.production_source_unchanged=before===sha(readFileSync(sourceFile));writeFileSync(out+'/result.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({status:result.status,checks:result.checks.length,output:out}));if(realMissing)process.exitCode=2;}
