/** Portable, dependency-free catalog gate. Never executes submitted package code. */
import {readFile, readdir, lstat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const hash = /^[a-f0-9]{64}$/;
const sha = /^[a-f0-9]{40}$/;
const fail = message => { throw new Error(message); };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const stable = x => Array.isArray(x) ? x.map(stable) : object(x) ? Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])) : x;
const same = (a,b) => equal(stable(a),stable(b));
const newer = (a,b) => { const x=a.split('.').map(BigInt),y=b.split('.').map(BigInt); for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i];return false; };
const relative = name => { if(typeof name!=='string'||!name||name.includes('\\')||name.includes(':')||name.includes('\0')||name.split('/').some(x=>!x||x==='.'||x==='..'))fail(`Unsafe package path: ${name}`);return name; };
const repoName = /^[-\w.]+\/[-\w.]+$/;
const https = value => { const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.hash)fail('Expected credential-free HTTPS URL');return u; };
const read = async (root,name,cap=1024*1024) => {
  relative(name);let current=root;
  for(const part of name.split('/')){current=path.join(current,part);if((await lstat(current)).isSymbolicLink())fail(`Links are not allowed: ${name}`);}
  const st=await lstat(current);if(!st.isFile()||st.size>cap)fail(`Invalid or oversized file: ${name}`);
  return readFile(current);
};
async function records(root){
  const result=new Map();
  let dirs;try{dirs=await readdir(path.join(root,'records'));}catch(e){if(e.code==='ENOENT')return result;throw e;}
  for(const id of dirs){relative(id);if((await lstat(path.join(root,'records',id))).isSymbolicLink())fail('Record symlink');
    for(const name of await readdir(path.join(root,'records',id))){const key=`records/${id}/${name}`;const entry=JSON.parse(await read(root,key));if(name!==`${entry.version}.json`||id!==entry.id)fail(`Record identity mismatch: ${key}`);result.set(key,entry);}}
  return result;
}
function entryCheck(e,policy){
  if(!object(e)||!/^[a-z][a-z0-9-]{0,47}$/.test(e.id))fail('Invalid plugin id');
  for(const field of ['name','publisher','description'])if(typeof e[field]!=='string'||!e[field].trim())fail(`Missing ${field}: ${e.id}`);
  if(!version.test(e.version)||!sha.test(e.sha)||!repoName.test(e.repo))fail(`Invalid release identity: ${e.id}`);
  if(!['assets','publishing','tools','analytics','other'].includes(e.category)||!['official','community'].includes(e.tier))fail(`Invalid classification: ${e.id}`);
  if(!Array.isArray(e.capabilities)||e.capabilities.some(c=>typeof c!=='string')||new Set(e.capabilities).size!==e.capabilities.length)fail(`Invalid capabilities: ${e.id}`);
  if(e.subdir!==undefined)relative(e.subdir);
  if(e.minStudioVersion!==undefined&&!version.test(e.minStudioVersion))fail('Invalid minimum Studio version');
  if(e.docsUrl!==undefined)https(e.docsUrl);
  if(!object(e.artifact)||!hash.test(e.artifact.sha256))fail(`Curated releases require an artifact digest: ${e.id}`);
  const url=https(e.artifact.url);
  if(!policy.artifactOrigins.includes(url.origin))fail(`Unapproved artifact origin: ${url.origin}`);
  if(!url.pathname.endsWith(`/${e.id}/${e.version}/${e.artifact.sha256}.json`)||url.search)fail('Artifact URL must contain immutable id/version/digest path');
  const official=officialFor(policy,e.id);
  if(official&&(e.tier!=='official'||e.publisher!==official.publisher||!official.repos.includes(e.repo)))fail(`Reserved official identity: ${e.id}`);
  if(e.tier==='official'&&!official)fail(`Official identity not approved: ${e.id}`);
  // An official repository hosts only its official ids: no other id may borrow its provenance.
  if(!official&&Object.values(policy.official).some(o=>o.repos.some(r=>r.toLowerCase()===e.repo.toLowerCase())))fail(`Official source reserved: ${e.id}`);
}
/** The reservation for an official id: its publisher and its repositories, current first. */
const officialFor = (policy,id) => Object.hasOwn(policy.official,id)?policy.official[id]:undefined;
/**
 * The repository a record's identity names. An official id's repositories (current first, then
 * where it used to live) are one source, so moving the source keeps its identity and history.
 */
const sourceRepo = (policy,e) => { const official=officialFor(policy,e.id);return official?.repos.includes(e.repo)?official.repos[0]:e.repo; };
/** One shape: `official[id] = {publisher, repos: [current, ...legacy]}`; the old single `repo` is refused. */
function policyCheck(policy){
  if(!Array.isArray(policy.artifactOrigins)||!object(policy.official))fail('Invalid maintainer policy');
  for(const o of Object.values(policy.official))
    if(!object(o)||typeof o.publisher!=='string'||!o.publisher||!Array.isArray(o.repos)||!o.repos.length||o.repos.some(r=>typeof r!=='string'||!repoName.test(r))||new Set(o.repos).size!==o.repos.length||Object.hasOwn(o,'repo'))fail('Invalid maintainer policy');
}
/** Check one release's envelope bytes against its record: digest, size, safe paths and the manifest's identity. */
export async function checkArtifact(e,bytes){
  if(bytes.length>256*1024*1024||createHash('sha256').update(bytes).digest('hex')!==e.artifact.sha256)fail(`Artifact digest/size mismatch: ${e.id}`);
  const files=JSON.parse(bytes);if(!object(files)||!Object.hasOwn(files,'plugin.json'))fail('Invalid envelope');
  const decoded=new Map();
  for(const [name,data]of Object.entries(files)){relative(name);if(typeof data!=='string')fail('Invalid base64');const b=Buffer.from(data,'base64');if(b.toString('base64')!==data)fail('Non-canonical base64');decoded.set(name,b);}
  const m=JSON.parse(decoded.get('plugin.json'));
  if(![1,2,3].includes(m.apiVersion))fail('Unsupported plugin API');
  for(const k of ['id','version','publisher'])if(m[k]!==e[k])fail(`Manifest ${k} mismatch`);
  if(!Array.isArray(m.capabilities)||!same([...m.capabilities].sort(),[...e.capabilities].sort()))fail('Manifest capabilities mismatch');
  if(m.backend){relative(m.backend);if(!decoded.has(m.backend))fail('Missing backend');}
  return {id:e.id,version:e.version,files:decoded.size,bytes:bytes.length};
}
/**
 * `allowPendingNew` (with `remote` and `previous`): a release that is new since `previous` and whose
 * artifact the host answers 404 for is reported in `pending` rather than failed, because a maintainer
 * uploads a reviewed community artifact only after review. A released artifact is never pending.
 * @param {{root:string, previous?:string, policyRoot?:string, artifacts?:string, remote?:boolean, allowPendingNew?:boolean, fetch?:typeof globalThis.fetch}} options
 */
export async function checkCatalog({root,previous=undefined,policyRoot=root,artifacts=undefined,remote=false,allowPendingNew=false,fetch:download=globalThis.fetch}){
  const policy=JSON.parse(await read(policyRoot,'policy.json'));
  policyCheck(policy);
  const index=JSON.parse(await read(root,'index.json'));
  if(index.version!==1||!Array.isArray(index.plugins)||!Number.isFinite(Date.parse(index.updatedAt)))fail('Invalid index');
  const all=await records(root),ids=new Set();
  for(const e of all.values())entryCheck(e,policy);
  const owners=new Map();
  for(const e of all.values()){
    const identity={publisher:e.publisher,repo:sourceRepo(policy,e),subdir:e.subdir??'',tier:e.tier};
    if(owners.has(e.id)&&!same(owners.get(e.id),identity))fail(`Publisher/source ownership changed: ${e.id}`);
    owners.set(e.id,identity);
  }
  for(const e of index.plugins){entryCheck(e,policy);if(ids.has(e.id))fail('Duplicate plugin id');ids.add(e.id);
    if(!same(all.get(`records/${e.id}/${e.version}.json`),e))fail(`Missing/mismatched immutable record: ${e.id}`);}
  // Compare every historical record, including withdrawn entries, so identities cannot be recycled.
  const old=previous?await records(previous):new Map();
  if(previous){for(const [key,e]of old){if(!same(all.get(key),e))fail(`Released record changed or removed: ${key}`);}
    for(const e of all.values())for(const p of old.values())if(e.id===p.id){
      if(e.publisher!==p.publisher||sourceRepo(policy,e)!==sourceRepo(policy,p)||(e.subdir??'')!==(p.subdir??'')||e.tier!==p.tier)fail(`Publisher/source ownership changed: ${e.id}`);
      if(!old.has(`records/${e.id}/${e.version}.json`)&&!newer(e.version,p.version))fail(`New release must have a higher version: ${e.id}`);
    }
    // Legacy repositories are only for records already released; a new release names the current one.
    for(const [key,e]of all){const official=officialFor(policy,e.id);if(official&&!old.has(key)&&e.repo!==official.repos[0])fail(`Official release must name ${official.repos[0]}: ${e.id}`);}
  }
  for(const e of index.plugins)for(const p of all.values())if(e.id===p.id&&newer(p.version,e.version))fail(`Index cannot downgrade ${e.id}; publish a corrective patch`);
  const verified=[],pending=[];
  for(const [key,e]of all){let bytes;
    if(artifacts)bytes=await read(artifacts,`${e.id}/${e.version}/${e.artifact.sha256}.json`,256*1024*1024);
    else if(remote){const res=await download(e.artifact.url,{redirect:'error',signal:AbortSignal.timeout(300000)});
      if(res.status===404&&allowPendingNew&&previous&&!old.has(key)){pending.push({id:e.id,version:e.version,url:e.artifact.url});continue;}
      if(!res.ok)fail(`Artifact HTTP ${res.status}`);
      const chunks=[];let size=0;for await(const chunk of res.body){size+=chunk.length;if(size>256*1024*1024){fail('Artifact too large');}chunks.push(chunk);}bytes=Buffer.concat(chunks);}
    if(bytes)verified.push(await checkArtifact(e,bytes));
  }
  return {ok:true,entries:index.plugins.length,records:all.size,artifactsVerified:verified,pending,limitation:'Static release gate only; does not execute code, certify safety, or prove public installation.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{const args=process.argv.slice(2);const value=key=>{const i=args.indexOf(key);return i<0?undefined:args[i+1];};const root=value('--root');if(!root)fail('Usage: node scripts/check-catalog.mjs --root DIR [--previous BASE] [--policy-root BASE] [--artifacts DIR | --remote [--allow-pending-new]]');
    console.log(JSON.stringify(await checkCatalog({root,previous:value('--previous'),policyRoot:value('--policy-root')??root,artifacts:value('--artifacts'),remote:args.includes('--remote'),allowPendingNew:args.includes('--allow-pending-new')}),null,2));
  }catch(e){console.error(e.message);process.exitCode=1;}
}
