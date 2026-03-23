const initSqlJs = require('./extension/node_modules/sql.js');
const fs = require('fs');
const path = require('path');
const dbPath = path.join(process.env.APPDATA, 'Antigravity', 'User', 'globalStorage', 'state.vscdb');

(async () => {
  const SQL = await initSqlJs();
  const buf = fs.readFileSync(dbPath);
  const db = new SQL.Database(buf);
  
  const stmt = db.prepare('SELECT key FROM ItemTable');
  const allKeys = [];
  while (stmt.step()) allKeys.push(String(stmt.get()[0]));
  stmt.free();
  
  const pattern = /quota|model|tier|cascade|userStatus|planStatus|capacity|usage|credit|remaining|accountInfo/i;
  const matched = allKeys.filter(k => pattern.test(k));
  
  console.log('총 키:', allKeys.length, '매칭:', matched.length);
  
  for (const k of matched) {
    const s2 = db.prepare('SELECT value FROM ItemTable WHERE key = ?');
    s2.bind([k]);
    if (s2.step()) {
      const val = String(s2.get()[0]);
      console.log('\nKEY:', k);
      console.log('VAL:', val.substring(0, 500));
    }
    s2.free();
  }
  
  console.log('\n=== antigravity 키 목록 ===');
  allKeys.filter(k => /antigravity|jetski|tfa\./i.test(k)).forEach(k => console.log(k));
  
  db.close();
  console.log('\nDONE');
})().catch(e => console.error('ERR:', e.message));
