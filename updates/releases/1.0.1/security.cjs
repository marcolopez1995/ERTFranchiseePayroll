const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const {execFileSync} = require('node:child_process');
const PRODUCT = 'ck-franchise-payroll';
const APP_FILES = ['app.html','setup.html','activation.html','manage.html','server.cjs','security.cjs','updates.cjs','update-worker.cjs','launch.ps1','Start Payroll.cmd','Read Me.txt','release.json'];
const INSTALL_FILES = [...APP_FILES,'install.ps1','Install.cmd','verify-package.cjs','trust.json','Trust-Publisher.ps1','Trust Publisher Certificate.cmd','runtime/node.exe','runtime/LICENSE.txt'];
const OPTIONAL_INSTALL_FILES = ['Publisher.cer','Publisher-Fingerprint.txt'];
function readJSON(file) {return JSON.parse(fs.readFileSync(file,'utf8'));}
function writeJSON(file,value) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=file+'.tmp'; fs.writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600}); fs.renameSync(temp,file);
}
function verifyEnvelope(envelope,publicKey) {
  if(!publicKey)throw new Error('Publisher setup is required. Contact your supplier.');
  if(!envelope || typeof envelope.payload!=='string' || typeof envelope.signature!=='string' || envelope.payload.length>200000)
    throw new Error('Invalid signed document.');
  const bytes=Buffer.from(envelope.payload,'base64url');
  if(!crypto.verify(null,bytes,publicKey,Buffer.from(envelope.signature,'base64url')))throw new Error('Signature verification failed.');
  const value=JSON.parse(bytes.toString('utf8'));
  if(value.product!==PRODUCT)throw new Error('This document is for a different product.');
  return value;
}
function machineId() {
  // MachineGuid is hashed locally. Raw Windows identifiers never leave the computer.
  let identity;
  if(process.platform==='win32') {
    const reg=path.join(process.env.SystemRoot||'C:\\Windows','System32','reg.exe');
    const result=execFileSync(reg,['query','HKLM\\SOFTWARE\\Microsoft\\Cryptography','/v','MachineGuid','/reg:64'],{encoding:'utf8',windowsHide:true});
    identity=result.match(/MachineGuid\s+REG_SZ\s+(\S+)/i)?.[1];
    if(!identity)throw new Error('Windows device ID is unavailable.');
  } else identity=os.hostname();
  return crypto.createHash('sha256').update(PRODUCT+'|'+identity).digest('hex').toUpperCase();
}
function validateLicense(envelope,publicKey,device,now=new Date()) {
  const license=verifyEnvelope(envelope,publicKey);
  if(license.type!=='license' || !/^[A-Z0-9-]{6,80}$/.test(license.licenseId||'') ||
    typeof license.business!=='string' || !license.business.trim() || license.business.length>80 ||
    (license.maxStores!=null&&(!Number.isSafeInteger(license.maxStores)||license.maxStores<1)) ||
    !/^[A-F0-9]{64}$/.test(license.deviceId||'') || license.deviceId!==device)
    throw new Error('License does not match this computer or contains invalid limits.');
  if(!/^\d{4}-\d{2}-\d{2}T/.test(license.issuedAt||'') || !Number.isFinite(Date.parse(license.issuedAt)))throw new Error('Invalid license date.');
  if(license.expiresAt!==null) {
    if(typeof license.expiresAt!=='string'||!Number.isFinite(Date.parse(license.expiresAt)))throw new Error('Invalid license expiry.');
    if(now.getTime()>=Date.parse(license.expiresAt))throw new Error('License expired. Backups remain available; contact your supplier to renew.');
  }
  // Legacy signed licenses stay valid; this edition no longer enforces store counts.
  return {...license,maxStores:null};
}
function licenseStatus(root,device=machineId()) {
  try {return {active:true,deviceId:device,license:validateLicense(readJSON(path.join(root,'Data/license.json')),readJSON(path.join(root,'trust.json')).licensePublicKey,device)};}
  catch(error){return {active:false,deviceId:device,error:error.code==='ENOENT'?'Activation is required.':error.message};}
}
function validateState(value,license) {
  const state=JSON.parse(value),config=state.configuration;
  if(!config || config.business!==license.business || !Array.isArray(config.stores) ||
    config.stores.length<1 ||
    config.stores.some(s=>typeof s!=='string'||!s.trim()||s.length>70||/[\\/:*?"<>|]/.test(s)) ||
    new Set(config.stores.map(s=>s.trim().toUpperCase())).size!==config.stores.length)
    throw new Error('Use your licensed business name and at least one unique, valid store name.');
  const deductionKeys=['sss','phic','hdmf','sssLoan','hdmfLoan','uniform','advance','late','savings','shortages','orientation'];
  function policy(raw){
    if(!raw||!Array.isArray(raw.enabled)||raw.enabled.some(key=>!deductionKeys.includes(key))||new Set(raw.enabled).size!==raw.enabled.length||!Number.isFinite(raw.defaultSavings)||raw.defaultSavings<0||raw.defaultSavings>999999||!Number.isFinite(raw.reserve)||raw.reserve<0||raw.reserve>9999999||!Number.isInteger(raw.minSavingsDays)||raw.minSavingsDays<1||raw.minSavingsDays>7)throw new Error('Invalid franchisee deduction settings.');
  }
  if(config.deductionSettings!==undefined)policy(config.deductionSettings);
  if(config.deductionWeeks!==undefined){
    if(!config.deductionWeeks||typeof config.deductionWeeks!=='object'||Array.isArray(config.deductionWeeks))throw new Error('Invalid deduction history.');
    for(const [id,value] of Object.entries(config.deductionWeeks)){if(!/^20\d{2}-(0[1-9]|1[0-2]):[0-4]$/.test(id))throw new Error('Invalid deduction history week.');policy(value);}
  }
  return state;
}
function compareVersions(a,b) {
  const parse=v=>{if(!/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(v))throw new Error('Invalid release version.');return v.split('.').map(Number);};
  const x=parse(a),y=parse(b);for(let i=0;i<3;i++){if(x[i]!==y[i])return Math.sign(x[i]-y[i]);}return 0;
}
function validateManifest(envelope,key,currentVersion) {
  const manifest=verifyEnvelope(envelope,key);
  if(manifest.type!=='update'||compareVersions(manifest.version,currentVersion)<=0)throw new Error('Release is not newer than the installed version.');
  if(!Array.isArray(manifest.files)||manifest.files.length!==APP_FILES.length)throw new Error('Incomplete update.');
  const seen=new Set();let total=0;
  for(const file of manifest.files) {
    if(!APP_FILES.includes(file.path)||seen.has(file.path)||!Number.isSafeInteger(file.size)||file.size<1||file.size>15*1024*1024||!/^[a-f0-9]{64}$/.test(file.sha256))throw new Error('Unsafe update file.');
    const url=new URL(file.url);if(url.protocol!=='https:'||url.username||url.password||url.hash)throw new Error('Update files require HTTPS.');
    seen.add(file.path); total+=file.size;
  }
  if(total>30*1024*1024)throw new Error('Update is too large.');
  return manifest;
}
function sha256(bytes){return crypto.createHash('sha256').update(bytes).digest('hex');}
module.exports={PRODUCT,APP_FILES,INSTALL_FILES,OPTIONAL_INSTALL_FILES,readJSON,writeJSON,verifyEnvelope,machineId,validateLicense,licenseStatus,validateState,compareVersions,validateManifest,sha256};
