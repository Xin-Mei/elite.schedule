// ============================================================
// 金鶯診所 排班系統 - Apps Script Web App  (v4: 統一登入)
// 部署為網頁應用程式 (Web App), 存取權設為「所有人」
//
// v4 更新重點:
//   * verifyEmployee 現在同時處理「管理員」與「員工」兩條路徑
//     - meiiibaiii / meiiibaiii000 → role: 'admin'
//     - 外部員工 DB (員工編號 + 密碼) → role: 'employee' (含姓名與職稱)
//   * 新增 EMPLOYEE_DB_TITLE_COL = 6 (F欄,職稱)
// ============================================================
const SHEET_ID = '185n5fkfH-D5v_qW8umgBfyNaodBEQIVbuGAG2Ad5Cz4';

// 員工資料庫 (外部 sheet) — 用於員工身分驗證
// A 欄 = 員工編號, B 欄 = 姓名, F 欄 = 職稱, AK 欄 = 密碼
const EMPLOYEE_DB_ID = '10pCbLqrev7mKVRPI68NtXAaddYxzAkxsrmlEHGuI-pg';
const EMPLOYEE_DB_ID_COL    = 1;   // A 欄 (員工編號)
const EMPLOYEE_DB_NAME_COL  = 2;   // B 欄 (姓名)
const EMPLOYEE_DB_TITLE_COL = 6;   // F 欄 (職稱)
const EMPLOYEE_DB_PWD_COL   = 37;  // AK 欄 (A=1, B=2, ..., Z=26, AA=27, ..., AK=37)

// 內建管理員帳號 (硬寫死於程式中,確保即使 _帳號 sheet 被誤改也能登入)
const HARDCODED_ADMIN_ID  = 'meiiibaiii';
const HARDCODED_ADMIN_PWD = 'meiiibaiii000';

const SHEETS = {
  SETTINGS: '_設定',
  SCHEDULE: '_班表',
  SWAPS:    '_換班紀錄',
  LEAVES:   '_請假紀錄',  // 保留給舊資料相容 (生理假/病假/喪假/婚假/育嬰假/產假/產檢假/安胎假)
  SHORTAGES:'_缺人紀錄',  // v5: 「缺人」獨立成自己的 sheet,避免與真正的請假混淆
  ACCOUNTS: '_帳號',
  PERIODS:  '_工時區間',  // 全院區共用八週區間
  PATTERNS: '_輪班循環',  // 同職位共用輪班循環設定 (可有多筆)
  STARTS:   '_員工起始',   // 同職位 ABCD 各組的起始位置
  LOGINLOG: '_登入紀錄'   // 登入 log
};

const HEADERS = {
  '_設定':       ['branch','position','data'],
  '_班表':       ['branch','position','periodStart','data'],
  '_換班紀錄':   ['id','branch','position','date','shift','originalName','reason','mode','swapWith','coverName','note','status','createdAt','operator'],
  '_請假紀錄':   ['id','branch','position','date','shift','originalName','reason','mode','swapWith','coverName','note','status','createdAt','operator'],
  '_缺人紀錄':   ['id','branch','position','date','shift','originalName','reason','mode','swapWith','coverName','note','status','createdAt','operator'],
  '_帳號':       ['account','password','name','role','branch','position','active'],
  '_工時區間':   ['startDate','note'],
  '_輪班循環':   ['position','pattern','note'],         // pattern = 6 字串如 "早早晚晚休休"
  '_員工起始':   ['position','patternKey','group','startIndex','note'],  // 對應 _輪班循環 的 patternKey (note 欄)
  '_登入紀錄':   ['timestamp','account','name','role','jobTitle','result','ip','userAgent']
};

// =================== Endpoints ===================
function doGet(e){
  const action = (e.parameter.action || 'all').toLowerCase();
  try{
    ensureAllSheets();
    let payload;
    if(action==='all'){
      // 通用 helper:把字串型 swapWith 解析回 array
      const parseSwapWith = (s) => {
        let sw = s.swapWith;
        if(typeof sw === 'string' && sw){
          try { sw = JSON.parse(sw); } catch(_){ sw = sw.split(',').map(x=>x.trim()).filter(Boolean); }
        }
        return Object.assign({}, s, {swapWith: Array.isArray(sw) ? sw : []});
      };
      payload = {
        settings:  readSheet(SHEETS.SETTINGS),
        schedules: readSheet(SHEETS.SCHEDULE),
        swaps:     readSheet(SHEETS.SWAPS).map(parseSwapWith),
        leaves:    readSheet(SHEETS.LEAVES).map(parseSwapWith),
        shortages: readSheet(SHEETS.SHORTAGES).map(parseSwapWith),
        globalPeriods: readSheet(SHEETS.PERIODS),
        globalPatterns: readSheet(SHEETS.PATTERNS),
        globalStarts: readSheet(SHEETS.STARTS),
        accounts:  readSheet(SHEETS.ACCOUNTS).map(a=>({
          account:a.account, name:a.name, role:a.role,
          branch:a.branch, position:a.position, active:a.active
        }))
      };
    }else if(action==='settings'){ payload = readSheet(SHEETS.SETTINGS); }
    else if(action==='schedules'){ payload = readSheet(SHEETS.SCHEDULE); }
    else if(action==='swaps'){     payload = readSheet(SHEETS.SWAPS); }
    else if(action==='leaves'){    payload = readSheet(SHEETS.LEAVES); }
    else if(action==='shortages'){ payload = readSheet(SHEETS.SHORTAGES); }
    return jsonOut({ok:true, data:payload});
  }catch(err){ return jsonOut({ok:false, error: String(err)}); }
}

function doPost(e){
  try{
    ensureAllSheets();
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    if(action==='login'){
      const res = doLogin(body.account, body.password);
      logLogin(res, body.account, e);
      return jsonOut(res);
    }
    if(action==='verifyEmployee'){
      const res = verifyEmployee(body.employeeId, body.password);
      logLogin(res, body.employeeId, e);
      return jsonOut(res);
    }
    if(action==='saveSettings'){ saveSettings(body.branch, body.position, body.data); return jsonOut({ok:true}); }
    if(action==='saveSchedule'){ saveSchedule(body.branch, body.position, body.periodStart, body.data); return jsonOut({ok:true}); }
    if(action==='addSwap'){      addSwap(body.record); return jsonOut({ok:true}); }
    if(action==='deleteSwap'){   deleteSwapOrLeave(body.id); return jsonOut({ok:true}); }
    if(action==='updateSwapStatus'){
      const found = updateSwapStatus(body.id, body.status);
      return jsonOut({ok: found, error: found ? '' : '找不到紀錄 (可能 id 不存在或 status 欄位未建立)'});
    }
    if(action==='addLeave'){     addLeave(body.record); return jsonOut({ok:true}); }
    if(action==='updateLeaveStatus'){
      // v4: 不再是 no-op,改為轉呼叫 updateSwapStatus,讓兩種紀錄統一處理
      const found = updateSwapStatus(body.id, body.status);
      return jsonOut({ok: found, error: found ? '' : '找不到紀錄'});
    }
    if(action==='upsertAccount'){ upsertAccount(body.record); return jsonOut({ok:true}); }
    if(action==='deleteAccount'){ deleteAccount(body.account); return jsonOut({ok:true}); }
    throw new Error('Unknown action: '+action);
  }catch(err){ return jsonOut({ok:false, error: String(err)}); }
}

// =================== Auth ===================
// 舊版管理員登入 (保留給後台診斷工具使用,不再被前端主流程呼叫)
function doLogin(account, password){
  const sh = getOrCreate(SHEETS.ACCOUNTS, HEADERS[SHEETS.ACCOUNTS]);
  const all = sh.getDataRange().getValues();
  for(let i=1; i<all.length; i++){
    const r = all[i];
    if(String(r[0]) === String(account) && String(r[1]) === String(password)){
      const active = (r[6]===''||r[6]===true||r[6]==='TRUE'||r[6]==='Y');
      if(!active) return {ok:false, error:'帳號已停用'};
      const role = String(r[3] || '').trim().toLowerCase();
      if(role !== 'admin'){
        return {ok:false, error:'此帳號非管理員,無法登入後台'};
      }
      return {ok:true, user:{
        account:r[0], name:r[2], role:r[3],
        branch:r[4]||'', position:r[5]||''
      }};
    }
  }
  return {ok:false, error:'帳號或密碼錯誤'};
}

// =================== 統一登入入口 (前端主流程使用) ===================
// 依輸入的帳號自動分流為「管理員」或「員工」
//   1. 若帳號 = HARDCODED_ADMIN_ID 且密碼正確 → role: 'admin'
//   2. 否則查 _帳號 sheet 中 role=admin 的記錄是否相符 → role: 'admin' (備援)
//   3. 否則查外部員工資料庫 (A欄編號 + AK欄密碼) → role: 'employee' (附姓名與職稱)
function verifyEmployee(employeeId, password){
  if(!employeeId || !password){
    return {ok:false, error:'請輸入員工編號與密碼'};
  }
  const idStr  = String(employeeId).trim();
  const pwdStr = String(password).trim();

  // ── Path 1: 內建管理員 (硬寫死) ──────────────────────────────
  if(idStr === HARDCODED_ADMIN_ID && pwdStr === HARDCODED_ADMIN_PWD){
    return {
      ok: true,
      user: {
        account: HARDCODED_ADMIN_ID,
        employeeId: HARDCODED_ADMIN_ID,
        name: '系統管理員',
        jobTitle: '系統管理員',
        role: 'admin'
      }
    };
  }

  // ── Path 2: _帳號 sheet 中的 admin / manager 帳號 (備援,允許之後新增其他管理員) ──
  // role 欄位可為:
  //   • 'admin'   全院區管理權限
  //   • 'manager' 中階主管:可進後台,但只能管理 branch 欄位指定的院區
  //               (branch 欄位以逗號/空格/頓號分隔多個院區,例如「三樹,土城」)
  try {
    const sh = getOrCreate(SHEETS.ACCOUNTS, HEADERS[SHEETS.ACCOUNTS]);
    const all = sh.getDataRange().getValues();
    for(let i=1; i<all.length; i++){
      const r = all[i];
      if(String(r[0]).trim() === idStr && String(r[1]).trim() === pwdStr){
        const active = (r[6]===''||r[6]===true||r[6]==='TRUE'||r[6]==='Y');
        const role = String(r[3] || '').trim().toLowerCase();
        if(active && role === 'admin'){
          return {
            ok: true,
            user: {
              account: r[0],
              employeeId: r[0],
              name: r[2] || '管理員',
              jobTitle: '系統管理員',
              role: 'admin'
            }
          };
        }
        if(active && role === 'manager'){
          return {
            ok: true,
            user: {
              account: r[0],
              employeeId: r[0],
              name: r[2] || '中階主管',
              jobTitle: '中階主管',
              role: 'manager',
              // 把可管理院區字串原樣帶到前端 (前端會再 split 解析)
              branch: String(r[4] || '').trim()
            }
          };
        }
        // 找到帳號但不是 admin/manager 或已停用 → 不直接擋,讓他繼續走員工 DB 查詢
        break;
      }
    }
  } catch(_){
    // 即使 _帳號 sheet 讀失敗也不要擋住員工登入流程
  }

  // ── Path 3: 外部員工資料庫驗證 ──────────────────────────────
  try {
    const ss = SpreadsheetApp.openById(EMPLOYEE_DB_ID);
    const sh = ss.getSheets()[0]; // 預設第一個分頁
    if(!sh) return {ok:false, error:'員工資料庫無法存取'};

    const lastRow = sh.getLastRow();
    if(lastRow < 2) return {ok:false, error:'員工資料庫無資料'};

    // 一次讀取需要的欄位範圍 (A欄員工編號 ~ AK欄密碼)
    const lastCol = Math.max(EMPLOYEE_DB_PWD_COL, EMPLOYEE_DB_NAME_COL, EMPLOYEE_DB_TITLE_COL);
    const data = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();

    for(let i=0; i<data.length; i++){
      const row = data[i];
      const rowId = String(row[EMPLOYEE_DB_ID_COL - 1] || '').trim();
      if(!rowId) continue;
      if(rowId === idStr){
        // 員工編號比中 → 比對密碼
        const rowPwd = String(row[EMPLOYEE_DB_PWD_COL - 1] || '').trim();
        if(rowPwd === pwdStr){
          const rowName  = String(row[EMPLOYEE_DB_NAME_COL  - 1] || '').trim();
          const rowTitle = String(row[EMPLOYEE_DB_TITLE_COL - 1] || '').trim();
          return {
            ok: true,
            user: {
              employeeId: idStr,
              name: rowName || idStr,
              jobTitle: rowTitle || '員工',
              role: 'employee'
            }
          };
        }
        // 編號對但密碼錯
        return {ok:false, error:'員工編號或密碼錯誤'};
      }
    }
    // 找不到員工編號 — 為避免洩漏,統一回傳同一段錯誤訊息
    return {ok:false, error:'員工編號或密碼錯誤'};
  } catch(err){
    return {ok:false, error:'員工資料庫連線失敗:' + String(err)};
  }
}

// =================== 登入紀錄 ===================
// 每次登入嘗試 (成功/失敗) 都記錄到 _登入紀錄 sheet
// res    = verifyEmployee/doLogin 的回傳結果 {ok, user?, error?}
// account = 使用者輸入的帳號/員工編號
// e      = doPost 的 event 物件 (用於取 userAgent — Apps Script 取不到真實 IP)
function logLogin(res, account, e){
  try {
    const sh = getOrCreate(SHEETS.LOGINLOG, HEADERS[SHEETS.LOGINLOG]);
    const ok = res && res.ok;
    const user = (res && res.user) || {};
    // Apps Script 無法可靠取得 client IP;userAgent 也常被隱藏,盡力而為
    let ua = '';
    try {
      if(e && e.postData && e.postData.contents){
        const b = JSON.parse(e.postData.contents);
        ua = String(b.userAgent || '').slice(0, 300);
      }
    } catch(_){}
    sh.appendRow([
      new Date(),                              // timestamp
      String(account || '').slice(0, 60),      // account (輸入的帳號)
      ok ? (user.name || '') : '',             // name
      ok ? (user.role || '') : '',             // role
      ok ? (user.jobTitle || '') : '',         // jobTitle
      ok ? '成功' : ('失敗:' + (res && res.error ? res.error : '未知')),  // result
      '',                                      // ip (Apps Script 無法取得,留空)
      ua                                       // userAgent
    ]);
  } catch(err){
    // 記錄失敗不可影響登入流程
  }
}


/**
 * 帳號診斷工具 — 在 Apps Script 中手動執行,可看到 _帳號 sheet 中所有資料
 * 用法:選擇 diagAccounts → ▶ 執行 → 看「執行記錄」
 */
function diagAccounts(){
  const sh = getOrCreate(SHEETS.ACCOUNTS, HEADERS[SHEETS.ACCOUNTS]);
  const all = sh.getDataRange().getValues();
  Logger.log('=== _帳號 sheet 內容 ===');
  Logger.log('總列數: ' + all.length);
  for(let i=0; i<all.length; i++){
    const r = all[i];
    Logger.log(`第 ${i+1} 列: account="${r[0]}" pwd="${r[1]}" name="${r[2]}" role="${r[3]}" branch="${r[4]}" position="${r[5]}" active="${r[6]}"`);
  }

  Logger.log('\n=== 測試管理員登入 (verifyEmployee) ===');
  const t1 = verifyEmployee(HARDCODED_ADMIN_ID, HARDCODED_ADMIN_PWD);
  Logger.log('verifyEmployee("meiiibaiii", "meiiibaiii000") = ' + JSON.stringify(t1));

  Logger.log('\n=== 測試錯誤密碼 ===');
  const t2 = verifyEmployee(HARDCODED_ADMIN_ID, 'wrongpwd');
  Logger.log('verifyEmployee("meiiibaiii", "wrongpwd") = ' + JSON.stringify(t2));
}

/**
 * 員工資料庫驗證測試 — 用於確認 sheet 連線與欄位對應正確
 * 用法:選擇 diagEmployeeDB → ▶ 執行 → 看「執行記錄」
 */
function diagEmployeeDB(){
  try {
    const ss = SpreadsheetApp.openById(EMPLOYEE_DB_ID);
    const sh = ss.getSheets()[0];
    Logger.log('員工資料庫 Sheet 名稱: ' + sh.getName());
    Logger.log('總列數: ' + sh.getLastRow());
    Logger.log('總欄數: ' + sh.getLastColumn());

    // 印出表頭 (第 1 列) 與第一筆資料 (第 2 列) 用於確認欄位對應
    const lastCol = Math.max(EMPLOYEE_DB_PWD_COL, EMPLOYEE_DB_NAME_COL, EMPLOYEE_DB_TITLE_COL);
    const hdr = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    Logger.log('\n=== 欄位對應檢查 ===');
    Logger.log(`A 欄 (員工編號) [idx=${EMPLOYEE_DB_ID_COL}]: "${hdr[EMPLOYEE_DB_ID_COL-1]}"`);
    Logger.log(`B 欄 (姓名)     [idx=${EMPLOYEE_DB_NAME_COL}]: "${hdr[EMPLOYEE_DB_NAME_COL-1]}"`);
    Logger.log(`F 欄 (職稱)     [idx=${EMPLOYEE_DB_TITLE_COL}]: "${hdr[EMPLOYEE_DB_TITLE_COL-1]}"`);
    Logger.log(`AK 欄 (密碼)    [idx=${EMPLOYEE_DB_PWD_COL}]: "${hdr[EMPLOYEE_DB_PWD_COL-1]}"`);

    if(sh.getLastRow() >= 2){
      const firstRow = sh.getRange(2, 1, 1, lastCol).getValues()[0];
      Logger.log('\n=== 第 2 列範例資料 ===');
      Logger.log(`員工編號: "${firstRow[EMPLOYEE_DB_ID_COL-1]}"`);
      Logger.log(`姓名:    "${firstRow[EMPLOYEE_DB_NAME_COL-1]}"`);
      Logger.log(`職稱:    "${firstRow[EMPLOYEE_DB_TITLE_COL-1]}"`);
      Logger.log(`密碼:    "${firstRow[EMPLOYEE_DB_PWD_COL-1]}" (字數=${String(firstRow[EMPLOYEE_DB_PWD_COL-1]||'').length})`);
    }
    Logger.log('\n✅ 員工資料庫連線成功');
  } catch(err){
    Logger.log('❌ 員工資料庫連線失敗: ' + err);
  }
}

/**
 * 一鍵建立/重設管理員帳號 — 確保 meiiibaiii 帳號存在於 _帳號 sheet
 * (即便不存在,因為硬寫死於程式中,登入仍可正常使用)
 * 用法:選擇 ensureAdminAccount → ▶ 執行
 */
function ensureAdminAccount(){
  const sh = getOrCreate(SHEETS.ACCOUNTS, HEADERS[SHEETS.ACCOUNTS]);
  const all = sh.getDataRange().getValues();
  let found = false;
  for(let i=1; i<all.length; i++){
    if(String(all[i][0]).trim() === HARDCODED_ADMIN_ID){
      sh.getRange(i+1, 1, 1, 7).setValues([[
        HARDCODED_ADMIN_ID, HARDCODED_ADMIN_PWD, '系統管理員', 'admin', '', '', true
      ]]);
      Logger.log('已更新既有 ' + HARDCODED_ADMIN_ID + ' 帳號 (第 ' + (i+1) + ' 列)');
      found = true;
      break;
    }
  }
  if(!found){
    sh.appendRow([HARDCODED_ADMIN_ID, HARDCODED_ADMIN_PWD, '系統管理員', 'admin', '', '', true]);
    Logger.log('已新增 ' + HARDCODED_ADMIN_ID + ' 帳號');
  }

  const test = verifyEmployee(HARDCODED_ADMIN_ID, HARDCODED_ADMIN_PWD);
  Logger.log('登入測試: ' + JSON.stringify(test));
  if(test.ok){
    Logger.log('✅ 帳號設定成功!現在可以用 ' + HARDCODED_ADMIN_ID + ' / ' + HARDCODED_ADMIN_PWD + ' 登入');
  } else {
    Logger.log('❌ 登入仍失敗: ' + test.error);
  }
}

// =================== Account management ===================
function upsertAccount(rec){
  const sh = getOrCreate(SHEETS.ACCOUNTS, HEADERS[SHEETS.ACCOUNTS]);
  const all = sh.getDataRange().getValues();
  for(let i=1; i<all.length; i++){
    if(String(all[i][0])===String(rec.account)){
      sh.getRange(i+1, 1, 1, 7).setValues([[rec.account, rec.password, rec.name, rec.role, rec.branch||'', rec.position||'', rec.active!==false]]);
      return;
    }
  }
  sh.appendRow([rec.account, rec.password, rec.name, rec.role, rec.branch||'', rec.position||'', rec.active!==false]);
}

function deleteAccount(account){
  const sh = getOrCreate(SHEETS.ACCOUNTS, HEADERS[SHEETS.ACCOUNTS]);
  const all = sh.getDataRange().getValues();
  for(let i=1; i<all.length; i++){
    if(String(all[i][0])===String(account)){ sh.deleteRow(i+1); return; }
  }
}

// =================== Sheet helpers ===================
function ensureAllSheets(){
  Object.keys(HEADERS).forEach(name => getOrCreate(name, HEADERS[name]));
  // 預設管理員帳號 (即使不存在,verifyEmployee 也能用硬寫死那組登入)
  const sh = getOrCreate(SHEETS.ACCOUNTS, HEADERS[SHEETS.ACCOUNTS]);
  if(sh.getLastRow() < 2){
    sh.appendRow([HARDCODED_ADMIN_ID, HARDCODED_ADMIN_PWD, '系統管理員', 'admin', '', '', true]);
  }
}

function getOrCreate(name, headers){
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sh = ss.getSheetByName(name);
  if(!headers && typeof HEADERS !== 'undefined' && HEADERS[name]) headers = HEADERS[name];
  if(!headers || !headers.length) return sh;
  if(!sh){
    sh = ss.insertSheet(name);
    sh.getRange(1,1,1,headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    sh.getRange(1,1,1,headers.length).setFontWeight('bold').setBackground('#eaf6f5');
  } else {
    const lastCol = sh.getLastColumn();
    if(lastCol < headers.length){
      for(let i = lastCol; i < headers.length; i++){
        sh.getRange(1, i+1).setValue(headers[i])
          .setFontWeight('bold').setBackground('#eaf6f5');
      }
    }
  }
  return sh;
}

/**
 * 重整欄位順序 — 偵測並修復欄位順序錯亂的問題。
 * 用法:repairSheetHeaders() 或 repairSheetHeaders('_請假紀錄')
 */
function repairSheetHeaders(sheetName){
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const targetSheets = sheetName ? [sheetName] : Object.keys(HEADERS);

  targetSheets.forEach(name => {
    const expectedHdr = HEADERS[name];
    if(!expectedHdr){ Logger.log('Skip ' + name + ' — no schema defined'); return; }
    const sh = ss.getSheetByName(name);
    if(!sh){ Logger.log('Skip ' + name + ' — sheet does not exist'); return; }
    const range = sh.getDataRange();
    const all = range.getValues();
    if(all.length < 1){
      sh.getRange(1,1,1,expectedHdr.length).setValues([expectedHdr])
        .setFontWeight('bold').setBackground('#eaf6f5');
      Logger.log('Wrote header for empty sheet ' + name);
      return;
    }

    const currentHdr = all[0].map(h => String(h || '').trim());
    const expected = expectedHdr.map(h => String(h).trim());
    const isPerfect = (currentHdr.length === expected.length) &&
                      currentHdr.every((h, i) => h === expected[i]);
    if(isPerfect){ Logger.log('OK ' + name + ' — header already correct'); return; }

    Logger.log('REPAIR ' + name + ':');
    Logger.log('  current : [' + currentHdr.join(', ') + ']');
    Logger.log('  expected: [' + expected.join(', ') + ']');

    const dataRows = all.slice(1).filter(r => r.some(c => c !== '' && c !== null));
    const remappedRows = dataRows.map(row => {
      const newRow = new Array(expected.length).fill('');
      currentHdr.forEach((oldName, oldIdx) => {
        const newIdx = expected.indexOf(oldName);
        if(newIdx >= 0) newRow[newIdx] = row[oldIdx];
      });
      return newRow;
    });

    sh.clear();
    sh.getRange(1, 1, 1, expected.length).setValues([expected])
      .setFontWeight('bold').setBackground('#eaf6f5');
    sh.setFrozenRows(1);
    if(remappedRows.length){
      sh.getRange(2, 1, remappedRows.length, expected.length).setValues(remappedRows);
      ['date','periodStart','startDate'].forEach(colName => {
        const ci = expected.indexOf(colName);
        if(ci >= 0) sh.getRange(2, ci+1, remappedRows.length, 1).setNumberFormat('@');
      });
    }
    Logger.log('  → rebuilt ' + remappedRows.length + ' data rows');
  });

  Logger.log('repairSheetHeaders complete.');
}

function readSheet(name){
  const sh = getOrCreate(name, HEADERS[name]);
  const range = sh.getDataRange().getValues();
  if(range.length<2) return [];
  const hdr = range[0];
  return range.slice(1).filter(r=>r.some(c=>c!=='')).map(r=>{
    const o={}; hdr.forEach((h,i)=>{
      let v = r[i];
      if(v instanceof Date){
        if(h==='periodStart' || h==='date' || h==='startDate'){
          v = formatDate(v);
        } else {
          v = v.toISOString();
        }
      }
      o[h] = v;
    });
    return o;
  });
}

function formatDate(d){
  return Utilities.formatDate(d, Session.getScriptTimeZone() || 'Asia/Taipei', 'yyyy-MM-dd');
}

function saveSettings(branch, position, data){
  const sh = getOrCreate(SHEETS.SETTINGS, HEADERS[SHEETS.SETTINGS]);
  const all = sh.getDataRange().getValues();
  for(let i=1;i<all.length;i++){
    if(all[i][0]===branch && all[i][1]===position){
      sh.getRange(i+1, 3).setValue(JSON.stringify(data)); return;
    }
  }
  sh.appendRow([branch, position, JSON.stringify(data)]);
}

function saveSchedule(branch, position, periodStart, data){
  const sh = getOrCreate(SHEETS.SCHEDULE, HEADERS[SHEETS.SCHEDULE]);
  const psStr = String(periodStart || '');
  const all = sh.getDataRange().getValues();
  for(let i=1;i<all.length;i++){
    const existing = all[i][2];
    const existingStr = (existing instanceof Date) ? formatDate(existing) : String(existing);
    if(all[i][0]===branch && all[i][1]===position && existingStr===psStr){
      sh.getRange(i+1, 3).setNumberFormat('@').setValue(psStr);
      sh.getRange(i+1, 4).setValue(JSON.stringify(data));
      return;
    }
  }
  const newRow = sh.getLastRow() + 1;
  sh.getRange(newRow, 1, 1, 4).setValues([[branch, position, psStr, JSON.stringify(data)]]);
  sh.getRange(newRow, 3).setNumberFormat('@');
}

// =================== Swap / Leave / Shortage records ===================
// 共用的寫入工具:依 record 內容決定要寫到哪張 sheet
//   • mode === 'leave' && reason === '缺人'      → _缺人紀錄
//   • mode === 'leave' (其他假別)                  → _請假紀錄
//   • 其他 (mode === 'swap' / 'support')           → _換班紀錄
function pickRecordSheet(rec){
  if(rec.mode === 'leave'){
    if(String(rec.reason || '').trim() === '缺人') return SHEETS.SHORTAGES;
    return SHEETS.LEAVES;
  }
  // 私事支援 (mode='support'):屬於請假/代班類紀錄,寫入 _請假紀錄
  if(rec.mode === 'support'){
    return SHEETS.LEAVES;
  }
  // 其他 (mode='swap' 等) → _換班紀錄
  return SHEETS.SWAPS;
}

function appendRecordRow(sheetName, rec, idPrefix){
  const sh = getOrCreate(sheetName, HEADERS[sheetName]);
  const id = rec.id || (idPrefix + Date.now());
  const swapWithStr = JSON.stringify(rec.swapWith || []);
  const newRow = sh.getLastRow() + 1;
  sh.getRange(newRow, 1, 1, 13).setValues([[
    id,
    rec.branch || '',
    rec.position || '',
    String(rec.date || ''),
    rec.shift || '',
    rec.originalName || '',
    rec.reason || '',
    rec.mode || '',
    swapWithStr,
    rec.coverName || '',
    rec.note || '',
    rec.status || '',
    rec.createdAt || new Date().toISOString()
  ]]);
  sh.getRange(newRow, 4).setNumberFormat('@');
  // v6: 若該 sheet 的 schema 含 operator 欄 (目前僅 _缺人紀錄),寫入操作者
  const __hdr = HEADERS[sheetName] || [];
  const __opCol = __hdr.indexOf('operator');
  if(__opCol >= 0){
    sh.getRange(newRow, __opCol + 1).setValue(rec.operator || '');
  }
}

function addSwap(rec){
  const target = pickRecordSheet(rec);
  // 若被分流到 _缺人紀錄,id 前綴用 'X' (shortage),其他維持 'S' / 'L'
  const prefix = (target === SHEETS.SHORTAGES) ? 'X'
               : (target === SHEETS.LEAVES)    ? 'L'
               : 'S';
  appendRecordRow(target, rec, prefix);
}

function addLeave(rec){
  // 為了向下相容前端的 'addLeave' action(舊路徑),仍走自動分流
  if(!rec.mode) rec.mode = 'leave';
  const target = pickRecordSheet(rec);
  const prefix = (target === SHEETS.SHORTAGES) ? 'X'
               : (target === SHEETS.LEAVES)    ? 'L'
               : 'S';
  appendRecordRow(target, rec, prefix);
}

function updateSwapStatus(id, status){
  const idStr = String(id || '').trim();
  if(!idStr) return false;
  for(const sheetName of [SHEETS.SWAPS, SHEETS.LEAVES, SHEETS.SHORTAGES]){
    const sh = getOrCreate(sheetName, HEADERS[sheetName]);
    if(!sh) continue;
    const range = sh.getDataRange();
    const all = range.getValues();
    if(all.length < 1) continue;
    const hdr = all[0];
    let statusCol = hdr.indexOf('status') + 1;
    if(statusCol === 0){
      const newColIdx = hdr.length + 1;
      sh.getRange(1, newColIdx).setValue('status').setFontWeight('bold').setBackground('#eaf6f5');
      statusCol = newColIdx;
    }
    for(let i=1;i<all.length;i++){
      if(String(all[i][0]).trim() === idStr){
        sh.getRange(i+1, statusCol).setValue(status);
        return true;
      }
    }
  }
  return false;
}

// 統一處理 — 跨三張 sheet 刪除 (_換班/_請假/_缺人)
function deleteSwapOrLeave(id){
  for(const sheetName of [SHEETS.SWAPS, SHEETS.LEAVES, SHEETS.SHORTAGES]){
    const sh = getOrCreate(sheetName, HEADERS[sheetName]);
    if(!sh) continue;
    const all = sh.getDataRange().getValues();
    for(let i=1;i<all.length;i++){
      if(String(all[i][0])===String(id)){ sh.deleteRow(i+1); return; }
    }
  }
}

function jsonOut(obj){
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// 第一次部署後請手動執行此函式以授權與初始化各分頁
function setup(){
  ensureAllSheets();
  Logger.log('Setup complete. Default admin: ' + HARDCODED_ADMIN_ID + ' / ' + HARDCODED_ADMIN_PWD);
}

/**
 * ============================================================
 * 一次性遷移工具 — 把舊的「缺人」紀錄搬到新的 _缺人紀錄 sheet
 * ============================================================
 * 用法 (在 Apps Script 編輯器中):
 *   1) 先試跑(乾跑模式,只讀不寫):
 *        migrateShortageRecords(true)
 *      → 看「執行記錄」確認會搬哪些,確定無誤再進入正式搬移
 *
 *   2) 正式搬移(會實際寫入並刪除原列):
 *        migrateShortageRecords(false)
 *      或省略參數:
 *        migrateShortageRecords()
 *
 * 安全機制:
 *   • 若某筆 id 已存在於 _缺人紀錄 → 跳過複製,但仍從原 sheet 刪除
 *     (dedup: 防重複搬移)
 *   • 從下往上刪除來源列,避免索引錯位
 *   • 全程 try/catch + Logger,即使某張 sheet 出錯也不影響另一張
 *   • 不動到「非缺人」的列 (reason !== '缺人' 的不會被誤刪)
 */
function migrateShortageRecords(dryRun){
  const isDry = (dryRun === true);
  Logger.log('=== migrateShortageRecords ' + (isDry ? '(DRY RUN — 乾跑模式,不會修改 Sheet)' : '(正式搬移,會修改 Sheet)') + ' ===');

  // 確保 _缺人紀錄 已存在 (帶正確 schema)
  const dest = getOrCreate(SHEETS.SHORTAGES, HEADERS[SHEETS.SHORTAGES]);
  const destHdr = HEADERS[SHEETS.SHORTAGES];

  // 先建立目的地的 id 索引 (避免重複搬移)
  const existingIds = new Set();
  {
    const all = dest.getDataRange().getValues();
    for(let i=1; i<all.length; i++){
      const id = String(all[i][0] || '').trim();
      if(id) existingIds.add(id);
    }
  }
  Logger.log('_缺人紀錄 目前已有 ' + existingIds.size + ' 筆');

  let totalCopied = 0;
  let totalSkipped = 0;  // 已存在 → 不複製但會從原 sheet 刪除
  let totalDeleted = 0;
  let totalScanned = 0;

  // 掃描兩張來源:_換班紀錄、_請假紀錄
  const sources = [SHEETS.SWAPS, SHEETS.LEAVES];
  sources.forEach(srcName => {
    Logger.log('\n--- 掃描 ' + srcName + ' ---');
    const sh = getOrCreate(srcName, HEADERS[srcName]);
    const all = sh.getDataRange().getValues();
    if(all.length < 2){
      Logger.log('  (空 sheet,跳過)');
      return;
    }
    const hdr = all[0].map(h => String(h || '').trim());
    // 找關鍵欄位的 index (依欄名,不假設順序)
    const colIdx = {};
    ['id','reason','branch','position','date','originalName','mode'].forEach(name => {
      colIdx[name] = hdr.indexOf(name);
    });
    if(colIdx.reason < 0){
      Logger.log('  ⚠️  此 sheet 沒有 reason 欄位,跳過');
      return;
    }

    // 收集所有 reason='缺人' 的列 (rowIdx 從 1 起算,即 sheet 上的實際行號)
    const targets = [];  // {rowIdx (1-based), record obj, id}
    for(let i=1; i<all.length; i++){
      const row = all[i];
      const reason = String(row[colIdx.reason] || '').trim();
      if(reason !== '缺人') continue;
      totalScanned++;

      // 把整列轉成 record 物件 (依 hdr 對應)
      const rec = {};
      hdr.forEach((h, j) => {
        let v = row[j];
        // 日期型別轉字串
        if(v instanceof Date){
          if(h === 'date' || h === 'periodStart'){
            v = formatDate(v);
          } else if(h === 'createdAt'){
            v = v.toISOString();
          }
        }
        rec[h] = v;
      });
      const id = String(rec.id || '').trim();
      targets.push({rowIdx: i + 1, rec: rec, id: id});
    }
    Logger.log('  找到 ' + targets.length + ' 筆 reason=缺人 的紀錄');

    // 預覽前 5 筆讓使用者確認
    targets.slice(0, 5).forEach((t, idx) => {
      Logger.log(`  [${idx+1}] id=${t.id} ${t.rec.branch}/${t.rec.position} ${t.rec.date} ${t.rec.originalName} → ${t.rec.coverName || '(無代班人)'}`);
    });
    if(targets.length > 5){
      Logger.log(`  ... 另外 ${targets.length - 5} 筆 (詳見正式搬移時的 log)`);
    }

    if(isDry){
      // 乾跑:只統計,不寫入也不刪除
      totalScanned += 0;
      return;
    }

    // ─── 正式搬移 ───
    // Step A: 複製到 _缺人紀錄 (跳過 id 已存在者)
    targets.forEach(t => {
      if(existingIds.has(t.id)){
        Logger.log(`  ⏭️  id=${t.id} 已存在於 _缺人紀錄,跳過複製`);
        totalSkipped++;
        return;
      }
      // 依 destHdr 順序組行
      const newRow = destHdr.map(col => {
        const v = t.rec[col];
        return (v === undefined || v === null) ? '' : v;
      });
      const writeRow = dest.getLastRow() + 1;
      dest.getRange(writeRow, 1, 1, destHdr.length).setValues([newRow]);
      // date 欄強制純文字格式
      const dateColIdx = destHdr.indexOf('date') + 1;
      if(dateColIdx > 0){
        dest.getRange(writeRow, dateColIdx).setNumberFormat('@');
      }
      existingIds.add(t.id);
      totalCopied++;
      Logger.log(`  ✓ 複製 id=${t.id}`);
    });

    // Step B: 從原 sheet 刪除 (從下往上,避免索引錯位)
    const rowsToDelete = targets.map(t => t.rowIdx).sort((a, b) => b - a);
    rowsToDelete.forEach(rowIdx => {
      sh.deleteRow(rowIdx);
      totalDeleted++;
    });
    Logger.log(`  已從 ${srcName} 刪除 ${rowsToDelete.length} 列`);
  });

  Logger.log('\n=== 結果 ===');
  Logger.log(`掃描到 reason=缺人 的紀錄總計:${totalScanned} 筆`);
  if(isDry){
    Logger.log('(乾跑模式 — 沒有實際寫入或刪除任何資料)');
    Logger.log('如果上面的清單看起來正確,請執行 migrateShortageRecords(false) 進行正式搬移');
  } else {
    Logger.log(`✓ 已複製到 _缺人紀錄:${totalCopied} 筆`);
    Logger.log(`⏭️  跳過 (id 已存在):${totalSkipped} 筆`);
    Logger.log(`🗑️  已從原 sheet 刪除:${totalDeleted} 筆`);
    Logger.log('完成! 之後新建立的「缺人」紀錄會自動進入 _缺人紀錄 sheet');
  }
}

/**
 * 一次性遷移工具:把舊的「私事支援」紀錄從 _換班紀錄 搬到 _請假紀錄
 *
 * 用法 (在 Apps Script 編輯器中):
 *   1. 先試跑:執行 _runDrySupportMigration()  (只列出會搬什麼,不修改任何資料)
 *   2. 確認無誤後:執行 _runRealSupportMigration()  (正式搬移)
 *
 * 識別條件:_換班紀錄 中 mode='support' 或 reason='私事支援' 的列
 * 搬移後:那些列會從 _換班紀錄 刪除,複製到 _請假紀錄 (id 重複者跳過複製只刪除)
 */
function migrateSupportRecords(dryRun){
  const isDry = (dryRun === true);
  Logger.log('=== migrateSupportRecords ' + (isDry ? '(DRY RUN — 乾跑模式,不會修改 Sheet)' : '(正式搬移,會修改 Sheet)') + ' ===');

  // 確保 _請假紀錄 已存在 (帶正確 schema)
  const dest = getOrCreate(SHEETS.LEAVES, HEADERS[SHEETS.LEAVES]);
  const destHdr = HEADERS[SHEETS.LEAVES];

  // 先建立目的地的 id 索引 (避免重複搬移)
  const existingIds = new Set();
  {
    const all = dest.getDataRange().getValues();
    for(let i=1; i<all.length; i++){
      const id = String(all[i][0] || '').trim();
      if(id) existingIds.add(id);
    }
  }
  Logger.log('_請假紀錄 目前已有 ' + existingIds.size + ' 筆');

  // 來源:只掃 _換班紀錄
  const srcName = SHEETS.SWAPS;
  Logger.log('\n--- 掃描 ' + srcName + ' ---');
  const sh = getOrCreate(srcName, HEADERS[srcName]);
  const all = sh.getDataRange().getValues();
  if(all.length < 2){
    Logger.log('  (空 sheet,無紀錄需搬移)');
    return;
  }
  const hdr = all[0].map(h => String(h || '').trim());
  const colIdx = {};
  ['id','reason','branch','position','date','originalName','mode','coverName'].forEach(name => {
    colIdx[name] = hdr.indexOf(name);
  });
  if(colIdx.reason < 0 && colIdx.mode < 0){
    Logger.log('  ⚠️  此 sheet 沒有 reason 也沒有 mode 欄位,無法判別,終止');
    return;
  }

  // 收集 mode='support' 或 reason='私事支援' 的列
  const targets = [];  // {rowIdx (1-based), record obj, id}
  for(let i=1; i<all.length; i++){
    const row = all[i];
    const mode = colIdx.mode >= 0 ? String(row[colIdx.mode] || '').trim() : '';
    const reason = colIdx.reason >= 0 ? String(row[colIdx.reason] || '').trim() : '';
    const isSupport = (mode === 'support') || (reason === '私事支援');
    if(!isSupport) continue;

    // 把整列轉成 record 物件 (依 hdr 對應)
    const rec = {};
    hdr.forEach((h, j) => {
      let v = row[j];
      // 日期型別轉字串
      if(v instanceof Date){
        if(h === 'date' || h === 'periodStart'){
          v = formatDate(v);
        } else if(h === 'createdAt'){
          v = v.toISOString();
        }
      }
      rec[h] = v;
    });
    const id = String(rec.id || '').trim();
    targets.push({rowIdx: i + 1, rec: rec, id: id});
  }
  Logger.log('  找到 ' + targets.length + ' 筆「私事支援」紀錄');

  // 預覽前 10 筆
  targets.slice(0, 10).forEach((t, idx) => {
    Logger.log(`  [${idx+1}] id=${t.id} ${t.rec.branch}/${t.rec.position} ${t.rec.date} ${t.rec.originalName} → ${t.rec.coverName || '(無代班人)'}`);
  });
  if(targets.length > 10){
    Logger.log(`  ... 另外 ${targets.length - 10} 筆 (詳見正式搬移時的 log)`);
  }

  if(isDry){
    Logger.log('\n=== (乾跑) ===');
    Logger.log(`掃描到「私事支援」紀錄總計:${targets.length} 筆`);
    Logger.log('(乾跑模式 — 沒有實際寫入或刪除任何資料)');
    Logger.log('如果上面的清單看起來正確,請執行 _runRealSupportMigration() 進行正式搬移');
    return;
  }

  // ─── 正式搬移 ───
  let totalCopied = 0;
  let totalSkipped = 0;
  let totalDeleted = 0;

  // Step A: 複製到 _請假紀錄 (跳過 id 已存在者)
  targets.forEach(t => {
    if(existingIds.has(t.id)){
      Logger.log(`  ⏭️  id=${t.id} 已存在於 _請假紀錄,跳過複製`);
      totalSkipped++;
      return;
    }
    // 依 destHdr 順序組行
    const newRow = destHdr.map(col => {
      const v = t.rec[col];
      return (v === undefined || v === null) ? '' : v;
    });
    const writeRow = dest.getLastRow() + 1;
    dest.getRange(writeRow, 1, 1, destHdr.length).setValues([newRow]);
    // date 欄強制純文字格式 (避免被 Sheet 自動轉成日期物件)
    const dateColIdx = destHdr.indexOf('date') + 1;
    if(dateColIdx > 0){
      dest.getRange(writeRow, dateColIdx).setNumberFormat('@');
    }
    existingIds.add(t.id);
    totalCopied++;
    Logger.log(`  ✓ 複製 id=${t.id}`);
  });

  // Step B: 從 _換班紀錄 刪除 (從下往上,避免索引錯位)
  const rowsToDelete = targets.map(t => t.rowIdx).sort((a, b) => b - a);
  rowsToDelete.forEach(rowIdx => {
    sh.deleteRow(rowIdx);
    totalDeleted++;
  });
  Logger.log(`  已從 ${srcName} 刪除 ${rowsToDelete.length} 列`);

  Logger.log('\n=== 結果 ===');
  Logger.log(`掃描到「私事支援」紀錄總計:${targets.length} 筆`);
  Logger.log(`✓ 已複製到 _請假紀錄:${totalCopied} 筆`);
  Logger.log(`⏭️  跳過 (id 已存在):${totalSkipped} 筆`);
  Logger.log(`🗑️  已從 _換班紀錄 刪除:${totalDeleted} 筆`);
  Logger.log('完成! 之後新建立的「私事支援」紀錄會自動進入 _請假紀錄 sheet');
}

// ─── 私事支援遷移的快捷執行函式 ────────────────────────────────────
// (在 Apps Script 編輯器頂部選單可直接點選執行)
function _runDrySupportMigration(){ migrateSupportRecords(true); }
function _runRealSupportMigration(){ migrateSupportRecords(false); }


/**
 * 診斷工具:列出所有「originalName 對不到 sheet 班表中真正員工」的 swap record
 *
 * 背景:過往版本快速換班有 bug,建立 record 時 originalName 用了「畫面顯示的人」
 *      而不是「sheet 中真正排班的人」。這類 record 永遠不會生效(swapMap 找不到),
 *      畫面看起來沒換班,但 sheet 中卻有 record,工時計算可能也跟著錯。
 *
 * 用法:在 Apps Script 編輯器執行 _runAuditBadSwaps()
 *      會 log 所有可疑的 row,你可以對照 sheet 手動刪除。
 *      若要自動刪除,執行 _runDeleteBadSwaps()
 */
function auditBadSwaps(deleteMode){
  const isDelete = (deleteMode === true);
  Logger.log('=== auditBadSwaps ' + (isDelete ? '(DELETE 模式 — 會刪除壞 record)' : '(READ-ONLY)') + ' ===');

  // 1. 讀所有 _班表 schedule 資料,組成 lookup
  // key = `${branch}__${position}__${periodStart}` → schedule.shifts
  const schedSh = SpreadsheetApp.getActive().getSheetByName(SHEETS.SCHEDULE);
  if(!schedSh){ Logger.log('找不到 _班表'); return; }
  const schedAll = schedSh.getDataRange().getValues();
  const schedHdr = schedAll[0].map(h => String(h||'').trim());
  const schedColIdx = {
    branch: schedHdr.indexOf('branch'),
    position: schedHdr.indexOf('position'),
    periodStart: schedHdr.indexOf('periodStart'),
    data: schedHdr.indexOf('data')
  };
  const schedLookup = {};   // key → shifts
  for(let i=1; i<schedAll.length; i++){
    const r = schedAll[i];
    const branch = String(r[schedColIdx.branch] || '').trim();
    const position = String(r[schedColIdx.position] || '').trim();
    let ps = r[schedColIdx.periodStart];
    if(ps instanceof Date) ps = formatDate(ps);
    else ps = String(ps || '').trim();
    const dataStr = r[schedColIdx.data];
    if(!branch || !position || !ps || !dataStr) continue;
    let data;
    try { data = (typeof dataStr === 'string') ? JSON.parse(dataStr) : dataStr; }
    catch(e){ continue; }
    const k = `${branch}__${position}__${ps}`;
    schedLookup[k] = (data && data.shifts) ? data.shifts : {};
  }
  Logger.log('已載入 ' + Object.keys(schedLookup).length + ' 筆班表');

  const SHIFT_KEY = {'早':'morning','午':'noon','晚':'evening','出勤':'attendance'};

  // 2. 對 _換班紀錄 中所有 mode=swap 的 row 做檢核
  const swapsSh = SpreadsheetApp.getActive().getSheetByName(SHEETS.SWAPS);
  const swAll = swapsSh.getDataRange().getValues();
  const swHdr = swAll[0].map(h => String(h||'').trim());
  const idx = {};
  ['id','branch','position','date','shift','originalName','mode','swapWith'].forEach(name => {
    idx[name] = swHdr.indexOf(name);
  });

  // 找每筆 row 對應的 8 週區間 (periodStart)
  // 從 _工時區間 sheet 拿 — 簡化處理:用該 row 的 date 找最接近的 periodStart
  const periodsSh = SpreadsheetApp.getActive().getSheetByName(SHEETS.PERIODS);
  const periodsAll = periodsSh ? periodsSh.getDataRange().getValues() : [];
  const periodStarts = [];
  for(let i=1; i<periodsAll.length; i++){
    let p = periodsAll[i][0];
    if(p instanceof Date) p = formatDate(p);
    else p = String(p || '').trim();
    if(p) periodStarts.push(p);
  }
  periodStarts.sort();

  const findPeriodStart = (dateStr) => {
    // 找最大的 periodStart 滿足 periodStart <= dateStr 且 dateStr 在 [periodStart, periodStart+55日]
    const d = new Date(dateStr);
    let match = null;
    periodStarts.forEach(ps => {
      const pd = new Date(ps);
      const end = new Date(pd);
      end.setDate(end.getDate() + 55);
      if(d >= pd && d <= end){
        if(!match || pd > new Date(match)) match = ps;
      }
    });
    return match;
  };

  const badRows = [];   // {rowIdx, id, branch, position, date, shift, originalName, sheetName}
  for(let i=1; i<swAll.length; i++){
    const row = swAll[i];
    const mode = String(row[idx.mode] || '').trim();
    if(mode !== 'swap') continue;
    const id = String(row[idx.id] || '').trim();
    const branch = String(row[idx.branch] || '').trim();
    const position = String(row[idx.position] || '').trim();
    let date = row[idx.date];
    if(date instanceof Date) date = formatDate(date);
    else date = String(date || '').trim();
    const shift = String(row[idx.shift] || '').trim();
    const originalName = String(row[idx.originalName] || '').trim();
    if(!branch || !position || !date || !shift || !originalName) continue;

    const ps = findPeriodStart(date);
    if(!ps){
      Logger.log(`  ⚠️  Row ${i+1} (id=${id}): 找不到對應 8 週區間 (date=${date})`);
      continue;
    }
    const k = `${branch}__${position}__${ps}`;
    const shifts = schedLookup[k];
    if(!shifts){
      Logger.log(`  ⚠️  Row ${i+1} (id=${id}): 找不到 schedule (${k})`);
      continue;
    }
    const cell = shifts[date] || {};
    const sk = SHIFT_KEY[shift];
    if(!sk) continue;
    const sheetNames = cell[sk] || [];

    // 檢核:originalName 是否在 sheet cell 中
    if(!sheetNames.includes(originalName)){
      const sheetNameStr = sheetNames.length ? sheetNames.join(',') : '(空)';
      badRows.push({
        rowIdx: i + 1,
        id, branch, position, date, shift, originalName,
        sheetName: sheetNameStr
      });
    }
  }

  Logger.log('\n=== 結果 ===');
  Logger.log(`掃描 ${swAll.length - 1} 筆 _換班紀錄 row,找到 ${badRows.length} 筆「壞」record`);
  Logger.log('「壞」= originalName 不在 sheet 班表的對應 cell 中,代表這筆 swap 永遠不會生效');
  if(badRows.length){
    Logger.log('\n清單:');
    Logger.log('Row\tID\t\t\t\tBranch\tPosition\tDate\t\tShift\toriginalName(record)\t→ sheet 中真正的人');
    badRows.forEach(b => {
      Logger.log(`${b.rowIdx}\t${b.id}\t${b.branch}\t${b.position}\t\t${b.date}\t${b.shift}\t${b.originalName}\t\t→ ${b.sheetName}`);
    });
  }

  if(!isDelete){
    Logger.log('\n(READ-ONLY 模式 — 沒有刪除任何 row)');
    Logger.log('如要刪除上面列出的所有壞 row,執行 _runDeleteBadSwaps()');
    return;
  }

  // ─── DELETE 模式:從下往上刪 (避免索引錯位) ───
  const rowsToDelete = badRows.map(b => b.rowIdx).sort((a,b) => b - a);
  rowsToDelete.forEach(r => swapsSh.deleteRow(r));
  Logger.log(`\n✓ 已刪除 ${rowsToDelete.length} 筆壞 row`);
  Logger.log('完成! 重整前台應該會看到正確的排班');
}

// 快捷函式
function _runAuditBadSwaps(){ auditBadSwaps(false); }
function _runDeleteBadSwaps(){ auditBadSwaps(true); }


/**
 * 診斷工具:列出所有「班表 cell 中存著不在當前員工名單的姓名」
 *
 * 背景:歷史上某個員工被設定過(例「陳」),自動排班把他塞進 cell。
 *      後來 employees 名單改了(例移除「陳」改成「致寬」),但 sheet 中的
 *      schedule cell 仍存著「陳」。前台渲染時,fallback 找不到對應組別,
 *      就直接把「陳」顯示出來,但實際上該員工已不在名單中。
 *
 * 用法:在 Apps Script 編輯器執行 _runAuditOrphanCells()
 *      會 log 所有疑似的 cell (branch/position/date/shift/有問題的姓名)
 *      你可以對照前台確認是否真的是歷史殘留 → 手動修正,或執行 _runFixOrphanCells()
 *      自動把它們從 cell 中移除 (但不會重生,空格需手動處理或重跑自動排班)
 */
function auditOrphanCells(deleteMode){
  const isDelete = (deleteMode === true);
  Logger.log('=== auditOrphanCells ' + (isDelete ? '(DELETE 模式 — 會把孤兒姓名從 cell 移除)' : '(READ-ONLY)') + ' ===');

  // 1. 讀所有 _設定 取 employees 名單
  // key = `${branch}__${position}` → Set<name>
  const setSh = SpreadsheetApp.getActive().getSheetByName(SHEETS.SETTINGS);
  const setAll = setSh.getDataRange().getValues();
  const setHdr = setAll[0].map(h => String(h||'').trim());
  const setIdx = {
    branch: setHdr.indexOf('branch'),
    position: setHdr.indexOf('position'),
    data: setHdr.indexOf('data')
  };
  const employeesByBP = {};   // key → Set<name>
  for(let i=1; i<setAll.length; i++){
    const r = setAll[i];
    const branch = String(r[setIdx.branch] || '').trim();
    const position = String(r[setIdx.position] || '').trim();
    const dataStr = r[setIdx.data];
    if(!branch || !position || !dataStr) continue;
    let data;
    try { data = (typeof dataStr === 'string') ? JSON.parse(dataStr) : dataStr; }
    catch(e){ continue; }
    const names = new Set();
    if(data && Array.isArray(data.employees)){
      data.employees.forEach(e => {
        if(e && e.name) names.add(String(e.name).trim());
      });
    }
    employeesByBP[`${branch}__${position}`] = names;
  }

  // 2. 對 _班表 中的所有 row 掃 cell
  const schedSh = SpreadsheetApp.getActive().getSheetByName(SHEETS.SCHEDULE);
  const schedAll = schedSh.getDataRange().getValues();
  const schedHdr = schedAll[0].map(h => String(h||'').trim());
  const schedIdx = {
    branch: schedHdr.indexOf('branch'),
    position: schedHdr.indexOf('position'),
    periodStart: schedHdr.indexOf('periodStart'),
    data: schedHdr.indexOf('data')
  };

  const orphans = [];     // {rowIdx, branch, position, periodStart, date, shiftKey, orphanName}
  const dirtyRows = {};   // rowIdx → updated data string (only DELETE mode)

  for(let i=1; i<schedAll.length; i++){
    const r = schedAll[i];
    const branch = String(r[schedIdx.branch] || '').trim();
    const position = String(r[schedIdx.position] || '').trim();
    let ps = r[schedIdx.periodStart];
    if(ps instanceof Date) ps = formatDate(ps);
    else ps = String(ps || '').trim();
    const dataStr = r[schedIdx.data];
    if(!branch || !position || !ps || !dataStr) continue;
    if(position === '工讀') continue;   // 工讀不適用此檢查

    const validNames = employeesByBP[`${branch}__${position}`];
    if(!validNames){
      Logger.log(`  ⚠️  Row ${i+1}: 找不到 ${branch} ${position} 的員工名單 (可能未設定)`);
      continue;
    }

    let data;
    try { data = (typeof dataStr === 'string') ? JSON.parse(dataStr) : dataStr; }
    catch(e){ continue; }
    if(!data || !data.shifts) continue;

    let modified = false;
    Object.keys(data.shifts).forEach(date => {
      const cell = data.shifts[date];
      ['morning','noon','evening','attendance','off'].forEach(sk => {
        if(!Array.isArray(cell[sk])) return;
        const cleaned = [];
        cell[sk].forEach(n => {
          if(!n){ cleaned.push(n); return; }
          if(validNames.has(n)){
            cleaned.push(n);
          } else {
            orphans.push({
              rowIdx: i+1,
              branch, position, periodStart: ps, date,
              shiftKey: sk, orphanName: n
            });
            // 是否要在 cell 中移除?
            if(isDelete){
              modified = true;
              // skip — 不加進 cleaned
            } else {
              cleaned.push(n);   // READ-ONLY 模式,保留
            }
          }
        });
        if(isDelete) cell[sk] = cleaned;
      });
    });

    if(isDelete && modified){
      dirtyRows[i+1] = JSON.stringify(data);
    }
  }

  Logger.log('\n=== 結果 ===');
  Logger.log(`掃描 ${schedAll.length - 1} 筆 _班表 row,找到 ${orphans.length} 個孤兒姓名 (在 cell 中但不在員工名單)`);
  if(orphans.length){
    Logger.log('\n清單 (前 30 筆):');
    Logger.log('Row\tBranch\tPosition\tPeriodStart\tDate\t\tShift\t\tOrphan Name');
    orphans.slice(0, 30).forEach(o => {
      Logger.log(`${o.rowIdx}\t${o.branch}\t${o.position}\t\t${o.periodStart}\t${o.date}\t${o.shiftKey}\t\t${o.orphanName}`);
    });
    if(orphans.length > 30){
      Logger.log(`...(共 ${orphans.length} 筆)`);
    }
  }

  if(!isDelete){
    Logger.log('\n(READ-ONLY 模式 — 沒有修改任何資料)');
    Logger.log('如要把上面列出的孤兒姓名「從 cell 中移除」,執行 _runFixOrphanCells()');
    Logger.log('注意:移除後,該 cell 會變空(沒人) → 你可以重跑「自動排班」(會跳過已有異動紀錄的天)讓系統重生,或手動填補');
    return;
  }

  // ─── DELETE 模式:把 dirtyRows 寫回 sheet ───
  Object.keys(dirtyRows).forEach(rowIdx => {
    const row = +rowIdx;
    schedSh.getRange(row, schedIdx.data + 1).setValue(dirtyRows[rowIdx]);
  });
  Logger.log(`\n✓ 已修改 ${Object.keys(dirtyRows).length} 筆 _班表 row,移除其中的孤兒姓名`);
  Logger.log('完成! 建議:');
  Logger.log('  1. 重整前台確認那些 cell 是否變空');
  Logger.log('  2. 執行「自動排班」讓系統重生空 cell (會跳過異動紀錄日)');
}

function _runAuditOrphanCells(){ auditOrphanCells(false); }
function _runFixOrphanCells(){ auditOrphanCells(true); }


/**
 * ============================================================
 * 員工改名 / 舊名合併工具 — 把某院區職位資料裡的「舊名」全部改成「新名」
 * ============================================================
 * 用途:歷史殘留的舊姓名 (例:平鎮藥師「程」其實就是現在的「秋蓉」),
 *      一次把 _班表 的格子 + _換班/_請假/_缺人紀錄 裡的舊名全部置換成新名。
 *
 * 用法 (在 Apps Script 編輯器):
 *   1) 先乾跑看會改幾處:  _dryFixPingzhenCheng()
 *   2) 確認無誤後正式執行:  _fixPingzhenCheng()
 *   ( 其他院區/職位也可自行呼叫 renameEmployeeInData('院區','職位','舊名','新名', false) )
 */
function renameEmployeeInData(branch, position, oldName, newName, dryRun){
  const isDry = (dryRun === true);
  Logger.log('=== renameEmployeeInData ' + (isDry ? '(乾跑,不修改)' : '(正式置換)') + ' ===');
  Logger.log(branch + ' ' + position + ':「' + oldName + '」→「' + newName + '」');
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let cellCount = 0, recCount = 0;

  // 1) _班表 cells
  const schedSh = ss.getSheetByName(SHEETS.SCHEDULE);
  if(schedSh){
    const all = schedSh.getDataRange().getValues();
    const hdr = all[0].map(h => String(h || '').trim());
    const bi = hdr.indexOf('branch'), pi = hdr.indexOf('position'), di = hdr.indexOf('data');
    for(let i = 1; i < all.length; i++){
      if(String(all[i][bi]).trim() !== branch || String(all[i][pi]).trim() !== position) continue;
      let data;
      try { data = JSON.parse(all[i][di]); } catch(e){ continue; }
      if(!data || !data.shifts) continue;
      let changed = false;
      Object.keys(data.shifts).forEach(date => {
        const cell = data.shifts[date];
        ['morning','noon','evening','attendance','off'].forEach(sk => {
          if(!Array.isArray(cell[sk])) return;
          cell[sk] = cell[sk].map(n => {
            if(n === oldName){ changed = true; cellCount++; return newName; }
            return n;
          });
        });
      });
      if(changed && !isDry){
        schedSh.getRange(i + 1, di + 1).setValue(JSON.stringify(data));
      }
    }
  }

  // 2) _換班/_請假/_缺人紀錄
  [SHEETS.SWAPS, SHEETS.LEAVES, SHEETS.SHORTAGES].forEach(name => {
    const sh = ss.getSheetByName(name);
    if(!sh) return;
    const all = sh.getDataRange().getValues();
    if(all.length < 2) return;
    const hdr = all[0].map(h => String(h || '').trim());
    const bi = hdr.indexOf('branch'), pi = hdr.indexOf('position');
    const oi = hdr.indexOf('originalName'), si = hdr.indexOf('swapWith'), ci = hdr.indexOf('coverName');
    for(let i = 1; i < all.length; i++){
      if(String(all[i][bi]).trim() !== branch || String(all[i][pi]).trim() !== position) continue;
      let rowChanged = false;
      if(oi >= 0 && String(all[i][oi]).trim() === oldName){
        if(!isDry) sh.getRange(i + 1, oi + 1).setValue(newName);
        rowChanged = true;
      }
      if(si >= 0){
        let sw = all[i][si];
        try { sw = (typeof sw === 'string' && sw) ? JSON.parse(sw) : (Array.isArray(sw) ? sw : []); }
        catch(e){ sw = []; }
        if(Array.isArray(sw) && sw.length){
          const nw = sw.map(x => {
            if(x === oldName) return newName;
            if(x && typeof x === 'object' && x.name === oldName){ const o = {}; for(const k in x) o[k] = x[k]; o.name = newName; return o; }
            return x;
          });
          if(JSON.stringify(nw) !== JSON.stringify(sw)){
            if(!isDry) sh.getRange(i + 1, si + 1).setValue(JSON.stringify(nw));
            rowChanged = true;
          }
        }
      }
      if(ci >= 0 && String(all[i][ci]).trim() === oldName){
        if(!isDry) sh.getRange(i + 1, ci + 1).setValue(newName);
        rowChanged = true;
      }
      if(rowChanged) recCount++;
    }
  });

  Logger.log('_班表 cell 置換:' + cellCount + ' 處');
  Logger.log('紀錄置換:' + recCount + ' 筆');
  if(isDry){
    Logger.log('(乾跑模式 — 沒有實際修改任何資料)');
    Logger.log('如果數字看起來正確,執行 _fixPingzhenCheng() 進行正式置換');
  } else {
    Logger.log('✓ 完成! 請回前台重新整理 (Ctrl+Shift+R)');
  }
}

// 快捷:平鎮藥師「程」→「秋蓉」
function _dryFixPingzhenCheng(){ renameEmployeeInData('平鎮', '藥師', '程', '秋蓉', true); }
function _fixPingzhenCheng(){ renameEmployeeInData('平鎮', '藥師', '程', '秋蓉', false); }
