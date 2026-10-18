/* ============================================================
   家長值班 LINE 機器人（Google Apps Script）
   - 群組裡打關鍵字就回覆班表：今天／明天／本週／下週／班表／說明
   - 每週五晚上自動把下週一到五的班表推播到綁定的群組
   - 資料直接讀網頁用的 Firebase（board/meta、board/snacks、shifts）

   需要的「指令碼屬性」（專案設定 → 指令碼屬性）：
     LINE_TOKEN           LINE 官方帳號的 Channel access token
     FIREBASE_PROJECT_ID  Firebase 專案 ID
     FIREBASE_API_KEY     Firebase 網頁 API 金鑰
     WEB_URL              （選填）班表網址，打「班表」時回傳
   GROUP_ID 會在機器人被加入群組時自動記下，不用手動填。
   ============================================================ */

const TZ = 'Asia/Taipei';
const DOWN = ['日', '一', '二', '三', '四', '五', '六'];
const PERIODS = { p9: '第九節', night: '晚自習' };
const PKEYS = ['p9', 'night'];
const DEFAULT_WEB_URL = 'https://wsweetwsweet.github.io/parent-duty-roster/';

const props = () => PropertiesService.getScriptProperties();
// 去掉不小心一起貼上的空白和引號
const prop = k => (props().getProperty(k) || '').trim().replace(/^["']|["'],?$/g, '');
function need(k) {
  const v = prop(k);
  if (!v) throw new Error(`指令碼屬性「${k}」沒有設定，請到「專案設定 → 指令碼屬性」檢查名稱有沒有打錯`);
  return v;
}

/* ---------- LINE webhook ---------- */
function doPost(e) {
  const body = JSON.parse(e.postData.contents || '{}');
  (body.events || []).forEach(ev => {
    try { handleEvent(ev); } catch (err) { console.error(err); }
  });
  return ContentService.createTextOutput('OK');
}

function handleEvent(ev) {
  const src = ev.source || {};
  if (ev.type === 'join' && src.groupId) {
    props().setProperty('GROUP_ID', src.groupId);
    reply(ev.replyToken, '大家好！我是值班小幫手 🙋\n每週五晚上會發下週的班表。\n' + helpText());
    return;
  }
  if (ev.type !== 'message' || ev.message.type !== 'text') return;

  const text = ev.message.text.trim();
  if (text === '綁定群組' && src.groupId) {
    props().setProperty('GROUP_ID', src.groupId);
    reply(ev.replyToken, '✅ 之後每週的班表提醒會發到這個群組');
    return;
  }
  const answer = answerFor(text);
  if (answer) reply(ev.replyToken, answer);   // 其他聊天內容一律不回，避免打擾
}

function answerFor(text) {
  const today = todayISO();
  switch (text) {
    case '今天': return dayReport([today], '今天');
    case '明天': return dayReport([addDays(today, 1)], '明天');
    case '本週': case '這週': return dayReport(weekDays(mondayOf(today)), '本週');
    case '下週': return dayReport(weekDays(addDays(mondayOf(today), 7)), '下週');
    case '班表': return '📋 完整班表：\n' + (prop('WEB_URL') || DEFAULT_WEB_URL);
    case '說明': case '指令': return helpText();
  }
  return '';
}

function helpText() {
  return '在群組輸入以下文字就會回覆：\n' +
    '・今天／明天：當天值班家長與點心\n' +
    '・本週／下週：週一到週五的班表\n' +
    '・班表：完整班表網址';
}

/* ---------- 每週推播 ---------- */
// 由時間觸發器在週五晚上執行，發下週一到五的班表
function weeklyPush() {
  const groupId = prop('GROUP_ID');
  if (!groupId) { console.warn('還沒有綁定群組'); return; }
  const days = weekDays(nextMonday(todayISO()));
  const data = loadData(days[0], days[4]);
  if (!days.some(d => hasAnything(data, d))) return;   // 整週放假就不發，省額度
  push(groupId, '📢 下週值班提醒\n\n' + formatDays(data, days) + '\n\n完整班表：' + (prop('WEB_URL') || DEFAULT_WEB_URL));
}

// 執行一次即可：建立「每週五晚上 8 點」的觸發器（會先刪掉舊的，不會重複）
function 建立每週提醒() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'weeklyPush')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('weeklyPush').timeBased()
    .onWeekDay(ScriptApp.WeekDay.FRIDAY).atHour(20).inTimezone(TZ).create();
  console.log('已建立：每週五 20:00 左右推播下週班表');
}

// 測試用：只在執行記錄裡顯示下週提醒內容，不會發到群組
function 預覽下週提醒() {
  const days = weekDays(nextMonday(todayISO()));
  console.log(formatDays(loadData(days[0], days[4]), days));
}

/* ---------- 組回覆文字 ---------- */
function dayReport(days, title) {
  const data = loadData(days[0], days[days.length - 1]);
  const body = formatDays(data, days);
  return body ? `📅 ${title}班表\n\n${body}` : `${title}沒有值班 🎉`;
}

function formatDays(data, days) {
  return days.filter(d => isWeekday(d) && hasAnything(data, d))
    .map(d => formatDay(data, d)).join('\n\n');
}

function formatDay(data, d) {
  const head = `${d.slice(5).replace('-', '/')}（${DOWN[dowOf(d)]}）`;
  const holAll = data.holidays.find(h => h.d === d && h.scope === 'all');
  if (holAll) return `${head} ${holAll.note || '放假'}`;

  const lines = [head];
  PKEYS.forEach(p => {
    if (!inRange(data, p, d)) return;
    const hol = data.holidays.find(h => h.d === d && h.scope === p);
    if (hol) { lines.push(`・${PERIODS[p]}：${hol.note || '放假'}`); return; }
    // 跟網頁一樣：那天沒有任何家長的小孩到課，就不算值班時段
    if (!Object.values(data.byId[p]).some(st => (st.days || []).map(Number).includes(dowOf(d)))) return;
    const names = [];
    for (let i = 0; i < data.perSlot[p]; i++) {
      const st = data.byId[p][data.shifts[`${d}|${p}|${i}`]];
      if (st) names.push(labelOf(st));
    }
    lines.push(`・${PERIODS[p]}：${names.join('、') || '（未排）'}`);
  });
  const sn = data.snacks[d];
  if (sn && (sn.who || sn.item)) lines.push(`・點心：${[sn.who, sn.item].filter(Boolean).join('／')}`);
  return lines.join('\n');
}

function hasAnything(data, d) {
  return isWeekday(d) && PKEYS.some(p => inRange(data, p, d));
}
function inRange(data, p, d) {
  const [a, b] = data.range[p];
  return data.perSlot[p] > 0 && a && b && d >= a && d <= b;
}
function labelOf(s) {
  return s.parent || s.name;
}

/* ---------- 讀 Firebase ---------- */
function loadData(from, to) {
  const meta = fsGet('board/meta') || {};
  const snacksRaw = fsGet('board/snacks') || {};
  const s = meta.settings || {};
  const legacy = [s.startDate || '', s.endDate || ''];
  const data = { range: {}, perSlot: {}, byId: {}, shifts: {}, snacks: {}, holidays: meta.holidays || [] };
  PKEYS.forEach(p => {
    const r = (s.range || {})[p];
    data.range[p] = (Array.isArray(r) && (r[0] || r[1])) ? r : legacy;
    data.perSlot[p] = Number((s.perSlot || {})[p] ?? 1);
    data.byId[p] = {};
    ((meta.rosters || {})[p] || []).forEach(st => { data.byId[p][st.id] = st; });
  });
  data.holidays = data.holidays.map(h => ({ d: h.d, note: h.note || '', scope: h.scope || 'all' }));
  Object.keys(snacksRaw).forEach(d => {
    const v = snacksRaw[d];
    data.snacks[d] = typeof v === 'string' ? { who: v, item: '' } : { who: v.who || '', item: v.item || '' };
  });
  fsQueryShifts(from, to).forEach(r => { data.shifts[`${r.d}|${r.period}|${r.idx}`] = r.studentId || ''; });
  return data;
}

function fsBase() {
  return `https://firestore.googleapis.com/v1/projects/${need('FIREBASE_PROJECT_ID')}/databases/(default)/documents`;
}

function fsGet(path) {
  const res = UrlFetchApp.fetch(`${fsBase()}/${path}?key=${need('FIREBASE_API_KEY')}`, { muteHttpExceptions: true });
  if (res.getResponseCode() === 404) return null;
  if (res.getResponseCode() !== 200) throw new Error('讀取 Firebase 失敗：' + res.getContentText());
  return fsFields(JSON.parse(res.getContentText()).fields || {});
}

function fsQueryShifts(from, to) {
  const query = {
    structuredQuery: {
      from: [{ collectionId: 'shifts' }],
      where: { compositeFilter: { op: 'AND', filters: [
        { fieldFilter: { field: { fieldPath: 'd' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: from } } },
        { fieldFilter: { field: { fieldPath: 'd' }, op: 'LESS_THAN_OR_EQUAL', value: { stringValue: to } } },
      ] } },
    },
  };
  const res = UrlFetchApp.fetch(`${fsBase()}:runQuery?key=${need('FIREBASE_API_KEY')}`, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(query), muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('讀取班表失敗：' + res.getContentText());
  return JSON.parse(res.getContentText()).filter(r => r.document).map(r => fsFields(r.document.fields || {}));
}

// Firestore REST 回傳的是帶型別的 JSON，轉回一般物件
function fsFields(fields) {
  const out = {};
  Object.keys(fields).forEach(k => { out[k] = fsValue(fields[k]); });
  return out;
}
function fsValue(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) return fsFields(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fsValue);
  return null;
}

/* ---------- LINE API ---------- */
function reply(token, text) {
  lineApi('reply', { replyToken: token, messages: [{ type: 'text', text }] });
}
function push(to, text) {
  lineApi('push', { to, messages: [{ type: 'text', text }] });
}
function lineApi(kind, payload) {
  const res = UrlFetchApp.fetch(`https://api.line.me/v2/bot/message/${kind}`, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + need('LINE_TOKEN') },
    payload: JSON.stringify(payload),
  });
  if (res.getResponseCode() !== 200) console.error(`LINE ${kind} 失敗：` + res.getContentText());
}

/* ---------- 日期小工具（一律用台灣時間） ---------- */
function todayISO() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function parseISO(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function toISO(dt) { return Utilities.formatDate(dt, 'UTC', 'yyyy-MM-dd'); }
function addDays(s, n) { const dt = parseISO(s); dt.setUTCDate(dt.getUTCDate() + n); return toISO(dt); }
function dowOf(s) { return parseISO(s).getUTCDay(); }
function isWeekday(s) { const w = dowOf(s); return w >= 1 && w <= 5; }
// 週六、週日的「本週」指的是剛過完的這週
function mondayOf(s) { const w = dowOf(s); return addDays(s, w === 0 ? -6 : 1 - w); }
function nextMonday(s) { return addDays(mondayOf(s), 7); }
function weekDays(mon) { return [0, 1, 2, 3, 4].map(i => addDays(mon, i)); }
