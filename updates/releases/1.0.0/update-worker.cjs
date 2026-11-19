const fs=require('node:fs'),path=require('node:path');
const {readJSON,writeJSON,validateManifest,sha256,APP_FILES}=require('./security.cjs');
function rollbackLast(root) {
  const folder=path.join(root,'Data','Updates'),installed=readJSON(path.join(folder,'last-install.json'));
  if(!/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(installed.version))throw new Error('Invalid rollback version.');
  const backup=path.join(folder,'rollback-'+installed.version);
  for(const name of APP_FILES)fs.copyFileSync(path.join(backup,name),path.join(root,name));
  writeJSON(path.join(folder,'blocked-version.json'),{version:installed.version,reason:'New version did not start. Previous files restored.',at:new Date().toISOString()});
  fs.unlinkSync(path.join(folder,'last-install.json'));
  return {rolledBack:true};
}
function applyUpdate(root) {
  const folder=path.join(root,'Data','Updates'),pendingFile=path.join(folder,'pending.json'),journalFile=path.join(folder,'transaction.json');
  // Recover a file transaction interrupted by a power loss. Data is never rolled back.
  if(fs.existsSync(journalFile)) {
    const journal=readJSON(journalFile);
    if(!/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(journal.version))throw new Error('Invalid recovery journal.');
    const backup=path.join(folder,'rollback-'+journal.version);
    for(const name of APP_FILES)fs.copyFileSync(path.join(backup,name),path.join(root,name));
    fs.unlinkSync(journalFile);
  }
  if(!fs.existsSync(pendingFile))return {applied:false};
  const pending=readJSON(pendingFile);
  if(!/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(pending.version))throw new Error('Invalid pending version.');
  const stage=path.join(folder,'stage-'+pending.version),release=readJSON(path.join(root,'release.json'));
  const manifest=validateManifest(readJSON(path.join(stage,'signed-manifest.json')),readJSON(path.join(root,'trust.json')).updatePublicKey,release.version);
  if(manifest.version!==pending.version)throw new Error('Pending version mismatch.');
  for(const file of manifest.files){const bytes=fs.readFileSync(path.join(stage,file.path));if(bytes.length!==file.size||sha256(bytes)!==file.sha256)throw new Error('Staged update is damaged.');}
  const next=readJSON(path.join(stage,'release.json'));
  if(next.version!==manifest.version||next.product!==release.product||next.manifestUrl!==release.manifestUrl)throw new Error('Invalid staged release configuration.');
  for(const name of APP_FILES.filter(name=>name.endsWith('.cjs')))require('node:child_process').execFileSync(process.execPath,['--check',path.join(stage,name)],{stdio:'pipe',windowsHide:true});
  const backup=path.join(folder,'rollback-'+manifest.version);fs.mkdirSync(backup,{recursive:true});
  for(const name of APP_FILES)fs.copyFileSync(path.join(root,name),path.join(backup,name));
  const database=path.join(root,'Data','payroll.sqlite');
  if(fs.existsSync(database)) {
    const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(database);
    try{const checkpoint=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();if(checkpoint.busy)throw new Error('Payroll is still open. Close it before updating.');}finally{db.close();}
    fs.copyFileSync(database,path.join(backup,'payroll-before-update.sqlite'));
  }
  writeJSON(journalFile,{version:manifest.version});
  try {
    for(const name of APP_FILES)fs.copyFileSync(path.join(stage,name),path.join(root,name));
    fs.unlinkSync(pendingFile);fs.unlinkSync(journalFile);
    writeJSON(path.join(folder,'last-install.json'),{version:manifest.version,installedAt:new Date().toISOString()});
    return {applied:true,version:manifest.version};
  }catch(error){
    for(const name of APP_FILES)fs.copyFileSync(path.join(backup,name),path.join(root,name));
    fs.unlinkSync(journalFile);throw error;
  }
}
if(require.main===module){try{console.log(JSON.stringify(process.argv.includes('--rollback-last')?rollbackLast(__dirname):applyUpdate(__dirname)));}catch(error){console.error('Update postponed: '+error.message);process.exitCode=1;}}
module.exports={applyUpdate,rollbackLast};
