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
const token = crypto.randomBytes(32).toString("hex");
const device=machineId();
const release=readJSON(path.join(__dirname,'release.json'));
const updater=createUpdater(__dirname);
let restarting=false;
const supportScript=`window.productRequest=async function(url,body){const response=await fetch(url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Payroll-Token':${JSON.stringify(token)}},body:body===undefined?undefined:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw new Error(result.error||'Request failed.');return result;};`;
const storageScript = `
const payrollStorage = (() => {
  const revisions = new Map();
  function request(method, key, value) {
    const xhr = new XMLHttpRequest();
    xhr.open(method, "/state", false);
    xhr.setRequestHeader("X-Payroll-Token", "${token}");
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.send(JSON.stringify({key, value, revision: revisions.get(key) ?? 0}));
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
`;
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
  if(req.method==='GET'&&req.url==='/support.js')return respond(res,200,supportScript,'text/javascript');
  if(req.method==='GET'&&req.url==='/product')return respond(res,200,{...licenseStatus(__dirname,device),version:release.version,updates:updater.getStatus()});
  if(req.method==='GET'&&req.url==='/manage')return respond(res,200,page('manage.html'),'text/html');
  if(req.url==='/activate'&&req.method==='POST'){
    if(req.headers['x-payroll-token']!==token)return respond(res,403,{error:'Invalid local request.'});
    bodyJSON(req,30000).then(envelope=>{
      const license=validateLicense(envelope,readJSON(path.join(__dirname,'trust.json')).licensePublicKey,device);
      const existing=db.prepare('SELECT value FROM settings WHERE key=?').get('crispy-king-payroll-periods-v2');
      if(existing&&JSON.parse(existing.value).configuration?.business!==license.business)throw new Error('License business does not match existing payroll. Your records were kept.');
      if(existing&&JSON.parse(existing.value).configuration?.stores.length>license.maxStores)throw new Error('This license permits fewer stores than your current records.');
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
  if(restarting)return respond(res,503,{error:'Restart in progress. Your records are saved.'});
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
    return respond(res, 200, storageScript, "text/javascript");
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
