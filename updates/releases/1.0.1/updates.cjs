const fs=require('node:fs'),path=require('node:path');
const {readJSON,writeJSON,validateManifest,compareVersions,sha256}=require('./security.cjs');
async function download(url,maxBytes,request=fetch) {
  const parsed=new URL(url);if(parsed.protocol!=='https:'||parsed.username||parsed.password)throw new Error('Update address must use HTTPS.');
  const response=await request(url,{redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error('Update service returned HTTP '+response.status+'.');
  const chunks=[];let total=0;
  for await(const chunk of response.body){total+=chunk.length;if(total>maxBytes)throw new Error('Update download exceeded its size limit.');chunks.push(Buffer.from(chunk));}
  return Buffer.concat(chunks);
}
function createUpdater(root,request=fetch) {
  const folder=path.join(root,'Data','Updates');fs.mkdirSync(folder,{recursive:true});
  const release=readJSON(path.join(root,'release.json'));
  const key=readJSON(path.join(root,'trust.json')).updatePublicKey;
  let busy=false,status={currentVersion:release.version,configured:!!release.manifestUrl,lastCheck:null,message:release.manifestUrl?'Updates will be checked automatically.':'Supplier has not configured the update service.'};
  function pending(){try{return readJSON(path.join(folder,'pending.json'));}catch{return null;}}
  function getStatus(){return {...status,readyVersion:pending()?.version||null};}
  async function check() {
    if(busy)return getStatus();if(!release.manifestUrl)return getStatus();busy=true;
    try {
      const envelope=JSON.parse((await download(release.manifestUrl,250000,request)).toString('utf8'));
      // Authenticate even when the feed advertises the current version.
      const info=require('./security.cjs').verifyEnvelope(envelope,key);
      if(info.type!=='update')throw new Error('Invalid update feed.');
      if(compareVersions(info.version,release.version)<=0){status.message='This installation is up to date.';return getStatus();}
      const manifest=validateManifest(envelope,key,release.version);
      try{if(readJSON(path.join(folder,'blocked-version.json')).version===manifest.version){status.message='This update failed to start previously. Your previous version was restored. Contact your supplier for a newer release.';return getStatus();}}catch(error){if(error.code!=='ENOENT')throw error;}
      if(pending()?.version===manifest.version){status.message='Update ready. Use Restart and install when payroll is saved.';return getStatus();}
      const stage=path.join(folder,'stage-'+manifest.version);fs.mkdirSync(stage,{recursive:true});
      for(const file of manifest.files) {
        const bytes=await download(file.url,file.size,request);
        if(bytes.length!==file.size||sha256(bytes)!==file.sha256)throw new Error('Update checksum verification failed.');
        fs.writeFileSync(path.join(stage,file.path),bytes);
      }
      const next=readJSON(path.join(stage,'release.json'));
      if(next.version!==manifest.version||next.product!==release.product||next.manifestUrl!==release.manifestUrl)throw new Error('Release configuration does not match update feed.');
      writeJSON(path.join(stage,'signed-manifest.json'),envelope);
      writeJSON(path.join(folder,'pending.json'),{version:manifest.version});
      status.message='Verified update downloaded. It installs at the next restart.';
    }catch(error){status.message='Update check failed: '+error.message;}
    finally{busy=false;status.lastCheck=new Date().toISOString();}
    return getStatus();
  }
  return {check,getStatus};
}
module.exports={download,createUpdater};
