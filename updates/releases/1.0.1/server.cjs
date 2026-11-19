const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const {readJSON,writeJSON,licenseStatus,validateLicense,validateState,machineId}=require('./security.cjs');
const {createUpdater}=require('./updates.cjs');
const {spawn}=require('node:child_process');

const port = Number(process.env.CK_PAYROLL_PORT || 17862);
const origin = "http://127.0.0.1:" + port;
const dataDirectory = path.join(__dirname, "Data");
fs.mkdirSync(dataDirectory, { recursive: true });
const db = new DatabaseSync(path.join(dataDirectory, "payroll.sqlite"));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, revision INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS recovery (id INTEGER PRIMARY KEY, created TEXT NOT NULL, value TEXT NOT NULL);`);
db.exec('CREATE TABLE IF NOT EXISTS lifecycle (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
db.prepare('INSERT OR IGNORE INTO lifecycle(key,value) VALUES(?,?)').run('generation',crypto.randomUUID());
function generation(){return db.prepare('SELECT value FROM lifecycle WHERE key=?').get('generation').value;}
let token = crypto.randomBytes(32).toString("hex");
const device=machineId();
const release=readJSON(path.join(__dirname,'release.json'));
const updater=createUpdater(__dirname);
let restarting=false,resetInProgress=false;
function supportScript(){return `window.productRequest=async function(url,body){const response=await fetch(url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Payroll-Token':${JSON.stringify(token)}},body:body===undefined?undefined:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw new Error(result.error||'Request failed.');return result;};`;}
function storageScript(){return `
const payrollStorage = (() => {
  const revisions = new Map();
  const generation = ${JSON.stringify(generation())};
  function request(method, key, value) {
    const xhr = new XMLHttpRequest();
    xhr.open(method, "/state", false);
    xhr.setRequestHeader("X-Payroll-Token", "${token}");
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.send(JSON.stringify({key, value, revision: revisions.get(key) ?? 0, generation}));
    const result = JSON.parse(xhr.responseText || "{}");
    if (xhr.status !== 200) {
      const message = result.error || "Database unavailable. Back up entries before closing.";
      if (method === "PUT") alert(message);
      throw new Error(message);
    }
    revisions.set(key, result.revision);
    return result.value;
  }
  return {
    getItem(key) { return request("POST", key); },
    setItem(key, value) { request("PUT", key, value); }
  };
})();
`;}
function resetSnapshot(){return {generation:generation(),rows:db.prepare('SELECT key,value,revision FROM settings ORDER BY key').all()};}
function resetPreview(){
  const row=db.prepare('SELECT value,revision FROM settings WHERE key=?').get('crispy-king-payroll-periods-v2');
  if(!row)throw new Error('This installation is already at first-use setup.');
  const state=JSON.parse(row.value);
  return {business:state.configuration?.business||'',generation:generation(),revision:row.revision,stores:state.configuration?.stores?.length||0,crewAssignments:(state.roster||[]).reduce((n,rows)=>n+(rows?.length||0),0),payrollMonths:Object.keys(state.periods||{}).length};
}
function factoryReset(payload){
  if(payload?.confirmation!=='RESET ALL DATA'||payload?.acknowledged!==true)throw new Error('Type RESET ALL DATA and acknowledge that business records will be cleared.');
  const preview=resetPreview();
  if(payload.generation!==preview.generation||payload.revision!==preview.revision||payload.business!==preview.business){const error=new Error('Records changed in another tab. Reopen Factory Reset and review the latest records before confirming.');error.status=409;throw error;}
  const before=resetSnapshot(),folderName=new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomBytes(4).toString('hex');
  const folder=path.join(dataDirectory,'FactoryResetBackups',folderName);fs.mkdirSync(folder,{recursive:true});
  // An independent, verified SQLite copy is completed before any rows are cleared.
  const backupFile=path.join(folder,'payroll-before-reset.sqlite');
  db.prepare('VACUUM INTO ?').run(backupFile);
  const checked=new DatabaseSync(backupFile,{readOnly:true});
  try{if(checked.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw new Error('Recovery backup verification failed. Records were not reset.');}finally{checked.close();}
  const primary=before.rows.find(row=>row.key==='crispy-king-payroll-periods-v2');
  if(primary){const state=JSON.parse(primary.value);writeJSON(path.join(folder,'Payroll_Entries_Before_Reset.json'),{...state,version:2});}
  const sqliteSha256=crypto.createHash('sha256').update(fs.readFileSync(backupFile)).digest('hex');
  writeJSON(path.join(folder,'Reset_Backup_Info.json'),{product:release.product,createdAt:new Date().toISOString(),business:preview.business,sqliteSha256,licenseRetained:true,completed:false});
  db.exec('BEGIN IMMEDIATE');
  try{
    if(JSON.stringify(resetSnapshot())!==JSON.stringify(before)){const error=new Error('Records changed while backing up. Reset was cancelled; reopen and try again.');error.status=409;throw error;}
    db.exec('DELETE FROM settings; DELETE FROM recovery;');
    db.prepare('UPDATE lifecycle SET value=? WHERE key=?').run(crypto.randomUUID(),'generation');
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  // Invalidate tokens and generations held by old tabs so they cannot re-save cleared data.
  token=crypto.randomBytes(32).toString('hex');
  try{writeJSON(path.join(folder,'Reset_Backup_Info.json'),{product:release.product,createdAt:new Date().toISOString(),business:preview.business,sqliteSha256,licenseRetained:true,completed:true});}catch{}
  return {reset:true,backupFolder:'Data/FactoryResetBackups/'+folderName,licenseRetained:true};
}
function respond(res, status, body, type = "application/json") {
  res.writeHead(status, {
    "Content-Type": type + "; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "frame-ancestors 'none'",
  });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}
function page(name){let html=fs.readFileSync(path.join(__dirname,name),'utf8');
  if(['app.html','setup.html'].includes(name))html=html.replace('<body>','<body><nav style="padding:10px 20px;background:#fff1c9;text-align:right;font:14px Arial"><a href="/manage">License, backup and updates</a></nav>');
  return html;
}
async function bodyJSON(req,limit=100*1024*1024){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw new Error('Request is too large.');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
const server = http.createServer((req, res) => {
  if (req.headers.host !== "127.0.0.1:" + port ||
      (req.headers.origin && req.headers.origin !== origin)) {
    return respond(res, 403, { error: "Local access only." });
  }
  if (req.method === "GET" && req.url === "/health") {
    return respond(res, 200, { app: "Crispy King Local Payroll", storage: "SQLite",version:release.version });
  }
  if(req.method==='GET'&&req.url==='/support.js')return respond(res,200,supportScript(),'text/javascript');
  if(req.method==='GET'&&req.url==='/product')return respond(res,200,{...licenseStatus(__dirname,device),version:release.version,updates:updater.getStatus()});
  if(req.method==='GET'&&req.url==='/manage')return respond(res,200,page('manage.html'),'text/html');
  if(req.method==='POST'&&['/factory-reset/preview','/factory-reset'].includes(req.url)){
    if(req.headers['x-payroll-token']!==token)return respond(res,403,{error:'Invalid or expired local session. Reload before continuing.'});
    if(!licenseStatus(__dirname,device).active)return respond(res,403,{error:'Activate this installation before resetting its records.'});
    if(resetInProgress||restarting)return respond(res,409,{error:'Another reset or restart is in progress.'});
    const isPreview=req.url.endsWith('/preview');
    bodyJSON(req,20000).then(payload=>{
      if(req.headers['x-payroll-token']!==token)return respond(res,403,{error:'Session changed. Reload before continuing.'});
      if(resetInProgress||restarting)return respond(res,409,{error:'Another reset or restart is in progress.'});
      if(isPreview)return respond(res,200,resetPreview());
      resetInProgress=true;
      try{respond(res,200,factoryReset(payload));}finally{resetInProgress=false;}
    }).catch(error=>respond(res,error.status||400,{error:error.message}));return;
  }
  if(req.url==='/activate'&&req.method==='POST'){
    if(req.headers['x-payroll-token']!==token)return respond(res,403,{error:'Invalid local request.'});
    bodyJSON(req,30000).then(envelope=>{
      const license=validateLicense(envelope,readJSON(path.join(__dirname,'trust.json')).licensePublicKey,device);
      const existing=db.prepare('SELECT value FROM settings WHERE key=?').get('crispy-king-payroll-periods-v2');
      if(existing&&JSON.parse(existing.value).configuration?.business!==license.business)throw new Error('License business does not match existing payroll. Your records were kept.');
      writeJSON(path.join(dataDirectory,'license.json'),envelope);respond(res,200,{active:true});
    }).catch(error=>respond(res,400,{error:error.message}));return;
  }
  if(req.url==='/backup'&&req.method==='POST'){
    if(req.headers['x-payroll-token']!==token)return respond(res,403,{error:'Invalid local request.'});
    const row=db.prepare('SELECT value FROM settings WHERE key=?').get('crispy-king-payroll-periods-v2');
    return respond(res,200,{value:row?.value||null});
  }
  if(req.method==='POST'&&req.url==='/updates/check'){
    if(req.headers['x-payroll-token']!==token)return respond(res,403,{error:'Invalid local request.'});
    updater.check().then(status=>respond(res,200,status)).catch(error=>respond(res,500,{error:error.message}));return;
  }
  if(req.method==='POST'&&req.url==='/updates/restart'){
    if(req.headers['x-payroll-token']!==token)return respond(res,403,{error:'Invalid local request.'});
    if(restarting||!updater.getStatus().readyVersion)return respond(res,409,{error:'No pending update or a restart is already underway.'});
    restarting=true;respond(res,200,{restarting:true});
    // Run a trusted local launcher after this server releases SQLite and its port.
    const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    setTimeout(()=>server.close(()=>{
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();
      const child=spawn(powershell,['-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',path.join(__dirname,'launch.ps1')],{detached:true,stdio:'ignore',windowsHide:true});
      child.on('error',()=>{});child.unref();process.exit(0);
    }),100);return;
  }
  const activation=licenseStatus(__dirname,device);
  if(!activation.active){
    if(req.method==='GET'&&req.url==='/')return respond(res,200,page('activation.html'),'text/html');
    return respond(res,403,{error:activation.error});
  }
  if(restarting||resetInProgress)return respond(res,503,{error:'Restart or reset in progress. Reload before continuing.'});
  if (req.method === "GET" && req.url === "/configuration.js") {
    let configuration = null;
    const row = db.prepare("SELECT value FROM settings WHERE key=?").get("crispy-king-payroll-periods-v2");
    if (row) configuration = JSON.parse(row.value).configuration || null;
    return respond(res, 200, "window.customerConfiguration=" + JSON.stringify(configuration) + ";window.customerLicense="+JSON.stringify({maxStores:activation.license.maxStores})+";", "text/javascript");
  }
  if (req.method === "GET" && req.url === "/") {
    const row = db.prepare("SELECT value FROM settings WHERE key=?").get("crispy-king-payroll-periods-v2");
    if (!row || !JSON.parse(row.value).configuration) {
      return respond(res, 200, page('setup.html'), "text/html");
    }
    return respond(res, 200, page('app.html'), "text/html");
  }
  if (req.method === "GET" && req.url === "/local-storage.js") {
    return respond(res, 200, storageScript(), "text/javascript");
  }
  if (req.url !== "/state" || !["POST", "PUT"].includes(req.method) ||
      req.headers["x-payroll-token"] !== token) {
    return respond(res, 403, { error: "Invalid local request." });
  }
  const chunks = [];
  let size = 0;
  req.on("data", chunk => {
    size += chunk.length;
    if (size > 100 * 1024 * 1024) { req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on("end", () => {
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if(req.headers['x-payroll-token']!==token||payload.generation!==generation())return respond(res,409,{error:'This session is from before a reset or reload. Back up unsaved entries if needed, then reload; old records cannot be saved into the reset installation.'});
      if (!["crispy-king-payroll-periods-v2", "crispy-king-payroll-2026-11-v1"].includes(payload.key)) {
        return respond(res, 400, { error: "Unknown record." });
      }
      if (req.method === "POST") {
        const row = db.prepare("SELECT value, revision FROM settings WHERE key=?").get(payload.key);
        return respond(res, 200, row || { value: null, revision: 0 });
      }
      if (typeof payload.value !== "string" || !Number.isInteger(payload.revision)) {
        return respond(res, 400, { error: "Invalid saved data." });
      }
      try{validateState(payload.value,activation.license);}catch(error){return respond(res,400,{error:error.message});}
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db.prepare("SELECT value, revision FROM settings WHERE key=?").get(payload.key);
        if ((row?.revision || 0) !== payload.revision) {
          db.exec("ROLLBACK");
          return respond(res, 409, { error: "Another tab saved changes. Back up this tab's entries, then reload before continuing." });
        }
        if (row) {
          db.prepare("INSERT INTO recovery(created,value) VALUES(?,?)").run(new Date().toISOString(), row.value);
          db.exec("DELETE FROM recovery WHERE id NOT IN (SELECT id FROM recovery ORDER BY id DESC LIMIT 20)");
        }
        const revision = payload.revision + 1;
        db.prepare("INSERT INTO settings VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, revision=excluded.revision")
          .run(payload.key, payload.value, revision);
        db.exec("COMMIT");
        respond(res, 200, { value: null, revision });
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    } catch (error) {
      respond(res, 500, { error: "Could not save to SQLite. Keep this window open and use Back up entries." });
    }
  });
});
server.listen(port, "127.0.0.1");
server.on("error", error => { console.error(error.message); process.exitCode = 1; });
setTimeout(()=>updater.check(),3000).unref();
setInterval(()=>updater.check(),6*60*60*1000).unref();
