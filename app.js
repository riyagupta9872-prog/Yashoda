// ═══════════════════════════════════════════════════════════
// 1. FIREBASE SETUP
// ═══════════════════════════════════════════════════════════
const firebaseConfig = {
    apiKey: "AIzaSyDtLp6VU9KnfYt1Agv8L5gL68ZxRzfxodg",
    authDomain: "yashoda-sadhana-tracker.firebaseapp.com",
    projectId: "yashoda-sadhana-tracker",
    storageBucket: "yashoda-sadhana-tracker.firebasestorage.app",
    messagingSenderId: "919046799313",
    appId: "1:919046799313:web:8d68c028ff21a4dfbe6af0"
};
if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db   = firebase.firestore();
db.settings({ experimentalAutoDetectLongPolling: true, merge: true });

let currentUser    = null;
let userProfile    = null;
let activeListener = null;

// ═══════════════════════════════════════════════════════════
// TIME PICKER HELPERS — AM/PM custom dropdowns
// ═══════════════════════════════════════════════════════════

// Build AM/PM time picker into a container div
// hiddenId = id of hidden input that stores HH:MM (24hr) value
// onChange  = optional callback after value changes
function buildTimePicker(containerId, hiddenId, onChange) {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Hour select (1–12)
    const hourSel = document.createElement('select');
    hourSel.className = 'tp-hour';
    const hBlank = document.createElement('option');
    hBlank.value = ''; hBlank.textContent = 'HH'; hBlank.disabled = true; hBlank.selected = true;
    hourSel.appendChild(hBlank);
    for (let h = 1; h <= 12; h++) {
        const o = document.createElement('option');
        o.value = String(h); o.textContent = String(h).padStart(2,'0');
        hourSel.appendChild(o);
    }

    // Minute select (00, 05, 10 ... 55)
    const minSel = document.createElement('select');
    minSel.className = 'tp-min';
    const mBlank = document.createElement('option');
    mBlank.value = ''; mBlank.textContent = 'MM'; mBlank.disabled = true; mBlank.selected = true;
    minSel.appendChild(mBlank);
    for (let m = 0; m < 60; m += 5) {
        const o = document.createElement('option');
        o.value = String(m); o.textContent = String(m).padStart(2,'0');
        minSel.appendChild(o);
    }

    // AM/PM select
    const ampmSel = document.createElement('select');
    ampmSel.className = 'tp-ampm';
    ['AM','PM'].forEach(v => {
        const o = document.createElement('option');
        o.value = v; o.textContent = v;
        ampmSel.appendChild(o);
    });

    // Update hidden input on any change
    function syncHidden() {
        const h = hourSel.value;
        const m = minSel.value;
        const ap = ampmSel.value;
        if (!h || m === '') { document.getElementById(hiddenId).value = ''; if (onChange) onChange(''); return; }
        let hr24 = parseInt(h);
        if (ap === 'AM' && hr24 === 12) hr24 = 0;
        if (ap === 'PM' && hr24 !== 12) hr24 += 12;
        const val = String(hr24).padStart(2,'0') + ':' + String(m).padStart(2,'0');
        document.getElementById(hiddenId).value = val;
        if (onChange) onChange(val);
    }

    hourSel.addEventListener('change', syncHidden);
    minSel.addEventListener('change', syncHidden);
    ampmSel.addEventListener('change', syncHidden);

    container.innerHTML = '';
    container.appendChild(hourSel);
    container.appendChild(minSel);
    container.appendChild(ampmSel);
}

// Set time picker value from HH:MM 24hr string
function setTimePicker(containerId, hiddenId, val24) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const hourSel = container.querySelector('.tp-hour');
    const minSel  = container.querySelector('.tp-min');
    const ampmSel = container.querySelector('.tp-ampm');
    if (!hourSel || !minSel || !ampmSel) return;

    if (!val24 || val24 === 'NR' || !val24.includes(':')) {
        hourSel.value = ''; minSel.value = ''; ampmSel.value = 'AM';
        document.getElementById(hiddenId).value = '';
        return;
    }
    const [h24str, mStr] = val24.split(':');
    let h24 = parseInt(h24str);
    const m  = parseInt(mStr);
    const ap = h24 < 12 ? 'AM' : 'PM';
    let h12 = h24 % 12; if (h12 === 0) h12 = 12;

    // Find closest minute option (round to nearest 5)
    const mRounded = Math.round(m / 5) * 5 % 60;

    hourSel.value  = String(h12);
    minSel.value   = String(mRounded);
    ampmSel.value  = ap;
    document.getElementById(hiddenId).value = val24;
}

// Convert HH:MM (24hr) → "H:MM AM/PM" display string
function fmt12(t) {
    if (!t || t === 'NR') return t || 'NR';
    const [h24str, mStr] = t.split(':');
    let h24 = parseInt(h24str);
    const m  = mStr || '00';
    const ap = h24 < 12 ? 'AM' : 'PM';
    let h12 = h24 % 12; if (h12 === 0) h12 = 12;
    return `${h12}:${m} ${ap}`;
}


// ═══════════════════════════════════════════════════════════
const isSuperAdmin         = () => userProfile?.role === 'superAdmin';
const isDeptAdmin          = () => userProfile?.role === 'deptAdmin';
const isOverallTeamLeader  = () => userProfile?.role === 'overallTeamLeader';
const isTeamLeader         = () => userProfile?.role === 'teamLeader';
const isAnyAdmin           = () => isSuperAdmin() || isDeptAdmin() || isOverallTeamLeader() || isTeamLeader();

// Teams per department
const DEPT_TEAMS = {
    'IGF':      ['Yashoda','Devaki','Balarama','Other'],
    'IYF':      ['Yashoda','Devaki','Balarama','Other'],
    'ICF_MTG':  ['Yashoda','Devaki','Balarama','Other'],
    'ICF_PRJI': ['Yashoda','Devaki','Balarama','Other']
};

// Populate team dropdown based on dept
window.populateDeptTeams = (selectId, dept, selected = '') => {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    sel.innerHTML = '<option value="" disabled selected>Select team</option>';
    if (dept && DEPT_TEAMS[dept]) {
        DEPT_TEAMS[dept].forEach(t => {
            const o = document.createElement('option');
            o.value = t; o.textContent = t;
            if (t === selected) o.selected = true;
            sel.appendChild(o);
        });
    }
};

// What users this admin can see
function getAdminScope() {
    if (isSuperAdmin())        return { type: 'all' };
    if (isDeptAdmin())         return { type: 'dept', dept: userProfile.department };
    if (isOverallTeamLeader()) return { type: 'overall-team', team: userProfile.team };
    if (isTeamLeader())        return { type: 'team', dept: userProfile.department, team: userProfile.team };
    return { type: 'self' };
}

// Filter users by scope (admin operations)
function matchesScope(uData) {
    const scope = getAdminScope();
    if (scope.type === 'all')          return true;
    if (scope.type === 'dept')         return uData.department === scope.dept;
    if (scope.type === 'overall-team') return uData.team === scope.team;
    if (scope.type === 'team')         return uData.team === scope.team && uData.department === scope.dept;
    return false;
}

// Filter users for WCR/Leaderboard visibility
function matchesViewScope(uData) {
    if (isSuperAdmin())        return true;
    if (isDeptAdmin())         return uData.department === userProfile.department;
    if (isOverallTeamLeader()) return uData.team === userProfile.team;
    if (isTeamLeader())        return uData.department === userProfile.department && uData.team === userProfile.team;
    return uData.department === userProfile.department && uData.team === userProfile.team;
}

// For backward compatibility — level categories visible
// ═══════════════════════════════════════════════════════════
// 3. HELPERS
// ═══════════════════════════════════════════════════════════
const t2m = (t, isSleep = false) => {
    if (!t || t === 'NR') return 9999;
    let [h, m] = t.split(':').map(Number);
    if (isSleep && h >= 0 && h <= 3) h += 24;
    return h * 60 + m;
};

function getWeekInfo(dateStr) {
    const [y,m,dd] = dateStr.split('-').map(Number);
    const d   = new Date(y, m-1, dd);
    const sun = new Date(d); sun.setDate(d.getDate() - d.getDay());
    const sat = new Date(sun); sat.setDate(sun.getDate() + 6);
    const fmt = dt => `${String(dt.getDate()).padStart(2,'0')} ${dt.toLocaleString('en-GB',{month:'short'})}`;
    const sunStr = `${sun.getFullYear()}-${String(sun.getMonth()+1).padStart(2,'0')}-${String(sun.getDate()).padStart(2,'0')}`;
    return { sunStr, label: `${fmt(sun)} to ${fmt(sat)}_${sun.getFullYear()}` };
}

function localDateStr(offsetDays = 0) {
    const d = new Date(); d.setDate(d.getDate() - offsetDays);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function getNRData(date) {
    return {
        id: date, totalScore: -30, dayPercent: -19,
        sleepTime:'NR', wakeupTime:'NR', chantingTime:'NR',
        readingMinutes:0, hearingMinutes:0, serviceMinutes:0, notesMinutes:0, daySleepMinutes:0,
        scores:{ sleep:-5, wakeup:-5, chanting:-5, reading:-5, hearing:-5, service:-5, notes:-5, daySleep:0 }
    };
}

function isPastDate(dateStr) {
    return dateStr < localDateStr(0);
}

// Convert a Date object to YYYY-MM-DD using local timezone (NOT UTC)
function toLocalDS(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function getWeekDates(weekOffset) {
    const today = new Date();
    const dayOfWeek = today.getDay();
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - dayOfWeek - (weekOffset * 7));
    weekStart.setHours(0,0,0,0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    if (weekOffset === 0) {
        if (weekEnd > today) weekEnd.setTime(today.getTime());
    }
    const toStr = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const dates = [];
    const cur = new Date(weekStart);
    while (cur <= weekEnd) { dates.push(toStr(cur)); cur.setDate(cur.getDate() + 1); }
    return { dates, weekStart, weekEnd };
}

// ─── INSTRUMENT OPTIONS per level ────────────────────────
const INSTRUMENTS_L12 = ['Whomper','Kartal','Drum','Mridanga','Harmonium'];
const INSTRUMENTS_L34 = ['Whomper','Kartal','Drum','Mridanga','Harmonium',
                         'Instrument Learning','Data Management','Management','AI','Kirtan'];

function getInstrumentOptions(level) {
    return (level === 'Level-3' || level === 'Level-4') ? INSTRUMENTS_L34 : INSTRUMENTS_L12;
}

// Populate instrument dropdown in profile based on level
window.populateInstrumentOptions = (level) => {
    const sel = document.getElementById('profile-instrument');
    if (!sel) return;
    const opts = getInstrumentOptions(level);
    sel.innerHTML = '<option value="" disabled selected>Select your instrument / activity</option>';
    opts.forEach(o => {
        const el = document.createElement('option');
        el.value = o; el.textContent = o;
        sel.appendChild(el);
    });
};

// ─── SCORING ENGINE — LEVEL-1 (independent) ──────────────
// Daily max: 105 | Weekly: 735 + 25 service = 760
function calcScoreL1(slp, wak, chn, pat, hear, ds, inst) {
    const slpM = t2m(slp, true);
    const sleep   = slpM<=1380?25:slpM<=1385?20:slpM<=1390?15:slpM<=1395?10:slpM<=1400?5:slpM<=1405?0:-5;
    const wakM = t2m(wak);
    const wakeup  = wakM<=360?25:wakM<=365?20:wakM<=370?15:wakM<=375?10:wakM<=380?5:wakM<=385?0:-5;
    const chnM = t2m(chn);
    const chanting= chnM<=540?25:chnM<=570?20:chnM<=660?15:chnM<=870?10:chnM<=1020?5:chnM<=1140?0:-5;
    const daySleep= ds<=90?10:-5;
    const actS = (m) => m>=20?20:m>=15?15:m>=10?10:m>=5?5:m>=1?-5:-5;
    const patS  = Math.max(0, actS(pat));
    const hearS = Math.max(0, actS(hear));
    const reading = patS; const hearing = hearS;
    const bestOf  = Math.max(patS, hearS);
    // Instrument bonus: 20+=5, 15-19=3, 10-14=1, else 0
    const instrumentBonus = inst>=20?5:inst>=15?3:inst>=10?1:0;
    const total = sleep + wakeup + chanting + daySleep + bestOf;
    return { sc:{ sleep, wakeup, chanting, daySleep, reading, hearing, service:0, notes:0, instrument:0 },
             total, instrumentBonus, bestIs: patS>=hearS?'pathan':'hearing',
             dayPercent: Math.round((total/105)*100) };
}

// ─── SCORING ENGINE — LEVEL-2 (independent) ──────────────
// Daily max: 110 | Weekly: 770 + 25 service = 795
function calcScoreL2(slp, wak, chn, pat, hear, ds, inst) {
    const slpM = t2m(slp, true);
    const sleep   = slpM<=1380?25:slpM<=1385?20:slpM<=1390?15:slpM<=1395?10:slpM<=1400?5:slpM<=1405?0:-5;
    const wakM = t2m(wak);
    const wakeup  = wakM<=360?25:wakM<=365?20:wakM<=370?15:wakM<=375?10:wakM<=380?5:wakM<=385?0:-5;
    const chnM = t2m(chn);
    const chanting= chnM<=540?25:chnM<=570?20:chnM<=660?15:chnM<=870?10:chnM<=1020?5:chnM<=1140?0:-5;
    const daySleep= ds<=90?10:-5;
    const actS = (m) => m>=25?25:m>=20?20:m>=15?15:m>=10?10:m>=5?5:m>=1?-5:-5;
    const patS  = Math.max(0, actS(pat));
    const hearS = Math.max(0, actS(hear));
    const reading = patS; const hearing = hearS;
    const bestOf  = Math.max(patS, hearS);
    // Instrument bonus: 20+=5, 15-19=3, 10-14=1, else 0
    const instrumentBonus = inst>=20?5:inst>=15?3:inst>=10?1:0;
    const total = sleep + wakeup + chanting + daySleep + bestOf;
    return { sc:{ sleep, wakeup, chanting, daySleep, reading, hearing, service:0, notes:0, instrument:0 },
             total, instrumentBonus, bestIs: patS>=hearS?'pathan':'hearing',
             dayPercent: Math.round((total/110)*100) };
}

// ─── SCORING ENGINE — LEVEL-3 (independent) ──────────────
// Daily max: 115 | Weekly: 805 + 25 service = 830
function calcScoreL3(slp, wak, chn, pat, hear, ds, inst) {
    const slpM = t2m(slp, true);
    const sleep   = slpM<=1350?25:slpM<=1355?20:slpM<=1360?15:slpM<=1365?10:slpM<=1370?5:slpM<=1375?0:-5;
    const wakM = t2m(wak);
    const wakeup  = wakM<=330?25:wakM<=335?20:wakM<=340?15:wakM<=345?10:wakM<=350?5:wakM<=355?0:-5;
    const chnM = t2m(chn);
    const chanting= chnM<=540?25:chnM<=570?20:chnM<=660?15:chnM<=870?10:chnM<=1020?5:chnM<=1140?0:-5;
    const daySleep= ds<=60?10:-5;
    const actS = (m) => m>=30?25:m>=25?20:m>=20?15:m>=15?10:m>=10?5:m>=5?0:-5;
    const patS  = Math.max(0, actS(pat));
    const hearS = Math.max(0, actS(hear));
    const reading = patS; const hearing = hearS;
    const bestOf  = Math.max(patS, hearS);
    // Instrument compulsory: 20+=5, 15-19=3, 10-14=3, else 0
    const instrument = inst>=20?5:inst>=15?3:inst>=10?3:0;
    const total = sleep + wakeup + chanting + daySleep + bestOf + instrument;
    return { sc:{ sleep, wakeup, chanting, daySleep, reading, hearing, service:0, notes:0, instrument },
             total, instrumentBonus: 0, bestIs: patS>=hearS?'pathan':'hearing',
             dayPercent: Math.round((total/115)*100) };
}

// ─── SCORING ENGINE — LEVEL-4 (independent) ──────────────
// Daily max: 140 | Weekly: 980 + 25 service = 1005
function calcScoreL4(slp, wak, chn, pat, hear, ds, inst, notes) {
    const slpM = t2m(slp, true);
    const sleep   = slpM<=1350?25:slpM<=1355?20:slpM<=1360?15:slpM<=1365?10:slpM<=1370?5:slpM<=1375?0:-5;
    const wakM = t2m(wak);
    const wakeup  = wakM<=305?25:wakM<=310?20:wakM<=315?15:wakM<=320?10:wakM<=325?5:wakM<=330?0:-5;
    const chnM = t2m(chn);
    const chanting= chnM<=540?25:chnM<=570?20:chnM<=660?15:chnM<=870?10:chnM<=1020?5:chnM<=1140?0:-5;
    const daySleep= ds<=60?10:-5;
    const actS = (m) => m>=30?25:m>=25?20:m>=20?15:m>=15?10:m>=10?5:m>=5?0:-5;
    const reading = actS(pat);
    const hearing = actS(hear);
    // Instrument compulsory: 20+=5, 15-19=3, 10-14=3, else 0
    const instrument = inst>=20?5:inst>=15?3:inst>=10?3:0;
    // Notes revision bonus: 20+=20, 15-19=15, 10-14=10, 5-9=5, else 0
    const notesBonus = notes>=20?20:notes>=15?15:notes>=10?10:notes>=5?5:0;
    const total = sleep + wakeup + chanting + daySleep + reading + hearing + instrument;
    return { sc:{ sleep, wakeup, chanting, daySleep, reading, hearing, service:0, notes:0, instrument },
             total, instrumentBonus: 0, notesBonus, bestIs: null,
             dayPercent: Math.round((total/140)*100) };
}

// ─── SERVICE WEEKLY SCORE CALCULATOR ─────────────────────
function calcServiceWeekly(totalMins, level) {
    // L1: 60+=25, 50+=20, 40+=15, 30+=10, 20+=5, 10+=0, <10=-5
    if (level === 'Level-1') {
        return totalMins>=60?25:totalMins>=50?20:totalMins>=40?15:totalMins>=30?10:totalMins>=20?5:totalMins>=10?0:-5;
    }
    // L2/L3/L4: 90+=25, 80+=20, 70+=15, 60+=10, 50+=5, 40+=0, <40=-5
    return totalMins>=90?25:totalMins>=80?20:totalMins>=70?15:totalMins>=60?10:totalMins>=50?5:totalMins>=40?0:-5;
}

// ─── SUNDAY BONUS CALCULATOR ─────────────────────────────
function calcSundayBonus(dress1, dress2, tilak, mala, level) {
    // L1/L2: No=0, Yes=+5
    // L3/L4: No=-5, Yes=+5
    const noVal = (level==='Level-3'||level==='Level-4') ? -5 : 0;
    const v = (val) => val==='yes' ? 5 : noVal;
    return { dress1: v(dress1), dress2: v(dress2), tilak: v(tilak), mala: v(mala) };
}

// ─── MASTER calculateScores (for backward compat with edit modal) ──
function calculateScores(slp, wak, chn, rMin, hMin, sMin, nMin, dsMin, level) {
    let result;
    if      (level==='Level-1') result = calcScoreL1(slp,wak,chn,rMin,hMin,dsMin,0);
    else if (level==='Level-2') result = calcScoreL2(slp,wak,chn,rMin,hMin,dsMin,0);
    else if (level==='Level-3') result = calcScoreL3(slp,wak,chn,rMin,hMin,dsMin,0);
    else                        result = calcScoreL4(slp,wak,chn,rMin,hMin,dsMin,0,nMin);
    return { sc: result.sc, total: result.total, dayPercent: result.dayPercent };
}

// ─── DAILY MAX per level ──────────────────────────────────
function getDailyMax(level) {
    if (level==='Level-1') return 105;
    if (level==='Level-2') return 110;
    if (level==='Level-3') return 115;
    return 140;
}

// ═══════════════════════════════════════════════════════════
// 4. EXCEL DOWNLOAD  (with profile header + formatting)
// ═══════════════════════════════════════════════════════════
function xlsxSave(wb, filename) {
    try {
        const arr  = XLSX.write(wb, { bookType:'xlsx', type:'array' });
        const blob = new Blob([arr], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url; a.download = filename; a.style.display = 'none';
        document.body.appendChild(a); a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 2500);
    } catch (e) {
        console.error('Excel save error:', e);
        alert('Download failed: ' + e.message);
    }
}

// Helper: set cell style using xlsx-js-style (same API as xlsx@0.18 + style support)
function styleCell(ws, cellRef, opts = {}) {
    if (!ws[cellRef]) ws[cellRef] = { v:'', t:'s' };
    const border = {
        top:    { style:'thin', color:{rgb:'BFBFBF'} },
        bottom: { style:'thin', color:{rgb:'BFBFBF'} },
        left:   { style:'thin', color:{rgb:'BFBFBF'} },
        right:  { style:'thin', color:{rgb:'BFBFBF'} }
    };
    ws[cellRef].s = {
        font:      { bold: opts.bold||false, color:{rgb: opts.fontColor||'1A252F'}, sz: opts.sz||11, name:'Calibri' },
        fill:      { patternType:'solid', fgColor: {rgb: opts.fill||'FFFFFF'} },
        alignment: { horizontal: opts.align||'center', vertical:'center', wrapText: false },
        border
    };
}

// XLSX column index → letter(s) (0=A, 25=Z, 26=AA, 27=AB …)
function colLetter(n) {
    let s = '';
    n++;
    while (n > 0) {
        const r = (n - 1) % 26;
        s = String.fromCharCode(65 + r) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

window.downloadUserExcel = async (userId, userName) => {
    if (typeof XLSX === 'undefined') { alert('Excel library not loaded. Please refresh.'); return; }
    try {
        // Fetch user profile
        const uDoc = await db.collection('users').doc(userId).get();
        const uData = uDoc.exists ? uDoc.data() : {};

        const snap = await db.collection('users').doc(userId).collection('sadhana').get();
        if (snap.empty) { alert('No sadhana data found for this user.'); return; }

        const level      = uData.level || 'Level-1';
        const instrument = uData.instrument || 'Instrument';
        const dept       = uData.department || '';
        const dress1Label= (dept==='IGF'||dept==='ICF_MTG') ? 'Gopi Dress' : 'Dhoti';
        const dress2Label= (dept==='IGF'||dept==='ICF_MTG') ? 'Blouse'     : 'Kurta';
        const isL34      = level==='Level-3'||level==='Level-4';
        const isL4       = level==='Level-4';

        const weeksData = {};
        snap.forEach(doc => {
            const wi = getWeekInfo(doc.id);
            if (!weeksData[wi.sunStr]) weeksData[wi.sunStr] = { label:wi.label, sunStr:wi.sunStr, days:{} };
            weeksData[wi.sunStr].days[doc.id] = doc.data();
        });

        const sortedWeeks = Object.keys(weeksData).sort((a,b) => b.localeCompare(a));
        const DAY = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        // Columns (0-indexed): 0=Date,1=Bed,2=M,3=Wake,4=M,5=Chant,6=M,
        //   7=Read(m),8=M,9=Hear(m),10=M,11=Inst(m),12=M,
        //   13=Seva(m),14=SevaText,15=DaySleep(m),16=M,17=Bonus,18=Total,19=%
        // L4 inserts Notes(m) at index 17, shifting Bonus→18, Total→19, %→20
        const COLS = isL4 ? 21 : 20;

        // ── PROFILE HEADER ────────────────────────────────
        const today = new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
        const profileRows = [
            ['SADHANA TRACKER — INDIVIDUAL REPORT', ...Array(COLS-1).fill('')],
            ['', ...Array(COLS-1).fill('')],
            ['Name',           uData.name            || userName, ...Array(COLS-2).fill('')],
            ['Level',          level,                             ...Array(COLS-2).fill('')],
            ['Instrument',     instrument,                        ...Array(COLS-2).fill('')],
            ['Department',     dept,                              ...Array(COLS-2).fill('')],
            ['Team',           uData.team            || 'N/A',   ...Array(COLS-2).fill('')],
            ['Chanting Level', uData.chantingCategory|| 'N/A',   ...Array(COLS-2).fill('')],
            ['Exact Rounds',   uData.exactRounds     || 'N/A',   ...Array(COLS-2).fill('')],
            ['Downloaded On',  today,                             ...Array(COLS-2).fill('')],
            ['', ...Array(COLS-1).fill('')],
        ];

        const dataArray = [...profileRows];
        const PROFILE_ROWS = profileRows.length;
        const styleMap = {};

        sortedWeeks.forEach((sunStr, wi) => {
            const week  = weeksData[sunStr];
            const wRow  = dataArray.length;

            dataArray.push([`WEEK: ${week.label}`,...Array(COLS-1).fill('')]);
            styleMap[wRow] = 'weekHeader';

            const chRow = dataArray.length;
            // Headers
            const hdr = ['Date','Bed','M','Wake','M','Chant','M',
                         'Pathan(m)','M','Hearing(m)','M',
                         `${instrument}(m)`,'M',
                         'Seva(m)','Seva Notes','DaySleep(m)','M',
                         'Bonus','Total','%'];
            if (isL4) hdr.splice(17,0,'Notes(m)');
            dataArray.push(hdr);
            styleMap[chRow] = 'colHeader';

            let T = { sl:0,wu:0,ch:0,rd:0,hr:0,inst:0,ds:0, rdm:0,hrm:0,instm:0,svm:0,dsm:0,bonus:0,tot:0,ntm:0 };
            const [_sy,_sm,_sd] = week.sunStr.split('-').map(Number);
            const weekEntries = [];

            for (let i = 0; i < 7; i++) {
                const cd  = new Date(_sy, _sm-1, _sd+i);
                const ds  = `${cd.getFullYear()}-${String(cd.getMonth()+1).padStart(2,'0')}-${String(cd.getDate()).padStart(2,'0')}`;
                const lbl = `${DAY[cd.getDay()]} ${String(cd.getDate()).padStart(2,'0')}`;
                const e   = week.days[ds] || getNRData(ds);
                const dRow = dataArray.length;
                const bonus= e.bonusTotal||0;
                const svcS = e.scores?.instrument??0;

                T.sl  += e.scores?.sleep??0;   T.wu += e.scores?.wakeup??0;
                T.ch  += e.scores?.chanting??0; T.rd += e.scores?.reading??0;
                T.hr  += e.scores?.hearing??0;  T.inst+= e.scores?.instrument??0;
                T.ds  += e.scores?.daySleep??0;
                T.rdm += e.readingMinutes||0;   T.hrm += e.hearingMinutes||0;
                T.instm+= e.instrumentMinutes||0; T.svm += e.serviceMinutes||0;
                T.dsm += e.daySleepMinutes||0;  T.bonus+= bonus;
                T.tot += (e.totalScore??0)+bonus;
                T.ntm += e.notesMinutes||0;
                if (e.sleepTime && e.sleepTime!=='NR') weekEntries.push({id:ds,sleepTime:e.sleepTime});

                const row = [
                    lbl,
                    fmt12(e.sleepTime||'NR'),    e.scores?.sleep??0,
                    fmt12(e.wakeupTime||'NR'),   e.scores?.wakeup??0,
                    fmt12(e.chantingTime||'NR'), e.scores?.chanting??0,
                    e.readingMinutes||0,  e.scores?.reading??0,
                    e.hearingMinutes||0,  e.scores?.hearing??0,
                    e.instrumentMinutes||0, e.scores?.instrument??0,
                    e.serviceMinutes||0,  e.serviceText||'',
                    e.daySleepMinutes||0, e.scores?.daySleep??0,
                    bonus,
                    (e.totalScore??0)+bonus, (e.dayPercent??0)+'%'
                ];
                if (isL4) row.splice(17,0,e.notesMinutes||0);
                dataArray.push(row);
                styleMap[dRow] = (e.sleepTime === 'NR') ? 'nr' : 'data';
            }

            // Weekly service pool row
            const svcScore = calcServiceWeekly(T.svm, level);
            const svcRow   = dataArray.length;
            dataArray.push([`Service Pool: ${T.svm} min → Score: ${svcScore>=0?'+':''}${svcScore}`,...Array(COLS-1).fill('')]);
            styleMap[svcRow] = 'summary';

            const fd  = fairDenominator(week.sunStr, weekEntries, level);
            const pct = Math.round(((T.tot+svcScore)/fd)*100);
            const totRow = dataArray.length;
            const totLine = ['WEEKLY TOTAL','',T.sl,'',T.wu,'',T.ch,T.rdm,T.rd,T.hrm,T.hr,T.instm,T.inst,T.svm,'',T.dsm,T.ds,T.bonus,T.tot+svcScore,pct+'%'];
            if (isL4) totLine.splice(17,0,T.ntm);
            dataArray.push(totLine);
            styleMap[totRow] = 'total';

            const sumRow = dataArray.length;
            dataArray.push([`WEEKLY %: ${T.tot+svcScore} / ${fd} = ${pct}%`,...Array(COLS-1).fill('')]);
            styleMap[sumRow] = 'summary';

            if (wi < sortedWeeks.length-1) {
                dataArray.push(Array(COLS).fill(''));
                dataArray.push(Array(COLS).fill(''));
            }
        });

        // ── BUILD WORKSHEET ───────────────────────────────
        const ws = XLSX.utils.aoa_to_sheet(dataArray);
        ws['!cols'] = [10,8,4,8,4,8,4,9,4,9,4,9,4,8,14,10,4,7,8,6].map(w=>({wch:w}));
        if (isL4) ws['!cols'].splice(17,0,{wch:8});

        // ── MERGES ────────────────────────────────────────
        const merges = [];
        // Profile title spans all columns
        merges.push({s:{r:0,c:0}, e:{r:0,c:COLS-1}});
        // Profile rows: label in col 0, value merged cols 1 onward (rows 2-9)
        for (let r=2;r<=9;r++) merges.push({s:{r,c:1}, e:{r,c:COLS-1}});

        // Week & summary row merges
        Object.entries(styleMap).forEach(([rStr, type]) => {
            const r = parseInt(rStr);
            if (type==='weekHeader' || type==='summary') {
                merges.push({s:{r,c:0}, e:{r,c:COLS-1}});
            }
        });
        ws['!merges'] = merges;

        // ── CELL STYLES ───────────────────────────────────
        // Profile title
        styleCell(ws, 'A1', { bold:true, fill:'1A3C5E', fontColor:'FFFFFF', sz:13, align:'center' });

        // Profile label cells (col A, rows 3-10) + value cells
        for (let r=2;r<=9;r++) {
            styleCell(ws, `A${r+1}`, { bold:true, fill:'1A3C5E', fontColor:'FFFFFF', align:'left' });
            for (let c=1;c<COLS;c++) styleCell(ws, `${colLetter(c)}${r+1}`, { fill:'EBF3FB', align:'left' });
        }
        // Blank rows (row 2 and row 11) — light fill with border
        for (let c=0;c<COLS;c++) {
            styleCell(ws, `${colLetter(c)}2`, { fill:'1A3C5E' });
            styleCell(ws, `${colLetter(c)}11`, { fill:'F0F4F8' });
        }

        // Data rows styling
        Object.entries(styleMap).forEach(([rStr, type]) => {
            const r    = parseInt(rStr);
            const rNum = r + 1; // 1-indexed for cell refs

            if (type === 'weekHeader') {
                for (let c=0;c<COLS;c++) {
                    const ref = `${colLetter(c)}${rNum}`;
                    styleCell(ws, ref, { bold:true, fill:'1A3C5E', fontColor:'FFFFFF', sz:12, align:'center' });
                }
            } else if (type === 'colHeader') {
                for (let c=0;c<COLS;c++) {
                    const ref = `${colLetter(c)}${rNum}`;
                    styleCell(ws, ref, { bold:true, fill:'2E86C1', fontColor:'FFFFFF', sz:10, align:'center' });
                }
            } else if (type === 'total') {
                for (let c=0;c<COLS;c++) {
                    const ref = `${colLetter(c)}${rNum}`;
                    styleCell(ws, ref, { bold:true, fill:'D5E8F7', sz:11, align:'center' });
                }
                // Date column
                styleCell(ws, `A${rNum}`, { bold:true, fill:'D5E8F7', align:'left', sz:12 });
                // % column conditional
                const totPctRef = `${colLetter(COLS-1)}${rNum}`;
                if (ws[totPctRef]) {
                    const pv = parseInt(String(ws[totPctRef].v))||0;
                    const tf = pv >= 70 ? 'C6EFCE' : pv >= 50 ? 'FFEB9C' : 'FFC7CE';
                    const tc = pv >= 70 ? '006100' : pv >= 50 ? '9C5700' : 'C0392B';
                    styleCell(ws, totPctRef, { bold:true, fill:tf, fontColor:tc, sz:13, align:'center' });
                }
            } else if (type === 'summary') {
                for (let c=0;c<COLS;c++) {
                    const ref = `${colLetter(c)}${rNum}`;
                    styleCell(ws, ref, { bold:true, fill:'EBF3FB', fontColor:'1A3C5E', align:'center' });
                }
            } else if (type === 'nr') {
                // NR row — light red background
                for (let c=0;c<COLS;c++) {
                    const ref = `${colLetter(c)}${rNum}`;
                    styleCell(ws, ref, { fill:'FFC7CE', fontColor:'C0392B', align:'center' });
                }
                // Date col left aligned + bold
                styleCell(ws, `A${rNum}`, { bold:true, fill:'FFC7CE', fontColor:'C0392B', align:'left' });
            } else if (type === 'data') {
                // Date col — bold, left aligned
                styleCell(ws, `A${rNum}`, { bold:true, align:'left' });
                // Score columns (M cols): C,E,G,I,K,M,Q = col indices 2,4,6,8,10,12,16
                // Also index 14 if L4 (notes marks)
                const scoreCols = [2,4,6,8,10,12,16];
                if (isL4) scoreCols.push(17);
                for (let c=1;c<COLS;c++) {
                    const ref  = `${colLetter(c)}${rNum}`;
                    const cell = ws[ref];
                    if (!cell) { styleCell(ws, ref, { align:'center' }); continue; }
                    if (scoreCols.includes(c)) {
                        // Score cell — conditional color like the app
                        const val = typeof cell.v === 'number' ? cell.v : parseFloat(cell.v)||0;
                        const fill  = val >= 20 ? 'C6EFCE'   // green (like app high-score)
                                    : val >= 10 ? 'FFEB9C'   // yellow
                                    : val >=  0 ? 'FAD7A0'   // orange
                                    :             'FFC7CE';   // red (like app low-score)
                        const fColor = val < 0 ? 'C0392B' : val >= 20 ? '006100' : val >= 10 ? '9C5700' : '1A252F';
                        styleCell(ws, ref, { fill, fontColor:fColor, bold: val >= 20 || val < 0, align:'center' });
                    } else {
                        styleCell(ws, ref, { align:'center' });
                    }
                }
                // Total col (COLS-2) — re-apply with bold + larger font
                styleCell(ws, `${colLetter(COLS-2)}${rNum}`, { bold:true, sz:12, align:'center' });
                // % col — bold with conditional color
                const pctRef = `${colLetter(COLS-1)}${rNum}`;
                if (ws[pctRef]) {
                    const pctVal = parseInt(String(ws[pctRef].v))||0;
                    const pctFill = pctVal >= 70 ? 'C6EFCE' : pctVal >= 50 ? 'FFEB9C' : 'FFC7CE';
                    const pctFC = pctVal >= 70 ? '006100' : pctVal >= 50 ? '9C5700' : 'C0392B';
                    styleCell(ws, pctRef, { bold:true, fill:pctFill, fontColor:pctFC, align:'center' });
                }
            }
        });

        // Freeze profile block + column A
        ws['!freeze'] = { xSplit:1, ySplit:PROFILE_ROWS, topLeftCell:`B${PROFILE_ROWS+1}` };

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Sadhana_Weekly');
        xlsxSave(wb, `${userName.replace(/\s+/g,'_')}_Sadhana_Weekly.xlsx`);

    } catch (err) { console.error(err); alert('Download Failed: ' + err.message); }
};

window.downloadMasterReport = async () => {
    if (typeof XLSX === 'undefined') { alert('Excel library not loaded. Please refresh.'); return; }
    try {
        const usersSnap = await db.collection('users').get();
        const userData = [];
        const weekMap = new Map();

        const filteredDocs = usersSnap.docs.filter(uDoc => {
            const u = uDoc.data();
            if (u.role === 'superAdmin' || u.role === 'deptAdmin' || u.role === 'overallTeamLeader' || u.role === 'teamLeader' || u.role === 'admin') return false;
            return matchesScope(u);
        });
        const allSnaps = await Promise.all(filteredDocs.map(uDoc => uDoc.ref.collection('sadhana').get()));
        filteredDocs.forEach((uDoc, i) => {
            const u = uDoc.data();
            const entries = allSnaps[i].docs.map(d=>({date:d.id, score:d.data().totalScore||0, bonus:d.data().bonusTotal||0, svcMins:d.data().serviceMinutes||0, sleepTime:d.data().sleepTime||''}));
            entries.forEach(en => {
                const wi = getWeekInfo(en.date);
                weekMap.set(wi.sunStr, wi.label);
            });
            userData.push({ user:u, entries });
        });
        userData.sort((a,b)=>(a.user.name||'').localeCompare(b.user.name||''));

        // Sort weeks by sunStr descending (newest first) — YYYY-MM-DD sorts perfectly
        const allWeeks = Array.from(weekMap.entries())
            .sort((a,b) => b[0].localeCompare(a[0]))
            .map(([sunStr, label]) => ({ sunStr, label }));

        const rows = [['User Name','Level','Department','Team','Chanting Category',...allWeeks.map(w=>w.label.replace('_',' '))]];

        userData.forEach(({user,entries}) => {
            const row = [user.name, user.level||'Level-1', user.department||'-', user.team||'-', user.chantingCategory||'N/A'];
            allWeeks.forEach(({ sunStr }) => {
                let tot = 0, svcMinsWeek = 0; const masterWeekEnts = [];
                const wSun = new Date(sunStr);
                for (let i=0;i<7;i++) {
                    const c  = new Date(wSun); c.setDate(c.getDate()+i);
                    const ds = toLocalDS(c);
                    const en = entries.find(e=>e.date===ds);
                    if (en) { tot += en.score + (en.bonus||0); svcMinsWeek += en.svcMins||0; masterWeekEnts.push({id:ds,sleepTime:en.sleepTime||''}); }
                    else { tot += -30; }
                }
                tot += calcServiceWeekly(svcMinsWeek, user.level||'Level-1');
                const mfd = fairDenominator(wSun, masterWeekEnts);
                const pct = Math.round((tot/mfd)*100);
                row.push(pct < 0 ? `(${Math.abs(pct)}%)` : `${pct}%`);
            });
            rows.push(row);
        });

        const ws = XLSX.utils.aoa_to_sheet(rows);

        // Style header row
        const hCols = rows[0].length;
        for (let c = 0; c < hCols; c++) {
            const ref = `${colLetter(c)}1`;
            styleCell(ws, ref, { bold:true, fill:'1A3C5E', fontColor:'FFFFFF', sz:11, align: c < 5 ? 'left' : 'center' });
        }

        // TEXT_COLS: Name(0), Level(1), Department(2), Team(3), Chanting(4) — 5 info cols before week data
        const TEXT_COLS = 5;
        // Style data rows
        for (let r = 1; r < rows.length; r++) {
            const stripeBg = r % 2 === 0 ? 'F8FAFC' : 'FFFFFF';
            // Info columns (text)
            for (let c = 0; c < TEXT_COLS; c++) {
                const ref = `${colLetter(c)}${r+1}`;
                styleCell(ws, ref, { fill: stripeBg, align:'left', bold: c===0 });
            }
            // Week % columns
            for (let c = TEXT_COLS; c < rows[r].length; c++) {
                const ref  = `${colLetter(c)}${r+1}`;
                const cell = ws[ref];
                if (!cell) { styleCell(ws, ref, { fill: stripeBg, align:'center' }); continue; }
                const raw   = parseInt(String(cell.v).replace('%','').replace('(','').replace(')','')) || 0;
                const isNeg = String(cell.v).includes('(');
                const pct   = isNeg ? -Math.abs(raw) : raw;
                let fill = stripeBg, fontColor = '1A252F', bold = false;
                if (pct < 0)        { fill = 'FFC7CE'; fontColor = 'C0392B'; bold = true; }
                else if (pct < 20)  { fill = 'FFC7CE'; fontColor = 'C0392B'; bold = true; }
                else if (pct < 50)  { fill = 'FFEB9C'; fontColor = '9C5700'; bold = false; }
                else if (pct < 70)  { fill = 'FFEB9C'; fontColor = '9C5700'; bold = true; }
                else                { fill = 'C6EFCE'; fontColor = '006100'; bold = true; }
                styleCell(ws, ref, { fill, fontColor, bold, align:'center' });
            }
        }

        ws['!cols'] = [{ wch:24 }, { wch:12 }, { wch:14 }, { wch:14 }, { wch:16 }, ...Array(allWeeks.length).fill({ wch:16 })];
        ws['!freeze'] = { xSplit: TEXT_COLS, ySplit: 1, topLeftCell: `${colLetter(TEXT_COLS)}2` };

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Master_Report');
        xlsxSave(wb, 'Master_Sadhana_Report.xlsx');

    } catch (err) { console.error(err); alert('Download Failed: ' + err.message); }
};

// ═══════════════════════════════════════════════════════════
// 5. AUTH
// ═══════════════════════════════════════════════════════════
function resetAppState() {
    try {
        _userWCRLoaded = false;
        adminPanelLoaded = false;
        window._wcrUserList = [];
        window._adminCmpUserList = [];
        window._profilePicDataUrl = null;
        if (typeof myChartInstance !== 'undefined' && myChartInstance) { try { myChartInstance.destroy(); } catch(e){} myChartInstance = null; }
        if (typeof modalChartInstance !== 'undefined' && modalChartInstance) { try { modalChartInstance.destroy(); } catch(e){} modalChartInstance = null; }
        if (typeof _aaChartDonut !== 'undefined' && _aaChartDonut) { try { _aaChartDonut.destroy(); } catch(e){} _aaChartDonut = null; }
        if (typeof _aaChartBar !== 'undefined' && _aaChartBar) { try { _aaChartBar.destroy(); } catch(e){} _aaChartBar = null; }
        const ubn = document.getElementById('user-bottom-nav');
        const abn = document.getElementById('admin-bottom-nav');
        if (ubn) ubn.classList.remove('visible');
        if (abn) abn.classList.remove('visible');
        document.body.classList.remove('has-bottom-nav');
        if (activeListener) { activeListener(); activeListener = null; }
        if (typeof editModalUserId !== 'undefined') { editModalUserId = null; editModalDate = null; editModalOriginal = null; }
        if (typeof _uacUID !== 'undefined') { _uacUID = null; _uacName = null; }
        if (typeof _homeWeekOffset !== 'undefined') _homeWeekOffset = 0;
        if (typeof _lbMode !== 'undefined') { _lbMode = 'weekly'; _lbLoading = false; }
        if (typeof _perfAllData !== 'undefined') { _perfAllData = []; _perfTab = 'weekly'; }
        if (typeof _saHomeLoaded !== 'undefined') _saHomeLoaded = false;
    } catch(e) { console.warn('resetAppState:', e); }
}

let _profileUnsub = null;
auth.onAuthStateChanged((user) => {
    // Unsubscribe previous profile listener
    if (_profileUnsub) { _profileUnsub(); _profileUnsub = null; }

    resetAppState();
    if (user) {
        currentUser = user;
        let _dashboardInited = false;

        // Real-time profile listener — updates instantly when admin changes role
        _profileUnsub = db.collection('users').doc(user.uid).onSnapshot(docSnap => {
            if (!docSnap.exists) { showSection('profile'); return; }

            const prevLevel = userProfile ? userProfile.level : null;
            userProfile = docSnap.data();

            // Sirf name, department, team zaroori hain — level default Level-1 hoga
            if (!userProfile.name || !userProfile.department || !userProfile.team) {
                document.getElementById('profile-title').textContent    = 'Complete Your Profile';
                document.getElementById('profile-subtitle').textContent = 'Please fill in your details to continue';
                document.getElementById('profile-name').value           = userProfile.name || '';
                populateInstrumentOptions(userProfile.level || 'Level-1');
                showSection('profile');
                return;
            }

            if (!_dashboardInited) {
                _dashboardInited = true;
                initDashboard();
            } else {
                // Profile updated in background — refresh fields instantly
                refreshFormFields();
            }
        });
    } else {
        currentUser = null;
        userProfile = null;
        showSection('auth');
    }
});

function initDashboard() {
    const roleLabel = isSuperAdmin()        ? '👑 Super Admin'
                    : isDeptAdmin()         ? `🛡️ Dept Admin — ${userProfile.department||''}`
                    : isOverallTeamLeader() ? `🌐 Overall TL — ${userProfile.team||''}`
                    : isTeamLeader()        ? `👥 Team Leader — ${userProfile.team||''} (${userProfile.department||''})`
                    : `${userProfile.level||'Level-1'} | ${userProfile.department||''} | ${userProfile.team||''}`;
    document.getElementById('user-display-name').textContent = userProfile.name;
    document.getElementById('user-role-display').textContent = roleLabel;
    updateAvatarDisplay(userProfile.photoURL || null, userProfile.name || '');

    // Role-based tab visibility
    const userTabs  = document.querySelectorAll('.user-tab');
    const adminTabs = document.querySelectorAll('.admin-tab');
    if (isAnyAdmin()) {
        // Admins: show admin tabs only, hide user tabs
        userTabs.forEach(b => b.classList.add('hidden'));
        adminTabs.forEach(b => b.classList.remove('hidden'));
    } else {
        // Users: show user tabs only, hide admin tabs
        userTabs.forEach(b => b.classList.remove('hidden'));
        adminTabs.forEach(b => b.classList.add('hidden'));
    }

    showSection('dashboard');
    // Init bottom nav FIRST so it's visible before any tab switch
    initBottomNav();

    // Default tab based on role
    if (isAnyAdmin()) {
        // All admins start at Home — scope handles what they see
        switchTab('admin-home');
        // Hide notification bell for admins
        const nb = document.getElementById('sidebar-notif-btn');
        if (nb) nb.style.display = 'none';
        const sd = nb && nb.previousElementSibling;
        if (sd && sd.classList.contains('sidebar-divider')) sd.style.display = 'none';
        // Hide Admin Mgmt button for non-SA (only SA can manage roles)
        if (!isSuperAdmin()) {
            const adminMgmtEl = document.getElementById('admin-sub-adminmgmt');
            if (adminMgmtEl) adminMgmtEl.style.display = 'none';
        }
    } else {
        // Setup form for users
        setupDateSelect();
        buildTimePicker('sleep-time-picker',    'sleep-time',    null);
        buildTimePicker('wakeup-time-picker',   'wakeup-time',   null);
        buildTimePicker('chanting-time-picker', 'chanting-time', null);
        refreshFormFields();
        // Show Manage bnav for deptAdmin/teamLeader
        const bnavManage = document.getElementById('bnav-manage');
        if (bnavManage) bnavManage.classList.toggle('hidden', !isAnyAdmin());
        switchTab('home');
    }
    if (window._initNotifications && !isAnyAdmin()) window._initNotifications();
}

// ═══════════════════════════════════════════════════════════
// 6. NAVIGATION
// ═══════════════════════════════════════════════════════════
window.switchTab = (t) => {
    // Map manage to admin for non-SA admins
    if (t === 'manage') t = 'admin-reports';

    // Hide ALL panels
    ['home-panel','mysadhana-panel','team-panel','admin-panel'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('active');
    });
    // Reset mysadhana sub-tabs so progress chart doesn't leak when returning
    document.querySelectorAll('#mysadhana-panel .subtab-panel').forEach(p => p.classList.remove('active'));
    const defaultSadhanaTab = document.getElementById('sadhana-entry-sub');
    if (defaultSadhanaTab) defaultSadhanaTab.classList.add('active');
    document.querySelectorAll('#mysadhana-panel .subtab-btn').forEach((b,i) => b.classList.toggle('active', i===0));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));

    // admin tabs all use admin-panel with sub-sections
    if (t === 'admin-home' || t === 'admin-reports' || t === 'admin' || t === 'inactive' || t === 'adminmgmt' || t === 'admin-tasks' || t === 'admin-leaderboard') {
        const el = document.getElementById('admin-panel');
        if (el) el.classList.add('active');
        if (t !== 'adminmgmt' && t !== 'admin-home' && t !== 'admin-tasks' && t !== 'admin-leaderboard' && !adminPanelLoaded) { adminPanelLoaded = true; loadAdminPanel(); }
        const sectionMap = { 'admin-home': 'home', 'admin-reports': 'reports', 'admin': 'usermgmt', 'inactive': 'inactive', 'adminmgmt': 'adminmgmt', 'admin-tasks': 'tasks', 'admin-leaderboard': 'leaderboard' };
        selectAdminSection(sectionMap[t], null);
        if (t === 'adminmgmt') loadAdminMgmt();
        if (t === 'admin-home') loadSAHome();
        if (t === 'admin-tasks') loadSATasks();
        if (t === 'admin-leaderboard') loadAdminLeaderboard(true);
    } else {
        const panel = document.getElementById(t + '-panel');
        if (panel) panel.classList.add('active');
    }

    const btn = document.querySelector(`.tab-btn[onclick*="'${t}'"]`);
    if (btn) btn.classList.add('active');

    // Lazy-load data
    if (t === 'home')       { loadHomePanel(_homeWeekOffset); loadTasks(); }
    if (t === 'team')       loadLeaderboard(false);

    // Sync bottom nav active state
    const bnavMap = { home:0, mysadhana:1, team:2, manage:3 };
    const aBnavMap = { 'admin-home':0, 'admin-reports':1, admin:2, inactive:3, 'admin-leaderboard':4, 'admin-tasks':5 };
    const userBnav  = document.getElementById('user-bottom-nav');
    const adminBnav = document.getElementById('admin-bottom-nav');
    if (userBnav && bnavMap[t] !== undefined) {
        userBnav.querySelectorAll('.bnav-item').forEach((b,i) => b.classList.toggle('active', i === bnavMap[t]));
    }
    if (adminBnav && aBnavMap[t] !== undefined) {
        adminBnav.querySelectorAll('.bnav-item').forEach((b,i) => b.classList.toggle('active', i === aBnavMap[t]));
    }
};

// Sub-tab switchers
window.switchSadhanaTab = (sub, btn) => {
    document.querySelectorAll('#mysadhana-panel .subtab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('#mysadhana-panel .subtab-panel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById('sadhana-' + sub + '-sub');
    if (panel) panel.classList.add('active');
    if (btn) btn.classList.add('active');
    if (sub === 'reports') loadReports(currentUser.uid, 'weekly-reports-container');
    if (sub === 'progress') loadMyProgressChart('daily');
};

window.switchTeamTab = (sub, btn) => {
    document.querySelectorAll('#team-panel .subtab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('#team-panel .subtab-panel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById('team-' + sub + '-sub');
    if (panel) panel.classList.add('active');
    if (btn) btn.classList.add('active');
    if (sub === 'wcr') loadUserWCR();
    if (sub === 'rankings') loadLeaderboard(true);
};

let _homeWeekOffset = 0;
window.switchHomeWeek = (offset, btn) => {
    _homeWeekOffset = offset;
    document.querySelectorAll('#home-week-tabs .chart-tab-btn').forEach((b,i) => b.classList.toggle('active', i === offset));
    loadHomePanel(offset);
};

function showSection(sec) {
    ['auth-section','profile-section','dashboard-section'].forEach(id =>
        document.getElementById(id).classList.add('hidden'));
    document.getElementById(sec+'-section').classList.remove('hidden');
}

// ═══════════════════════════════════════════════════════════
// USER WCR (Team/Dept comparative report for regular users)
// ═══════════════════════════════════════════════════════════
let _userWCRLoaded = false;
async function loadUserWCR() {
    const container = document.getElementById('user-wcr-container');
    if (!container) return;
    if (_userWCRLoaded) return;
    _userWCRLoaded = true;
    container.innerHTML = '<p style="color:#aaa;text-align:center;padding:20px;">Loading…</p>';

    try {
        const usersSnap = await db.collection('users').get();
        const filtered = usersSnap.docs
            .filter(doc => {
                const d = doc.data();
                // Exclude all admins — only regular users in WCR
                if (d.role === 'superAdmin' || d.role === 'deptAdmin' || d.role === 'overallTeamLeader' || d.role === 'teamLeader' || d.role === 'admin') return false;
                return matchesViewScope(d) && d.name;
            })
            .sort((a,b) => (a.data().name||'').localeCompare(b.data().name||''));

        const weeks = [];
        for (let i=0;i<4;i++) {
            weeks.push(getWeekInfo(localDateStr(i*7)));
        }
        weeks.reverse();

        const pctStyle = (pct) => {
            if (pct < 0)   return { bg:'#FFFDE7', color:'#b91c1c', bold:true, text:`(${pct}%)` };
            if (pct < 20)  return { bg:'#FFFDE7', color:'#b91c1c', bold:true, text:`${pct}%` };
            if (pct >= 70) return { bg:'', color:'#15803d', bold:true, text:`${pct}%` };
            return { bg:'', color:'#1a252f', bold:false, text:`${pct}%` };
        };

        window._wcrUserList = [];

        let tHtml = `<div style="overflow-x:auto;"><table class="comp-table" style="min-width:500px;">
            <thead><tr>
                <th class="comp-th comp-th-name">Name</th>
                <th class="comp-th">Level</th>
                <th class="comp-th">Team</th>
                ${weeks.map(w=>`<th class="comp-th">${w.label.split('_')[0]}</th>`).join('')}
            </tr></thead><tbody>`;

        // Only fetch last 4 weeks of sadhana data for performance
        const wcrFourWeeksAgo = localDateStr(28);
        const allSnaps = await Promise.all(filtered.map(uDoc =>
            uDoc.ref.collection('sadhana')
                .where(firebase.firestore.FieldPath.documentId(), '>=', wcrFourWeeksAgo)
                .get()
        ));

        filtered.forEach((uDoc, rowIdx) => {
            const u = uDoc.data();
            const sSnap = allSnaps[rowIdx];
            // Use Map for O(1) date lookups instead of array.find()
            const entsMap = new Map();
            sSnap.docs.forEach(d => entsMap.set(d.id, { score: d.data().totalScore||0, bonus: d.data().bonusTotal||0, svcMins: d.data().serviceMinutes||0, sleepTime: d.data().sleepTime||'' }));
            const stripeBg = rowIdx % 2 === 0 ? '#ffffff' : '#f8fafc';

            const wcrIdx = window._wcrUserList.length;
            window._wcrUserList.push({
                uid: uDoc.id, name: u.name||'', level: u.level||'Level-1',
                chanting: u.chantingCategory||'', rounds: u.exactRounds||'0',
                role: u.role||'user', dept: u.department||'', team: u.team||''
            });

            const isSelf = uDoc.id === currentUser.uid;
            const nameClick = ` onclick="openWCRUser(${wcrIdx})" style="cursor:pointer;${isSelf?'font-weight:800;color:#1A3C5E;':''}" title="View ${u.name||'user'}"`;
            tHtml += `<tr style="background:${isSelf?'#eff6ff':stripeBg}">
                <td class="comp-td comp-name"${nameClick}>${u.name}${isSelf?' ★':''}</td>
                <td class="comp-td comp-meta">${u.level||'L1'}</td>
                <td class="comp-td comp-meta">${u.team||'-'}</td>`;

            weeks.forEach(w => {
                let tot=0, svcMinsWeek=0; const weekEnts=[]; const todayC = localDateStr(0);
                let curr=new Date(w.sunStr);
                for (let i=0;i<7;i++) {
                    const ds=toLocalDS(curr);
                    if (ds < APP_START || ds > todayC) { curr.setDate(curr.getDate()+1); continue; }
                    const en = entsMap.get(ds);
                    if (en) {
                        tot += en.score + (en.bonus||0);
                        svcMinsWeek += en.svcMins||0;
                        weekEnts.push({id:ds,sleepTime:en.sleepTime||''});
                    } else if (ds < todayC) { tot += -30; }
                    curr.setDate(curr.getDate()+1);
                }
                tot += calcServiceWeekly(svcMinsWeek, u.level||'Level-1');
                const fd = fairDenominator(w.sunStr, weekEnts, u.level||'Level-1');
                const pct = fd > 0 ? Math.round((tot/fd)*100) : 0;
                const ps = pctStyle(pct);
                const pf = `<span style="display:inline-block;padding:1px 5px;border-radius:4px;font-size:9px;font-weight:700;margin-left:4px;background:${pct>=50?'#dcfce7':'#fee2e2'};color:${pct>=50?'#15803d':'#dc2626'};">${pct>=50?'P':'F'}</span>`;
                tHtml += `<td class="comp-td comp-pct" style="background:${ps.bg||stripeBg};color:${ps.color};font-weight:${ps.bold?'700':'400'};" title="${tot}/${fd}">${ps.text}${pf}</td>`;
            });
            tHtml += '</tr>';
        });
        tHtml += '</tbody></table></div>';
        container.innerHTML = tHtml;

        // Build cache for performers
        const perfCache = new Map();
        filtered.forEach((uDoc, i) => {
            const sSnap = allSnaps[i];
            perfCache.set(uDoc.id, sSnap.docs.map(d => ({ date: d.id, score: d.data().totalScore||0, bonus: d.data().bonusTotal||0, svcMins: d.data().serviceMinutes||0 })));
        });
        computePerformers(filtered, perfCache);
    } catch(err) {
        console.error('User WCR error:', err);
        container.innerHTML = '<p style="color:#dc2626;text-align:center;padding:20px;">Error loading data.</p>';
        _userWCRLoaded = false;
    }
}

// ═══════════════════════════════════════════════════════════
// 7. REPORTS TABLE
// ═══════════════════════════════════════════════════════════
const APP_START = '2026-02-12';

// Fair denominator: dailyMax × eligible days in week (no future days, no unsubmitted today)
// NR days (explicit or missing past days) count in denominator — they penalize via lower score
function fairDenominator(sunStr, weekData, level, joinedDate) {
    const dailyMax = getDailyMax(level || 'Level-1');
    const today = localDateStr(0);
    let days = 0;
    for (let i = 0; i < 7; i++) {
        const d = new Date(sunStr); d.setDate(d.getDate() + i);
        const ds = toLocalDS(d);
        if (ds < APP_START) continue;
        if (joinedDate && ds < joinedDate) continue;
        if (ds > today) break;
        if (ds === today) {
            // Count today only if ANY entry was submitted (including NR — they chose to mark it)
            const hasEntry = weekData && weekData.find(e => e.id === ds);
            if (!hasEntry) break;
        }
        days++;
    }
    return Math.max(days, 1) * dailyMax + 25;
}

// ─── Bonus popup ──────────────────────────────────────────
window.openBonusPopup = (bonusJson) => {
    const bonus = JSON.parse(decodeURIComponent(bonusJson));
    let html = '<table style="width:100%;border-collapse:collapse;font-size:13px;">';
    const row = (label, val) => {
        const color = val>0?'#15803d':val<0?'#dc2626':'#888';
        const disp  = val>0?`+${val}`:val===0?'0':val;
        // Show what value means
        const meaning = val===5?'✅ Yes':val===-5?'❌ No':val===0?'—':'';
        return `<tr>
            <td style="padding:7px 10px;border-bottom:1px solid #f0f0f0;">${label}</td>
            <td style="padding:7px 10px;border-bottom:1px solid #f0f0f0;color:#888;font-size:12px;">${meaning}</td>
            <td style="padding:7px 10px;font-weight:700;color:${color};border-bottom:1px solid #f0f0f0;">${disp}</td>
        </tr>`;
    };
    if (bonus.instrument !== undefined) html += row(`🎵 ${bonus.instrumentName||'Instrument'} (${bonus.instrumentMins} min)`, bonus.instrument);
    if (bonus.notes !== undefined && bonus.notes!==undefined) html += row(`📝 Notes Revision (${bonus.notesMins} min)`, bonus.notes);
    if (bonus.dress1 !== undefined)     html += row(`👗 ${bonus.dress1Label||'Dress 1'}`, bonus.dress1);
    if (bonus.dress2 !== undefined)     html += row(`👗 ${bonus.dress2Label||'Dress 2'}`, bonus.dress2);
    if (bonus.tilak !== undefined)      html += row(`🔱 Tilak`, bonus.tilak);
    if (bonus.mala !== undefined)       html += row(`📿 Mala`, bonus.mala);
    const total = (bonus.instrument||0)+(bonus.notes||0)+(bonus.dress1||0)+(bonus.dress2||0)+(bonus.tilak||0)+(bonus.mala||0);
    html += `<tr style="background:#f8fafc;">
        <td colspan="2" style="padding:8px 10px;font-weight:700;">Total Bonus</td>
        <td style="padding:8px 10px;font-weight:800;color:${total>=0?'#15803d':'#dc2626'};">${total>=0?'+':''}${total}</td>
    </tr>`;
    html += '</table>';
    document.getElementById('bonus-popup-content').innerHTML = html;
    document.getElementById('bonus-popup').classList.remove('hidden');
};
window.closeBonusPopup = () => document.getElementById('bonus-popup').classList.add('hidden');

// ── User Guide Tab Switcher ────────────────────────────────
window.guideTab = (tab) => {
    ['intro','form','level1','level2','level3','level4','reports','admin','faq'].forEach(t => {
        document.getElementById('gpanel-'+t)?.classList.add('hidden');
        document.getElementById('gtab-'+t)?.classList.remove('active');
    });
    document.getElementById('gpanel-'+tab)?.classList.remove('hidden');
    document.getElementById('gtab-'+tab)?.classList.add('active');
};

window.openUserGuide = (forcedTab) => {
    const modal = document.getElementById('user-guide-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    // Use forced tab (from admin click) or user's own level
    const level  = userProfile?.level || '';
    const tabMap = {'Level-1':'level1','Level-2':'level2','Level-3':'level3','Level-4':'level4'};
    const tab    = forcedTab || tabMap[level] || 'intro';
    window.guideTab(tab);
    // Gold highlight on user's own level tab
    ['level1','level2','level3','level4'].forEach(t => {
        const b = document.getElementById('gtab-'+t);
        if (!b) return;
        const isOwn = (t === tabMap[level]);
        b.style.outline      = isOwn ? '2px solid gold' : '';
        b.style.outlineOffset= isOwn ? '2px' : '';
        b.title              = isOwn ? 'Your current level' : '';
    });
};

function loadReports(userId, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (activeListener) { activeListener(); activeListener = null; }

    container.innerHTML = '<p style="text-align:center;color:#aaa;padding:20px;">Loading…</p>';

    // Use userProfile if viewing own reports, else fetch from Firestore
    const profilePromise = (userId === currentUser?.uid && userProfile)
        ? Promise.resolve(userProfile)
        : db.collection('users').doc(userId).get().then(d => d.exists ? d.data() : {});

    profilePromise.then(uData => {
        const level      = uData.level       || 'Level-1';
        const dept       = uData.department  || '';
        const instrument = uData.instrument  || '';
        const isL34      = level==='Level-3'||level==='Level-4';
        const dailyMax   = getDailyMax(level);
        const dress1Label= (dept==='IGF'||dept==='ICF_MTG') ? 'Gopi Dress' : 'Dhoti';
        const dress2Label= (dept==='IGF'||dept==='ICF_MTG') ? 'Blouse'     : 'Kurta';

        activeListener = db.collection('users').doc(userId).collection('sadhana')
            .onSnapshot(snap => {
                const weeksList = [];
                for (let i=0;i<4;i++) {
                    const d = new Date(); d.setDate(d.getDate()-i*7);
                    weeksList.push(getWeekInfo(toLocalDS(d)));
                }
                const weeks = {};
                weeksList.forEach(w => { weeks[w.label] = {range:w.label, sunStr:w.sunStr, data:[], total:0}; });

                snap.forEach(doc => {
                    if (doc.id < APP_START) return;
                    const data = doc.data(); const wk = getWeekInfo(doc.id);
                    if (weeks[wk.label]) { weeks[wk.label].data.push({id:doc.id,...data}); weeks[wk.label].total+=(data.totalScore||0); }
                });

                weeksList.forEach(wi => {
                    const wk = weeks[wi.label];
                    let curr = new Date(wi.sunStr);
                    for (let i=0;i<7;i++) {
                        const ds = toLocalDS(curr);
                        if (ds>=APP_START && isPastDate(ds) && !wk.data.find(e=>e.id===ds)) {
                            const nr=getNRData(ds); wk.data.push(nr); wk.total+=nr.totalScore;
                        }
                        curr.setDate(curr.getDate()+1);
                    }
                });

                container.innerHTML = '';
                weeksList.forEach(wi => {
                    const wk    = weeks[wi.label];
                    // Weekly service pool
                    const svcTotal   = wk.data.reduce((s,e)=>s+(e.serviceMinutes||0),0);
                    const svcScore   = calcServiceWeekly(svcTotal, level);
                    const weekBonus  = wk.data.reduce((s,e)=>s+(e.bonusTotal||0),0);

                    const wkFD       = fairDenominator(wi.sunStr, wk.data, level);
                    const daySubtotal = wk.total + weekBonus; // sum of daily totals (incl bonus)
                    const wkTotal    = daySubtotal + svcScore;
                    const wkPct      = Math.round((wkTotal / wkFD) * 100);
                    const wkColor    = wkTotal < 0 ? '#dc2626' : wkPct < 30 ? '#d97706' : '#16a34a';
                    const div     = document.createElement('div'); div.className='week-card';
                    const bodyId  = containerId.replace(/[^a-zA-Z0-9]/g,'') + '-wb-' + wi.sunStr;

                    // Score cell styling
                    const mkS = (v) => {
                        const color = v<0?'#b91c1c':v>=20?'#15803d':'#1a252f';
                        const bg    = v<0?'#fff5f5':v>=20?'#f0fdf4':'';
                        const bold  = v!==0?'700':'400';
                        const disp  = v<0?`(${v})`:v;
                        return `<td style="background:${bg};color:${color};font-weight:${bold};">${disp}</td>`;
                    };
                    // Green+bold for best-of
                    const mkBest = (v, isBest) => {
                        const color = isBest ? '#15803d' : (v<0?'#b91c1c':'#1a252f');
                        const bg    = isBest ? '#f0fdf4' : (v<0?'#fff5f5':'');
                        const bold  = isBest ? '800' : (v!==0?'600':'400');
                        const disp  = v<0?`(${v})`:v;
                        const border= isBest ? 'border:2px solid #16a34a;' : '';
                        return `<td style="background:${bg};color:${color};font-weight:${bold};${border}">${disp}</td>`;
                    };

                    // Sunday service pool progress — week header mein show hoga, table mein nahi
                    const svcPoolInfo = `🛠️ ${svcTotal}min`;

                    const rowsHtml = wk.data.sort((a,b)=>b.id.localeCompare(a.id)).map((e, ri) => {
                        const isNR       = e.sleepTime === 'NR';
                        const isRejected = e.rejected === true;
                        const stripeBg   = ri%2===0?'#ffffff':'#f8fafc';
                        const rowBg      = isRejected ? '#fff0f0' : isNR ? '#fff5f5' : stripeBg;
                        const sc       = e.scores || {};
                        const editedBadge = e.editedAt
                            ? `<span class="edited-badge" onclick="showEditHistory(event,'${e.id}','${userId}')" title="View edit history">✏️</span>` : '';
                        const editBtn = isSuperAdmin()
                            ? `<button onclick="openEditModal('${userId}','${e.id}')" class="btn-edit-cell">${isNR ? '📝 Fill' : 'Edit'}</button>
                               ${!isNR ? `<button onclick="openRejectModal('${userId}','${e.id}',${isRejected})" class="btn-edit-cell" style="background:${isRejected?'#16a34a':'#dc2626'} !important;">${isRejected?'✅ Restore':'🚫 Reject'}</button>` : ''}` : '';

                        // Best of pathan/hearing
                        const patS  = sc.reading??0;
                        const hearS = sc.hearing??0;
                        const patIsBest  = !isL34 && patS >= hearS;
                        const hearIsBest = !isL34 && hearS > patS;

                        // Bonus total + JSON for popup
                        const bonus = e.bonus || {};
                        const bonusTotal = (bonus.instrument||0)+(bonus.notes||0)+(bonus.dress1||0)+(bonus.dress2||0)+(bonus.tilak||0)+(bonus.mala||0);
                        const bonusObj = {
                            level, instrument: bonus.instrument, instrumentName: instrument,
                            instrumentMins: e.instrumentMinutes||0,
                            notes: bonus.notes, notesMins: e.notesMinutes||0,
                            dress1: bonus.dress1, dress1Label,
                            dress2: bonus.dress2, dress2Label,
                            tilak: bonus.tilak, mala: bonus.mala
                        };
                        const bonusJson = encodeURIComponent(JSON.stringify(bonusObj));
                        const bonusBg   = bonusTotal>0?'#faf5ff':bonusTotal<0?'#fff5f5':'';
                        const bonusColor= bonusTotal>0?'#7c3aed':bonusTotal<0?'#b91c1c':'#888';
                        const bonusCell = bonusTotal!==0
                            ? `<td style="background:${bonusBg};color:${bonusColor};font-weight:700;cursor:pointer;text-decoration:underline dotted;" onclick="openBonusPopup('${bonusJson}')" title="Click for breakdown">${bonusTotal>0?'+':''}${bonusTotal}</td>`
                            : `<td style="color:#aaa;">—</td>`;
                        // Grand total = daily score + bonus
                        const grandTotal = (e.totalScore||0) + bonusTotal;
                        const gtColor    = grandTotal<0?'#b91c1c':grandTotal>=(dailyMax*0.8)?'#15803d':'#1a252f';

                        // Service — minutes only, no marks (weekly pool)
                        const svcMins = e.serviceMinutes||0;

                        return `<tr style="background:${rowBg};">
                            <td style="font-weight:600;background:${rowBg};">${e.id.split('-').slice(1).reverse().join('/')}${editedBadge}</td>
                            <td style="${isNR?'color:#b91c1c;font-weight:700;':''}">${fmt12(e.sleepTime||'NR')}</td>${mkS(sc.sleep??0)}
                            <td style="${isNR?'color:#b91c1c;':''}">${fmt12(e.wakeupTime||'NR')}</td>${mkS(sc.wakeup??0)}
                            <td>${fmt12(e.chantingTime||'NR')}</td>${mkS(sc.chanting??0)}
                            <td>${e.readingMinutes||0}m</td>${mkBest(patS, patIsBest)}
                            <td>${e.hearingMinutes||0}m</td>${mkBest(hearS, hearIsBest)}
                            <td>${e.instrumentMinutes||0}m</td>${mkS(sc.instrument??0)}
                            <td>${e.daySleepMinutes||0}m</td>${mkS(sc.daySleep??0)}
                            <td style="color:#6b7280;">${svcMins}m</td>
                            ${bonusCell}
                            <td style="font-weight:800;color:${gtColor};">${grandTotal}</td>
                            <td>${e.dayPercent??0}%</td>
                            ${isSuperAdmin()?`<td style="padding:2px 4px;">${editBtn}</td>`:''}
                        </tr>`;
                    }).join('');

                    const instrHeader = isL34 ? `<th>${instrument||'Instrument'}</th><th>M</th>` : `<th>${instrument||'Instrument'}</th><th>M</th>`;
                    const editThCol   = isSuperAdmin() ? '<th></th>' : '';

                    div.innerHTML = `
                        <div class="week-header" onclick="document.getElementById('${bodyId}').classList.toggle('open')">
                            <span style="white-space:nowrap;">📅 ${wk.range.replace('_',' ')}</span>
                            <span style="display:flex;align-items:center;gap:6px;flex-wrap:nowrap;">
                                ${svcScore !== 0 ? `<span style="font-size:11px;color:#6b7280;white-space:nowrap;">${daySubtotal} 🛠️${svcScore>=0?'+':''}${svcScore} =</span>` : ''}
                                <strong style="white-space:nowrap;color:${wkColor}">${wkTotal} / ${wkFD} (${wkPct}%) ▼</strong>
                            </span>
                        </div>
                        <div class="week-body" id="${bodyId}">
                            <table class="data-table">
                            <thead><tr>
                                <th>Date</th><th>Bed</th><th>M</th><th>Wake</th><th>M</th><th>Chant</th><th>M</th>
                                <th>Pathan</th><th>M</th><th>Hearing</th><th>M</th>
                                ${instrHeader}
                                <th>Day Sleep</th><th>M</th>
                                <th>Seva(m)</th>
                                <th>Bonus</th>
                                <th>Total</th><th>%</th>
                                ${editThCol}
                            </tr></thead>
                            <tbody>${rowsHtml}</tbody></table>
                        </div>`;
                    container.appendChild(div);
                });
            }, err => console.error('Snapshot error:', err));
    }).catch(err => {
        console.error('loadReports profile fetch error:', err);
        container.innerHTML = '<p style="text-align:center;color:#dc2626;padding:20px;">Error loading reports. Please try again.</p>';
    });
}

// ═══════════════════════════════════════════════════════════
// 8. PROGRESS CHARTS
// ═══════════════════════════════════════════════════════════
let myChartInstance    = null;
let modalChartInstance = null;
let progressModalUserId   = null;
let progressModalUserName = null;
let progressModalUserLevel = null;

async function fetchChartData(userId, view, level) {
    const snap = await db.collection('users').doc(userId).collection('sadhana')
        .orderBy(firebase.firestore.FieldPath.documentId()).get();
    const allEntries = [];
    snap.forEach(doc => {
        if (doc.id >= APP_START) allEntries.push({ date: doc.id, score: doc.data().totalScore || 0, bonus: doc.data().bonusTotal || 0, svcMins: doc.data().serviceMinutes || 0 });
    });

    if (view === 'daily') {
        const labels = [], data = [];
        for (let i = 27; i >= 0; i--) {
            const ds    = localDateStr(i);
            if (ds < APP_START) continue;
            const entry = allEntries.find(e => e.date === ds);
            if (i === 0 && !entry) continue; // skip today if not yet submitted
            labels.push(ds.split('-').slice(1).reverse().join('/'));
            data.push(entry ? entry.score + (entry.bonus||0) : -35);
        }
        return { labels, data, label:'Daily Score', max:160, color:'#3498db' };
    }

    if (view === 'weekly') {
        const labels = [], data = [];
        const todayStr = localDateStr(0);
        const chartLevel = level || 'Level-1';
        for (let i = 11; i >= 0; i--) {
            const d  = new Date(); d.setDate(d.getDate() - i*7);
            const wi = getWeekInfo(toLocalDS(d));
            if (wi.sunStr < APP_START) continue;
            let tot = 0, svcMinsWeek = 0; let curr = new Date(wi.sunStr);
            for (let j=0;j<7;j++) {
                const ds = toLocalDS(curr);
                if (ds > todayStr) { curr.setDate(curr.getDate()+1); continue; }
                const en = allEntries.find(e=>e.date===ds);
                if (ds === todayStr && !en) { curr.setDate(curr.getDate()+1); continue; }
                if (en) { tot += en.score + (en.bonus||0); svcMinsWeek += en.svcMins||0; } else { tot += -30; }
                curr.setDate(curr.getDate()+1);
            }
            tot += calcServiceWeekly(svcMinsWeek, chartLevel);
            labels.push(wi.label.split('_')[0].split(' to ')[0]);
            data.push(tot);
        }
        return { labels, data, label:'Weekly Score', max:1120, color:'#27ae60' };
    }

    if (view === 'monthly') {
        const monthMap = {};
        allEntries.forEach(en => {
            const ym = en.date.substring(0,7);
            monthMap[ym] = (monthMap[ym]||0) + en.score + (en.bonus||0);
        });
        const sorted = Object.keys(monthMap).sort();
        const labels = sorted.map(ym => {
            const [y,m] = ym.split('-');
            return `${new Date(y,m-1).toLocaleString('en-GB',{month:'short'})} ${y}`;
        });
        return { labels, data: sorted.map(k=>monthMap[k]), label:'Monthly Score', max:null, color:'#8b5cf6' };
    }
}

function renderChart(canvasId, chartData, existingInstance) {
    const ctx = document.getElementById(canvasId).getContext('2d');
    if (existingInstance) existingInstance.destroy();
    return new Chart(ctx, {
        type: 'line',
        data: {
            labels: chartData.labels,
            datasets: [{
                label: chartData.label,
                data: chartData.data,
                borderColor: chartData.color,
                backgroundColor: chartData.color + '22',
                borderWidth: 2.5,
                pointRadius: 4,
                pointHoverRadius: 6,
                fill: true,
                tension: 0.35
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: ctx => ` Score: ${ctx.parsed.y}${chartData.max?' / '+chartData.max:''}` } }
            },
            scales: {
                x: { ticks: { font:{size:10}, maxRotation:45 }, grid:{display:false} },
                y: {
                    ticks: { font:{size:11} }, grid: { color:'#f0f0f0' },
                    suggestedMin: chartData.max ? -chartData.max*0.15 : undefined,
                    suggestedMax: chartData.max || undefined
                }
            }
        }
    });
}

async function loadMyProgressChart(view) {
    const data = await fetchChartData(currentUser.uid, view, userProfile?.level || 'Level-1');
    myChartInstance = renderChart('my-progress-chart', data, myChartInstance);
}

window.setChartView = async (view, btn) => {
    document.querySelectorAll('.chart-tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    await loadMyProgressChart(view);
};

window.openProgressModal = async (userId, userName) => {
    progressModalUserId   = userId;
    progressModalUserName = userName;
    document.getElementById('progress-modal-title').textContent = `📈 ${userName} — Progress`;
    document.getElementById('progress-modal').classList.remove('hidden');
    document.querySelectorAll('#progress-modal-tabs .chart-tab-btn').forEach((b,i) => b.classList.toggle('active', i===0));
    // Fetch the user's level so weekly chart includes service weekly correctly
    try { const uSnap = await db.collection('users').doc(userId).get(); progressModalUserLevel = uSnap.data()?.level || 'Level-1'; } catch(e) { progressModalUserLevel = 'Level-1'; }
    const data = await fetchChartData(userId, 'daily', progressModalUserLevel);
    modalChartInstance = renderChart('modal-progress-chart', data, modalChartInstance);
};

window.closeProgressModal = () => {
    document.getElementById('progress-modal').classList.add('hidden');
    if (modalChartInstance) { modalChartInstance.destroy(); modalChartInstance = null; }
};

window.setModalChartView = async (view, btn) => {
    document.querySelectorAll('#progress-modal-tabs .chart-tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const data = await fetchChartData(progressModalUserId, view, progressModalUserLevel || 'Level-1');
    modalChartInstance = renderChart('modal-progress-chart', data, modalChartInstance);
};

// ═══════════════════════════════════════════════════════════
// 9. SADHANA FORM SCORING  (with sleep time warning)
// ═══════════════════════════════════════════════════════════
document.getElementById('sadhana-form').onsubmit = async (e) => {
    e.preventDefault();
    const date = document.getElementById('sadhana-date').value;
    const existing = await db.collection('users').doc(currentUser.uid).collection('sadhana').doc(date).get();
    if (existing.exists) { alert(`❌ Sadhana for ${date} already submitted! Contact admin for corrections.`); return; }

    const level = userProfile.level || 'Level-1';
    const dept  = userProfile.department || '';
    const instrument = userProfile.instrument || '';
    let slp     = document.getElementById('sleep-time').value;
    const wak   = document.getElementById('wakeup-time').value;
    const chn   = document.getElementById('chanting-time').value;

    if (!slp || !wak || !chn) {
        showToast('Please select Bed Time, Wake Up Time and Chanting Time', 'error');
        return;
    }
    const rMin  = parseInt(document.getElementById('reading-mins').value)||0;
    const hMin  = parseInt(document.getElementById('hearing-mins').value)||0;
    const sMin  = parseInt(document.getElementById('service-mins')?.value)||0;
    const svcTxt= document.getElementById('service-text')?.value?.trim()||'';
    const nMin  = parseInt(document.getElementById('notes-mins')?.value)||0;
    const dsMin = parseInt(document.getElementById('day-sleep-minutes').value)||0;
    const instMin = parseInt(document.getElementById('instrument-mins')?.value)||0;

    // Sleep time sanity check
    if (slp) {
        const [sh] = slp.split(':').map(Number);
        if (sh >= 4 && sh <= 20) {
            const goAhead = confirm(
                `⚠️ Bed Time Warning\n\nYou entered "${fmt12(slp)}" as bed time.\nThis looks like a daytime hour.\n\nDid you mean night time? e.g. 11:00 PM instead of 11:00 AM?\n\nTap OK if "${fmt12(slp)}" is correct.\nTap Cancel to go back and fix it.`
            );
            if (!goAhead) return;
        }
    }

    // ── Calculate scores using independent per-level engine ──
    let result;
    if      (level==='Level-1') result = calcScoreL1(slp,wak,chn,rMin,hMin,dsMin,instMin);
    else if (level==='Level-2') result = calcScoreL2(slp,wak,chn,rMin,hMin,dsMin,instMin);
    else if (level==='Level-3') result = calcScoreL3(slp,wak,chn,rMin,hMin,dsMin,instMin);
    else                        result = calcScoreL4(slp,wak,chn,rMin,hMin,dsMin,instMin,nMin);

    // ── Sunday bonus ──
    const today    = new Date(date);
    const isSunday = today.getDay() === 0;
    let bonus = {};
    if (isSunday) {
        const dress1Val = document.getElementById('dress1-field')?.value||'no';
        const dress2Val = document.getElementById('dress2-field')?.value||'no';
        const tilakVal  = document.getElementById('tilak-field')?.value||'no';
        const malaVal   = document.getElementById('mala-field')?.value||'no';
        const sb = calcSundayBonus(dress1Val, dress2Val, tilakVal, malaVal, level);
        bonus = { dress1: sb.dress1, dress2: sb.dress2, tilak: sb.tilak, mala: sb.mala };
    }

    // L1/L2: instrument is bonus, L3/L4: instrument already in total
    const isL12 = level==='Level-1'||level==='Level-2';
    if (isL12) bonus.instrument = result.instrumentBonus;
    if (level==='Level-4') bonus.notes = result.notesBonus||0;

    const bonusTotal = Object.values(bonus).reduce((s,v)=>s+v,0);

    try {
        await db.collection('users').doc(currentUser.uid).collection('sadhana').doc(date).set({
            sleepTime: slp, wakeupTime: wak, chantingTime: chn,
            readingMinutes: rMin, hearingMinutes: hMin,
            serviceMinutes: sMin, serviceText: svcTxt,
            notesMinutes: nMin, instrumentMinutes: instMin,
            daySleepMinutes: dsMin,
            scores: result.sc, totalScore: result.total,
            bonus, bonusTotal,
            dayPercent: result.dayPercent,
            bestOf: result.bestIs,
            levelAtSubmission: level, instrument,
            submittedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        if (!userProfile.joinedDate) {
            db.collection('users').doc(currentUser.uid).update({ joinedDate: date });
        }
        showSubmitSuccess(result.total, bonusTotal, result.dayPercent);
    } catch(err) {
        showToast('❌ Failed to submit: ' + err.message, 'error');
    }
};

function showSubmitSuccess(score, bonus, pct) {
    const overlay = document.getElementById('submit-success-overlay');
    if (!overlay) { switchSadhanaTab('reports'); return; }
    const dailyMax = getDailyMax(userProfile?.level || 'Level-1');
    const total = score + (bonus || 0);
    document.getElementById('ss-score').textContent = total;
    document.getElementById('ss-max').textContent = 'out of ' + dailyMax + ' pts';
    document.getElementById('ss-pct').textContent = pct + '%';
    const msgs = [
        'Jai Shri Krishna! Keep up the devotion 🙏',
        'Wonderful! Every sadhana brings you closer ✨',
        'Hare Krishna! Your efforts are counted 📿',
        'Well done! Guru is pleased with your practice 🙌',
        'Beautiful! Consistency is the key to progress 💪'
    ];
    document.getElementById('ss-msg').textContent = msgs[Math.floor(Math.random() * msgs.length)];
    const bar = document.getElementById('ss-bar');
    bar.style.width = '0';
    overlay.classList.add('visible');
    requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = Math.min(Math.max(pct,0), 100) + '%'; }));
    setTimeout(() => {
        overlay.classList.remove('visible');
        bar.style.width = '0';
        switchTab('home'); // Go to home so user sees updated stats
    }, 2800);
}

// ═══════════════════════════════════════════════════════════
// 10. ADMIN PANEL
// ═══════════════════════════════════════════════════════════

window.filterInactive = (minDays, btn) => {
    document.querySelectorAll('.inactive-filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const body = document.getElementById('inactive-cards-body');
    if (body && window._buildInactiveCards) {
        body.innerHTML = window._buildInactiveCards(minDays);
    }
};

let adminPanelLoaded = false;
// Admin drawer removed — using top nav tabs instead

window.selectAdminSection = (section, btn) => {
    // Switch active nav item
    document.querySelectorAll('.drawer-nav-item').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    // Switch content panel
    document.querySelectorAll('.admin-sub-panel').forEach(p => { p.classList.remove('active'); p.classList.add('hidden'); });
    const panel = document.getElementById('admin-sub-' + section);
    if (panel) { panel.classList.remove('hidden'); panel.classList.add('active'); }

};

window.filterAdminUsers = () => {
    const query = (document.getElementById('admin-search-input')?.value || '').toLowerCase().trim();
    const dept  = document.getElementById('admin-filter-dept')?.value  || '';
    const level = document.getElementById('admin-filter-level')?.value || '';
    const team  = document.getElementById('admin-filter-team')?.value  || '';
    const cards = document.querySelectorAll('#admin-users-list .user-card');
    cards.forEach(card => {
        const name = (card.querySelector('.user-name')?.textContent || '').toLowerCase();
        const meta = (card.querySelector('.user-meta')?.textContent || '');
        const matchName  = !query || name.includes(query);
        const matchDept  = !dept  || meta.includes(dept);
        const matchLevel = !level || meta.includes(level);
        const matchTeam  = !team  || meta.includes(team);
        card.style.display = (matchName && matchDept && matchLevel && matchTeam) ? '' : 'none';
    });
};

window.filterInactiveUsers = () => {
    const dept  = document.getElementById('inactive-filter-dept')?.value  || '';
    const level = document.getElementById('inactive-filter-level')?.value || '';
    const team  = document.getElementById('inactive-filter-team')?.value  || '';
    const cards = document.querySelectorAll('#admin-inactive-container .inactive-card');
    cards.forEach(card => {
        const meta = card.dataset.meta || '';
        const matchDept  = !dept  || meta.includes(dept);
        const matchLevel = !level || meta.includes(level);
        const matchTeam  = !team  || meta.includes(team);
        card.style.display = (matchDept && matchLevel && matchTeam) ? '' : 'none';
    });
};

// Update team dropdown based on selected dept — for all filter bars
window.updateFilterTeams = (prefix) => {
    const dept = document.getElementById(prefix + '-filter-dept')?.value || '';
    const teamSel = document.getElementById(prefix + '-filter-team');
    if (!teamSel) return;

    // Get teams: if dept selected show that dept's teams, else all teams A-Z
    let teams;
    if (dept && DEPT_TEAMS[dept]) {
        teams = [...DEPT_TEAMS[dept]].filter(t => t !== 'Overall' && t !== 'Other').sort();
        // Add Overall and Other at end if they exist
        if (DEPT_TEAMS[dept].includes('Other'))   teams.push('Other');
        if (DEPT_TEAMS[dept].includes('Overall')) teams.push('Overall');
    } else {
        // All teams across all depts, A-Z, deduplicated
        const all = new Set();
        Object.values(DEPT_TEAMS).forEach(arr => arr.forEach(t => all.add(t)));
        teams = [...all].sort();
    }

    const current = teamSel.value;
    teamSel.innerHTML = '<option value="">All Teams</option>';
    teams.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t; opt.textContent = t;
        if (t === current) opt.selected = true;
        teamSel.appendChild(opt);
    });

    // Trigger filter after updating teams
    const fnMap = {
        'reports':  'filterReports',
        'admin':    'filterAdminUsers',
        'inactive': 'filterInactiveUsers',
    };
    if (fnMap[prefix] && window[fnMap[prefix]]) window[fnMap[prefix]]();
};

window.filterReports = () => {
    const dept  = document.getElementById('reports-filter-dept')?.value  || '';
    const level = document.getElementById('reports-filter-level')?.value || '';
    const team  = document.getElementById('reports-filter-team')?.value  || '';
    const rows  = document.querySelectorAll('#comp-perf-table tbody tr');
    rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        const lvl  = cells[1]?.textContent || '';
        const dpt  = cells[2]?.textContent || '';
        const tm   = cells[3]?.textContent || '';
        const matchDept  = !dept  || dpt.includes(dept);
        const matchLevel = !level || lvl.includes(level);
        const matchTeam  = !team  || tm.includes(team);
        row.style.display = (matchDept && matchLevel && matchTeam) ? '' : 'none';
    });
};
async function loadAdminPanel() {
    try {
    const tableBox        = document.getElementById('admin-comparative-reports-container');
    const usersList       = document.getElementById('admin-users-list');
    const inactiveCont    = document.getElementById('admin-inactive-container');
    if (tableBox) tableBox.innerHTML    = '<p style="color:#aaa;text-align:center;padding:20px;">Loading…</p>';
    if (usersList) usersList.innerHTML   = '<p style="color:#aaa;text-align:center;padding:20px;">Loading…</p>';
    if (inactiveCont) inactiveCont.innerHTML = '';

    const weeks = [];
    for (let i=0;i<4;i++) {
        weeks.push(getWeekInfo(localDateStr(i*7)));
    }
    weeks.reverse();

    const usersSnap = await db.collection('users').get();
    const filtered = usersSnap.docs
        .filter(doc => {
            const d = doc.data();
            // Exclude all admins — only show regular users in reports/management
            if (d.role === 'superAdmin' || d.role === 'deptAdmin' || d.role === 'overallTeamLeader' || d.role === 'teamLeader' || d.role === 'admin') return false;
            return matchesScope(d);
        })
        .sort((a,b) => (a.data().name||'').localeCompare(b.data().name||''));

    // Color helper for percentage cells
    const pctStyle = (pct) => {
        if (pct < 0)   return { bg:'#FFFDE7', color:'#b91c1c', bold:true, text:`(${pct}%)` };
        if (pct < 20)  return { bg:'#FFFDE7', color:'#b91c1c', bold:true, text:`${pct}%`   };
        if (pct >= 70) return { bg:'',        color:'#15803d', bold:true, text:`${pct}%`   };
        return              { bg:'',        color:'#1a252f', bold:false, text:`${pct}%`  };
    };

    let tHtml = `<table class="comp-table" id="comp-perf-table">
        <thead><tr>
            <th class="comp-th comp-th-name">Name</th>
            <th class="comp-th">Level</th>
            <th class="comp-th">Dept</th>
            <th class="comp-th">Team</th>
            <th class="comp-th">Chanting</th>
            ${weeks.map(w=>`<th class="comp-th">${w.label.split('_')[0]}</th>`).join('')}
        </tr></thead><tbody>`;

    usersList.innerHTML = '';

    const banner = document.createElement('div');
    banner.className = `info-banner ${isSuperAdmin()?'banner-purple':'banner-blue'}`;
    const scope = getAdminScope();
    banner.innerHTML = isSuperAdmin()
        ? '👑 <strong>Super Admin</strong> — All departments, full role management'
        : isDeptAdmin()
        ? `🛡️ <strong>Dept Admin</strong> — Department: <strong>${userProfile.department||''}</strong>`
        : isOverallTeamLeader()
        ? `🌐 <strong>Overall Team Leader</strong> — Team: <strong>${userProfile.team||''}</strong> (all departments)`
        : `👥 <strong>Team Leader</strong> — Team: <strong>${userProfile.team||''}</strong> · Dept: <strong>${userProfile.department||''}</strong>`;
    usersList.appendChild(banner);

    const searchInput = document.getElementById('admin-search-input');
    if (searchInput) searchInput.value = '';

    // ── INACTIVE DEVOTEES SECTION ─────────────────────────
    // Calculate consecutive missing days (excluding today) per user
    // We check up to 30 days back to find max consecutive streak

    // Inactive list will be populated inside main user loop below
    // Each entry: { id, name, level, lastDate, missedDays }
    const inactiveUsers = [];
    const userSadhanaCache = new Map();
    window._adminCmpUserList = [];

    // Fetch sadhana data in batches — only last 4 weeks for WCR performance
    const allSadhanaSnaps = [];
    const BATCH = 25;
    const fourWeeksAgo = localDateStr(28);
    for (let i = 0; i < filtered.length; i += BATCH) {
        const batch = filtered.slice(i, i + BATCH);
        const snaps = await Promise.all(batch.map(uDoc =>
            uDoc.ref.collection('sadhana')
                .where(firebase.firestore.FieldPath.documentId(), '>=', fourWeeksAgo)
                .get()
        ));
        allSadhanaSnaps.push(...snaps);
    }

    for (let idx = 0; idx < filtered.length; idx++) {
        const uDoc  = filtered[idx];
        const u     = uDoc.data();
        const sSnap = allSadhanaSnaps[idx];
        // Use Map for O(1) date lookups
        const entsMap = new Map();
        sSnap.docs.forEach(d => entsMap.set(d.id, { score: d.data().totalScore||0, bonus: d.data().bonusTotal||0, svcMins: d.data().serviceMinutes||0, sleepTime: d.data().sleepTime||'' }));
        userSadhanaCache.set(uDoc.id, Array.from(entsMap.entries()).map(([date, v]) => ({ date, ...v })));

        const submittedDates = new Set(sSnap.docs.map(d => d.id).filter(d => d >= APP_START));
        let missedDays = 0;
        for (let i = 1; i <= 30; i++) {
            const ds = localDateStr(i);
            if (ds < APP_START) break;
            if (submittedDates.has(ds)) break;
            missedDays++;
        }
        if (missedDays >= 2) {
            const allDates = Array.from(submittedDates).sort((a,b) => b.localeCompare(a));
            const lastDate = allDates[0] || null;
            inactiveUsers.push({ id: uDoc.id, name: u.name, level: u.level||'Level-1', dept: u.department||'', team: u.team||'', lastDate, missedDays });
        }

        const stripeBg = idx % 2 === 0 ? '#ffffff' : '#f8fafc';
        const cmpIdx = window._adminCmpUserList.length;
        window._adminCmpUserList.push({
            uid: uDoc.id, name: u.name||'', level: u.level||'Level-1',
            chanting: u.chantingCategory||'', rounds: u.exactRounds||'0',
            role: u.role||'user', dept: u.department||'', team: u.team||''
        });
        tHtml += `<tr style="background:${stripeBg}">
            <td class="comp-td comp-name" onclick="openAdminCmpUser(${cmpIdx})" style="cursor:pointer;" title="View ${u.name}">${u.name}</td>
            <td class="comp-td comp-meta">${u.level||'L1'}</td>
            <td class="comp-td comp-meta">${u.department||'-'}</td>
            <td class="comp-td comp-meta">${u.team||'-'}</td>
            <td class="comp-td comp-meta">${u.chantingCategory||'N/A'}</td>`;
        weeks.forEach(w => {
            let tot=0, svcMinsWeek=0; let curr=new Date(w.sunStr);
            const weekEnts=[];
            const todayComp = localDateStr(0);
            for (let i=0;i<7;i++) {
                const ds=toLocalDS(curr);
                if (ds < APP_START) { curr.setDate(curr.getDate()+1); continue; }
                if (ds > todayComp) { curr.setDate(curr.getDate()+1); continue; }
                const en = entsMap.get(ds);
                if (en) {
                    tot += en.score + (en.bonus||0);
                    svcMinsWeek += en.svcMins||0;
                    weekEnts.push({id:ds, sleepTime:en.sleepTime||'', score:en.score});
                } else if (ds < todayComp) {
                    tot += -30; // past day NR (matches getNRData totalScore)
                }
                // today not submitted — skip (not in fd either)
                curr.setDate(curr.getDate()+1);
            }
            tot += calcServiceWeekly(svcMinsWeek, u.level||'Level-1');
            const fd = fairDenominator(w.sunStr, weekEnts, u.level||'Level-1');
            const pct = Math.round((tot/fd)*100);
            const ps  = pctStyle(pct);
            const cellBg = ps.bg || stripeBg;
            tHtml += `<td class="comp-td comp-pct" style="background:${cellBg};color:${ps.color};font-weight:${ps.bold?'700':'400'};" title="${tot}/${fd}">${ps.text}</td>`;
        });
        tHtml += '</tr>';

        const card = document.createElement('div');
        card.className = 'user-card';

        let badge = '';
        if (u.role==='superAdmin')          badge=`<span class="role-badge" style="background:#7e22ce;color:white;">👑 Super Admin</span>`;
        else if (u.role==='deptAdmin')       badge=`<span class="role-badge" style="background:#1a5276;color:white;">🛡️ Dept Admin (${u.department||''})</span>`;
        else if (u.role==='overallTeamLeader') badge=`<span class="role-badge" style="background:#0369a1;color:white;">🌐 Overall TL (${u.team||''})</span>`;
        else if (u.role==='teamLeader')      badge=`<span class="role-badge" style="background:#1e8449;color:white;">👥 TL (${u.team||''} · ${u.department||''})</span>`;

        const safe = (u.name||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'");

        card.innerHTML = `
            <div class="user-card-top">
                <span class="user-name">${u.name}</span>${badge}
                <div class="user-meta">${u.level||'Level-1'} · ${u.department||'-'} · ${u.team||'-'} · ${u.chantingCategory||'N/A'} · ${u.exactRounds||'?'} rounds</div>
            </div>
            <div class="user-actions">
                <button onclick="openDevoteeProfile('${uDoc.id}','${safe}')" class="btn-primary btn-sm">👤 View Profile</button>
                <select onchange="handleLevelChange('${uDoc.id}', this)"
                    style="padding:6px 10px;border-radius:8px;border:1px solid #ddd;font-size:12px;height:34px;background:white;cursor:pointer;width:auto;margin:2px;">
                    <option value="" disabled selected>Level: ${u.level||'Level-1'}</option>
                    <option value="Level-1">Level-1</option>
                    <option value="Level-2">Level-2</option>
                    <option value="Level-3">Level-3</option>
                    <option value="Level-4">Level-4</option>
                </select>
            </div>`;
        usersList.appendChild(card);
    }
    // ── Now build inactive section (inactiveUsers is fully populated) ──
    inactiveUsers.sort((a,b) => (a.name||'').localeCompare(b.name||''));

    // Store globally for filter buttons to use
    window._inactiveUsers = inactiveUsers;

    const inactiveSection = document.createElement('div');
    inactiveSection.className = 'inactive-section';

    // Build cards HTML for a given filter
    const buildInactiveCards = (minDays) => {
        // minDays: 2 = exactly 2, 3 = exactly 3, 4 = 4 and above
        const filtered2 = minDays === 4
            ? inactiveUsers.filter(u => u.missedDays >= 4)
            : inactiveUsers.filter(u => u.missedDays === minDays);
        const label = minDays === 4 ? '4+ consecutive days' : `exactly ${minDays} days`;
        if (filtered2.length === 0) return `<div class="inactive-empty">✅ No devotees missing ${label}!</div>`;
        return filtered2.map(u => {
            const lastTxt = u.lastDate
                ? `Last entry: ${u.lastDate.split('-').slice(1).join(' ')}`
                : 'No entries yet';
            const safe = (u.name||'').replace(/'/g,"\'");
            const dot = u.missedDays >= 4 ? '🔴' : u.missedDays === 3 ? '🟠' : '🟡';
            return `<div class="inactive-card" data-meta="${u.dept} ${u.team} ${u.level}">
                <div class="inactive-card-left">
                    <span class="inactive-dot">${dot}</span>
                    <div>
                        <div class="inactive-name">${u.name}</div>
                        <div class="inactive-meta">${u.level||'Level-1'} · ${u.dept||'-'} · ${u.team||'-'} · ${lastTxt} · <strong>${u.missedDays} days missed</strong></div>
                    </div>
                </div>
                <div class="inactive-actions">
                    <button onclick="openUserModal('${u.id}','${safe}')" class="btn-primary btn-sm">History</button>
                    <button onclick="downloadUserExcel('${u.id}','${safe}')" class="btn-success btn-sm">Excel</button>
                </div>
            </div>`;
        }).join('');
    };

    const totalCount = inactiveUsers.length;
    const count4plus = inactiveUsers.filter(u => u.missedDays >= 4).length;

    inactiveSection.innerHTML = `
        <div class="inactive-filter-bar">
            <button class="inactive-filter-btn" onclick="filterInactive(2, this)">2 Days</button>
            <button class="inactive-filter-btn" onclick="filterInactive(3, this)">3 Days</button>
            <button class="inactive-filter-btn active" onclick="filterInactive(4, this)">4+ Days</button>
        </div>
        <div class="inactive-body" id="inactive-cards-body">
            ${buildInactiveCards(4)}
        </div>`;

    // Store builder for filter function
    window._buildInactiveCards = buildInactiveCards;
    const inactiveContainer = document.getElementById('admin-inactive-container');
    if (inactiveContainer) inactiveContainer.innerHTML = '';
    if (inactiveContainer) inactiveContainer.appendChild(inactiveSection);

    // Update inactive tab badge count — show 4+ days count
    const tabBadge = document.getElementById('inactive-tab-badge');
    if (tabBadge) tabBadge.textContent = count4plus > 0 ? count4plus : '';

    tableBox.innerHTML = tHtml + '</tbody></table>';

    // Build performers ring charts (admin WCR)
    computePerformers(filtered, userSadhanaCache);

    // Apply filters if already set (handles first-time filter before data loaded)
    requestAnimationFrame(() => {
        filterReports();
        filterAdminUsers();
        filterInactiveUsers();
    });
    } catch(err) {
        console.error('loadAdminPanel error:', err);
        adminPanelLoaded = false;
        const tableBox = document.getElementById('admin-comparative-reports-container');
        const usersList = document.getElementById('admin-users-list');
        const inactiveCont = document.getElementById('admin-inactive-container');
        const errMsg = '<p style="color:#dc2626;text-align:center;padding:20px;">Error loading: ' + (err.message||err) + '</p>';
        if (tableBox) tableBox.innerHTML = errMsg;
        if (usersList) usersList.innerHTML = errMsg;
        if (inactiveCont) inactiveCont.innerHTML = errMsg;
    }
}

// ── ADMIN MANAGEMENT ────────────────────────────────────────
async function loadAdminMgmt() {
    const container = document.getElementById('admin-mgmt-list');
    if (!container) return;
    container.innerHTML = '<p style="color:#aaa;text-align:center;padding:20px;">Loading…</p>';

    const snap = await db.collection('users').get();
    const admins = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(u => u.role === 'superAdmin' || u.role === 'deptAdmin' || u.role === 'overallTeamLeader' || u.role === 'teamLeader' || u.role === 'admin')
        .sort((a,b) => {
            const order = { superAdmin: 0, deptAdmin: 1, overallTeamLeader: 2, teamLeader: 3 };
            return (order[a.role]||3) - (order[b.role]||3) || (a.name||'').localeCompare(b.name||'');
        });

    if (!admins.length) {
        container.innerHTML = '<p style="color:#aaa;text-align:center;padding:20px;">No admins found.</p>';
        return;
    }

    container.innerHTML = admins.map(u => {
        const roleBadge = u.role === 'superAdmin'
            ? '<span style="background:#7e22ce;color:white;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:700;">👑 Super Admin</span>'
            : u.role === 'deptAdmin'
            ? `<span style="background:#1a5276;color:white;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:700;">🛡️ Dept Admin — ${u.department||''}</span>`
            : u.role === 'overallTeamLeader'
            ? `<span style="background:#0369a1;color:white;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:700;">🌐 Overall TL — ${u.team||''}</span>`
            : `<span style="background:#1e8449;color:white;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:700;">👥 Team Leader — ${u.team||''} (${u.department||''})</span>`;

        // Role change dropdown — only superAdmin can change all; deptAdmin can change within dept
        let roleOpts = '<option value="" disabled selected>Change Role…</option>';
        if (isSuperAdmin()) {
            if (u.role !== 'superAdmin') roleOpts += `<option value="superAdmin">👑 Make Super Admin</option>`;
            roleOpts += '<optgroup label="🛡️ Dept Admin">';
            ['IGF','IYF','ICF_MTG','ICF_PRJI'].forEach(dept =>
                roleOpts += `<option value="deptAdmin:${dept}">🛡️ ${dept}</option>`
            );
            roleOpts += '</optgroup>';
            const allTeams = [...new Set(Object.values(DEPT_TEAMS).flat().filter(t => t !== 'Other'))];
            allTeams.push('Other');
            roleOpts += '<optgroup label="🌐 Overall Team Leader (all depts)">';
            allTeams.forEach(team =>
                roleOpts += `<option value="overallTeamLeader:${team}">🌐 ${team} — All Depts</option>`
            );
            roleOpts += '</optgroup>';
            roleOpts += '<optgroup label="👥 Team Leader (dept-specific)">';
            ['IGF','IYF','ICF_MTG','ICF_PRJI'].forEach(dept => {
                if (DEPT_TEAMS[dept]) DEPT_TEAMS[dept].forEach(team =>
                    roleOpts += `<option value="teamLeader:${dept}:${team}">👥 ${team} (${dept})</option>`
                );
            });
            roleOpts += '</optgroup>';
            roleOpts += '<option value="demote">🚫 Revoke to User</option>';
        } else if (isDeptAdmin() && u.department === userProfile.department && u.role !== 'superAdmin') {
            if (DEPT_TEAMS[userProfile.department]) DEPT_TEAMS[userProfile.department].forEach(team =>
                roleOpts += `<option value="teamLeader:${userProfile.department}:${team}">👥 TL — ${team}</option>`
            );
            roleOpts += '<option value="demote">🚫 Revoke to User</option>';
        }

        const canChange = isSuperAdmin() || (isDeptAdmin() && u.department === userProfile.department && u.role !== 'superAdmin');
        const safe = (u.name||'').replace(/'/g,"\'");

        return `<div class="user-card">
            <div class="user-card-top">
                <span class="user-name">${u.name||'—'}</span>${roleBadge}
                <div class="user-meta">${u.department||'-'} · ${u.team||'-'} · ${u.email||''}</div>
            </div>
            ${canChange ? `<div class="user-actions">
                <select onchange="handleRoleDropdown('${u.id}',this)" style="padding:6px 10px;border-radius:8px;border:1px solid #ddd;font-size:12px;background:white;cursor:pointer;flex:1;min-width:180px;">
                    ${roleOpts}
                </select>
            </div>` : ''}
        </div>`;
    }).join('');
}

window.handleLevelChange = async (uid, sel) => {
    const newLevel = sel.value; sel.value = '';
    if (!newLevel) return;
    if (!confirm(`Change this devotee's level to ${newLevel}?`)) return;
    await db.collection('users').doc(uid).update({ level: newLevel });
    showToast(`✅ Level updated to ${newLevel}`, 'success');
    loadAdminPanel();
};

window.handleRoleDropdown = async (uid, sel) => {
    const val = sel.value; sel.value = '';
    if (!val) return;
    let newRole, dept = null, team = null, msg = '';

    if (val === 'superAdmin') {
        newRole = 'superAdmin';
        msg = '👑 Make this user SUPER ADMIN?\nFull access to all departments.';
    } else if (val.startsWith('deptAdmin:')) {
        newRole = 'deptAdmin';
        dept    = val.split(':')[1];
        msg     = `🛡️ Assign as Dept Admin for: ${dept}?`;
    } else if (val.startsWith('overallTeamLeader:')) {
        newRole = 'overallTeamLeader';
        team    = val.split(':')[1];
        msg     = `🌐 Assign as Overall Team Leader for team: ${team} (across ALL departments)?`;
    } else if (val.startsWith('teamLeader:')) {
        const parts = val.split(':');
        newRole = 'teamLeader';
        dept    = parts[1];
        team    = parts[2];
        msg     = `👥 Assign as Team Leader for team: ${team} (${dept})?`;
    } else if (val === 'demote') {
        newRole = 'user';
        msg     = '🚫 Revoke all admin access and set as regular User?';
    } else return;

    if (!confirm(msg)) return;
    if (!confirm('Final confirmation?')) return;

    const updateData = { role: newRole, department: dept || (await db.collection('users').doc(uid).get()).data().department, team: team || (await db.collection('users').doc(uid).get()).data().team };
    await db.collection('users').doc(uid).update(updateData);
    showToast('✅ Role updated!', 'success');
    if (window._sendRoleNotification) window._sendRoleNotification(uid, '', val, dept);
    adminPanelLoaded = false;
    loadAdminPanel();
};

// ═══════════════════════════════════════════════════════════
// 11. SUPER ADMIN — EDIT SADHANA
// ═══════════════════════════════════════════════════════════
let editModalUserId = null;
let editModalDate   = null;
let editModalOriginal = null;

window.openEditModal = async (userId, date) => {
    if (!isSuperAdmin()) return;

    editModalUserId = userId;
    editModalDate   = date;

    const docRef  = db.collection('users').doc(userId).collection('sadhana').doc(date);
    const docSnap = await docRef.get();

    // NR entries: docSnap may not exist — create a blank NR record to edit
    let d;
    if (!docSnap.exists) {
        // Check if it's an NR day (past day, no entry) — allow editing
        d = {
            sleepTime: '', wakeupTime: '', chantingTime: '',
            readingMinutes: 0, hearingMinutes: 0, serviceMinutes: 0,
            notesMinutes: 0, daySleepMinutes: 0, instrumentMinutes: 0,
            totalScore: -30, isNR: true
        };
    } else {
        d = docSnap.data();
    }
    editModalOriginal = { ...d };

    // Fetch user's level for scoring context
    const uSnap  = await db.collection('users').doc(userId).get();
    const uLevel = uSnap.exists ? (uSnap.data().level || 'Level-4') : 'Level-4';
    document.getElementById('edit-user-level').value = uLevel;

    // Build AM/PM time pickers (rebuild each time modal opens)
    buildTimePicker('edit-sleep-time-picker',    'edit-sleep-time',    updateEditPreview);
    buildTimePicker('edit-wakeup-time-picker',   'edit-wakeup-time',   updateEditPreview);
    buildTimePicker('edit-chanting-time-picker', 'edit-chanting-time', updateEditPreview);

    // Set time values (handles NR/empty gracefully)
    const slpVal = (d.sleepTime    && d.sleepTime    !== 'NR') ? d.sleepTime    : '';
    const wakVal = (d.wakeupTime   && d.wakeupTime   !== 'NR') ? d.wakeupTime   : '';
    const chnVal = (d.chantingTime && d.chantingTime !== 'NR') ? d.chantingTime : '';
    setTimePicker('edit-sleep-time-picker',    'edit-sleep-time',    slpVal);
    setTimePicker('edit-wakeup-time-picker',   'edit-wakeup-time',   wakVal);
    setTimePicker('edit-chanting-time-picker', 'edit-chanting-time', chnVal);

    // Populate other fields
    document.getElementById('edit-reading-mins').value   = d.readingMinutes  || 0;
    document.getElementById('edit-hearing-mins').value   = d.hearingMinutes  || 0;
    document.getElementById('edit-service-mins').value   = d.serviceMinutes  || 0;
    document.getElementById('edit-notes-mins').value     = d.notesMinutes    || 0;
    document.getElementById('edit-day-sleep-mins').value = d.daySleepMinutes || 0;
    document.getElementById('edit-reason').value         = '';

    // Title
    const uData = uSnap.exists ? uSnap.data() : {};
    const nrTag = (!docSnap.exists || d.sleepTime === 'NR') ? ' 🔴 NR' : '';
    document.getElementById('edit-modal-title').textContent = `✏️ Edit Sadhana — ${uData.name||userId} · ${date}${nrTag}`;

    // Show/hide notes field based on level
    document.getElementById('edit-notes-row').classList.toggle('hidden', uLevel !== 'Level-4');

    updateEditPreview();
    document.getElementById('edit-sadhana-modal').classList.remove('hidden');
};

window.closeEditModal = () => {
    document.getElementById('edit-sadhana-modal').classList.add('hidden');
    editModalUserId = editModalDate = editModalOriginal = null;
};

window.updateEditPreview = () => {
    const slp   = document.getElementById('edit-sleep-time').value;
    const wak   = document.getElementById('edit-wakeup-time').value;
    const chn   = document.getElementById('edit-chanting-time').value;
    const rMin  = parseInt(document.getElementById('edit-reading-mins').value)||0;
    const hMin  = parseInt(document.getElementById('edit-hearing-mins').value)||0;
    const sMin  = parseInt(document.getElementById('edit-service-mins').value)||0;
    const nMin  = parseInt(document.getElementById('edit-notes-mins').value)||0;
    const dsMin = parseInt(document.getElementById('edit-day-sleep-mins').value)||0;
    const level = document.getElementById('edit-user-level').value || 'Level-4';

    if (!slp || !wak || !chn) return;
    const { total, dayPercent } = calculateScores(slp, wak, chn, rMin, hMin, sMin, nMin, dsMin, level);
    const prev = document.getElementById('edit-score-preview');
    const editDMax = getDailyMax(level);
    prev.textContent = `New Score: ${total} / ${editDMax} (${dayPercent}%)`;
    prev.style.color = total < 0 ? '#dc2626' : total < 80 ? '#d97706' : '#16a34a';
};

window.submitEditSadhana = async () => {
    if (!isSuperAdmin() || !editModalUserId || !editModalDate) return;

    const slp   = document.getElementById('edit-sleep-time').value;
    const wak   = document.getElementById('edit-wakeup-time').value;
    const chn   = document.getElementById('edit-chanting-time').value;
    const rMin  = parseInt(document.getElementById('edit-reading-mins').value)||0;
    const hMin  = parseInt(document.getElementById('edit-hearing-mins').value)||0;
    const sMin  = parseInt(document.getElementById('edit-service-mins').value)||0;
    const nMin  = parseInt(document.getElementById('edit-notes-mins').value)||0;
    const dsMin = parseInt(document.getElementById('edit-day-sleep-mins').value)||0;
    const reason= document.getElementById('edit-reason').value.trim();
    const level = document.getElementById('edit-user-level').value || 'Level-4';

    if (!slp||!wak||!chn) { showToast('Please fill all three time fields', 'error'); return; }
    if (!confirm(`Save changes to ${editModalDate}?\nThis will update scores and log edit history.`)) return;

    const { sc, total, dayPercent } = calculateScores(slp, wak, chn, rMin, hMin, sMin, nMin, dsMin, level);

    const now = new Date().toISOString();
    const editLog = {
        editedBy:    userProfile.name,
        editedByUid: currentUser.uid,
        editedAt:    now,
        reason:      reason || 'No reason provided',
        original: {
            sleepTime:       editModalOriginal.sleepTime       || 'NR',
            wakeupTime:      editModalOriginal.wakeupTime      || 'NR',
            chantingTime:    editModalOriginal.chantingTime    || 'NR',
            readingMinutes:  editModalOriginal.readingMinutes  || 0,
            hearingMinutes:  editModalOriginal.hearingMinutes  || 0,
            serviceMinutes:  editModalOriginal.serviceMinutes  || 0,
            notesMinutes:    editModalOriginal.notesMinutes    || 0,
            daySleepMinutes: editModalOriginal.daySleepMinutes || 0,
            totalScore:      editModalOriginal.totalScore      || -30,
            dayPercent:      editModalOriginal.dayPercent      || 0
        }
    };

    try {
        const docRef = db.collection('users').doc(editModalUserId).collection('sadhana').doc(editModalDate);
        const docSnap = await docRef.get();

        const payload = {
            sleepTime:       slp,
            wakeupTime:      wak,
            chantingTime:    chn,
            readingMinutes:  rMin,
            hearingMinutes:  hMin,
            serviceMinutes:  sMin,
            notesMinutes:    nMin,
            daySleepMinutes: dsMin,
            scores:          sc,
            totalScore:      total,
            dayPercent:      dayPercent,
            editedAt:        firebase.firestore.FieldValue.serverTimestamp(),
            editedBy:        userProfile.name,
            editLog:         firebase.firestore.FieldValue.arrayUnion(editLog)
        };

        if (!docSnap.exists) {
            // NR entry — create new doc
            await docRef.set({
                ...payload,
                date: editModalDate,
                userId: editModalUserId,
                wasNR: true
            });
        } else {
            // Existing entry — update
            await docRef.update(payload);
        }

        closeEditModal();
        alert(`✅ Sadhana updated!\nNew Score: ${total} (${dayPercent}%)`);
        // Refresh admin panel so WCR table and performers ring reflect the edit
        adminPanelLoaded = false;
        _userWCRLoaded = false;
        loadAdminPanel();
    } catch (err) {
        console.error('Edit save error:', err);
        alert('❌ Save failed: ' + err.message);
    }
};

// Show edit history modal — full field-by-field comparison
window.showEditHistory = async (evt, date, userId) => {
    evt.stopPropagation();
    const docSnap = await db.collection('users').doc(userId).collection('sadhana').doc(date).get();
    if (!docSnap.exists) return;
    const cur = docSnap.data();
    const log = cur.editLog || [];

    if (log.length === 0) {
        alert('No edit history found.');
        return;
    }

    // Field definitions — label, key in original object, key in current doc
    const FIELDS = [
        { label: 'Bed Time',      oKey: 'sleepTime',       cKey: 'sleepTime'       },
        { label: 'Wake Up',       oKey: 'wakeupTime',      cKey: 'wakeupTime'      },
        { label: 'Chanting By',   oKey: 'chantingTime',    cKey: 'chantingTime'    },
        { label: 'Reading (min)', oKey: 'readingMinutes',  cKey: 'readingMinutes'  },
        { label: 'Hearing (min)', oKey: 'hearingMinutes',  cKey: 'hearingMinutes'  },
        { label: 'Service (min)', oKey: 'serviceMinutes',  cKey: 'serviceMinutes'  },
        { label: 'Notes (min)',   oKey: 'notesMinutes',    cKey: 'notesMinutes'    },
        { label: 'Day Sleep(min)',oKey: 'daySleepMinutes', cKey: 'daySleepMinutes' },
        { label: 'Total Score',   oKey: 'totalScore',      cKey: 'totalScore'      },
    ];

    let html = '';
    log.forEach((entry, i) => {
        // Parse timestamp
        let ts = 'Unknown time';
        if (entry.editedAt) {
            const d = typeof entry.editedAt === 'string'
                ? new Date(entry.editedAt)
                : entry.editedAt.toDate?.();
            if (d) ts = d.toLocaleString('en-IN', {
                day:'2-digit', month:'short', year:'numeric',
                hour:'2-digit', minute:'2-digit'
            });
        }

        html += `<div class="eh-entry">`;
        html += `<div class="eh-header">✏️ Edit ${i+1} &nbsp;|&nbsp; <span class="eh-who">${entry.editedBy||'Admin'}</span> &nbsp;|&nbsp; <span class="eh-when">${ts}</span></div>`;
        html += `<div class="eh-reason">📝 ${entry.reason || 'No reason provided'}</div>`;

        if (entry.original) {
            const o = entry.original;
            // Only show fields that actually changed
            const changedFields = FIELDS.filter(f => {
                const oval = o[f.oKey] ?? '—';
                const cval = cur[f.cKey] ?? '—';
                return String(oval) !== String(cval);
            });

            if (changedFields.length === 0) {
                html += `<div class="eh-nochange">No field changes detected in this edit.</div>`;
            } else {
                html += `<table class="eh-table"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>`;
                changedFields.forEach(f => {
                    let oval = o[f.oKey] ?? '—';
                    let cval = cur[f.cKey] ?? '—';
                    // Format time fields as AM/PM
                    if (['sleepTime','wakeupTime','chantingTime'].includes(f.oKey)) {
                        oval = fmt12(oval);
                        cval = fmt12(cval);
                    }
                    html += `<tr><td class="eh-field">${f.label}</td><td class="eh-before">${oval}</td><td class="eh-after">${cval}</td></tr>`;
                });
                html += `</tbody></table>`;
            }
        } else {
            html += `<div class="eh-nochange">Original data not recorded for this edit.</div>`;
        }
        html += `</div>`;
    });

    document.getElementById('edit-history-content').innerHTML = html;
    document.getElementById('edit-history-modal').classList.remove('hidden');
};

window.closeEditHistoryModal = () => {
    document.getElementById('edit-history-modal').classList.add('hidden');
};

// ═══════════════════════════════════════════════════════════
// DEVOTEE PROFILE MODAL  (View Profile button)
// ═══════════════════════════════════════════════════════════
let _devoteeProfileData = null;

window.openDevoteeProfile = async (userId, userName) => {
    const uSnap = await db.collection('users').doc(userId).get();
    if (!uSnap.exists) { showToast('User not found', 'error'); return; }
    const u = uSnap.data();
    _devoteeProfileData = { userId, userName, u };

    const initials = (u.name||userName).split(' ').map(n=>n[0]).join('').substring(0,2).toUpperCase();

    // Role badge
    const roleLbl = u.role==='superAdmin'        ? '👑 Super Admin'
        : u.role==='deptAdmin'         ? `🛡️ Dept Admin — ${u.department||''}`
        : u.role==='overallTeamLeader' ? `🌐 Overall TL — ${u.team||''}`
        : u.role==='teamLeader'        ? `👥 Team Leader — ${u.team||''} (${u.department||''})`
        : '👤 User';
    const roleColor = u.role==='superAdmin'?'#7e22ce':u.role==='deptAdmin'?'#1a5276':u.role==='overallTeamLeader'?'#0369a1':u.role==='teamLeader'?'#1e8449':'#374151';

    // Build role change dropdown options
    let roleOpts = '<option value="" disabled selected>Change Role…</option>';
    if (isSuperAdmin()) {
        if (u.role !== 'superAdmin') roleOpts += `<option value="superAdmin">👑 Make Super Admin</option>`;
        roleOpts += '<optgroup label="🛡️ Dept Admin">';
        ['IGF','IYF','ICF_MTG','ICF_PRJI'].forEach(dept =>
            roleOpts += `<option value="deptAdmin:${dept}">🛡️ ${dept}</option>`
        );
        roleOpts += '</optgroup>';
        const allTeams2 = [...new Set(Object.values(DEPT_TEAMS).flat().filter(t => t !== 'Other'))];
        allTeams2.push('Other');
        roleOpts += '<optgroup label="🌐 Overall Team Leader (all depts)">';
        allTeams2.forEach(team =>
            roleOpts += `<option value="overallTeamLeader:${team}">🌐 ${team} — All Depts</option>`
        );
        roleOpts += '</optgroup>';
        roleOpts += '<optgroup label="👥 Team Leader (dept-specific)">';
        ['IGF','IYF','ICF_MTG','ICF_PRJI'].forEach(dept => {
            if (DEPT_TEAMS[dept]) DEPT_TEAMS[dept].forEach(team =>
                roleOpts += `<option value="teamLeader:${dept}:${team}">👥 ${team} (${dept})</option>`
            );
        });
        roleOpts += '</optgroup>';
        roleOpts += '<option value="demote">🚫 Revoke to User</option>';
    } else if (isDeptAdmin() && u.department === userProfile.department && u.role !== 'superAdmin') {
        if (DEPT_TEAMS[userProfile.department]) DEPT_TEAMS[userProfile.department].forEach(team =>
            roleOpts += `<option value="teamLeader:${userProfile.department}:${team}">👥 TL — ${team}</option>`
        );
        roleOpts += '<option value="demote">🚫 Revoke to User</option>';
    }
    const canChangeRole = isSuperAdmin() || (isDeptAdmin() && u.department === userProfile.department && u.role !== 'superAdmin');
    const canDelete = isSuperAdmin();

    document.getElementById('dp-initials').textContent = initials;
    document.getElementById('dp-name').textContent = u.name || userName;
    document.getElementById('dp-role-lbl').textContent = roleLbl;
    document.getElementById('dp-role-lbl').style.color = roleColor;
    document.getElementById('dp-meta').textContent = `${u.department||'-'} · ${u.team||'-'} · ${u.chantingCategory||'N/A'} · ${u.exactRounds||'?'} rounds`;
    document.getElementById('dp-instrument').textContent = u.instrument || 'Not set';
    document.getElementById('dp-level').textContent = u.level || 'Level-1';

    // Role change section
    const roleSection = document.getElementById('dp-role-section');
    if (canChangeRole) {
        roleSection.classList.remove('hidden');
        document.getElementById('dp-role-select').innerHTML = roleOpts;
    } else {
        roleSection.classList.add('hidden');
    }

    // Delete button
    const delBtn = document.getElementById('dp-delete-btn');
    if (delBtn) delBtn.style.display = canDelete ? 'block' : 'none';

    document.getElementById('devotee-profile-modal').classList.remove('hidden');
};

window.closeDevoteeProfile = () => {
    document.getElementById('devotee-profile-modal').classList.add('hidden');
    _devoteeProfileData = null;
};

window.dpViewHistory = () => {
    if (!_devoteeProfileData) return;
    const { userId, userName } = _devoteeProfileData;
    closeDevoteeProfile();
    openUserModal(userId, userName);
};

window.dpDownloadExcel = () => {
    if (!_devoteeProfileData) return;
    downloadUserExcel(_devoteeProfileData.userId, _devoteeProfileData.userName);
};

window.dpViewProgress = () => {
    if (!_devoteeProfileData) return;
    const { userId, userName } = _devoteeProfileData;
    closeDevoteeProfile();
    openProgressModal(userId, userName);
};

window.dpChangeRole = async (sel) => {
    if (!_devoteeProfileData) return;
    const val = sel.value; sel.value = '';
    if (!val) return;
    const { userId, userName } = _devoteeProfileData;
    // Reuse existing handleRoleDropdown logic
    const fakeSel = { value: val };
    await handleRoleDropdown(userId, fakeSel);
    closeDevoteeProfile();
};

window.dpDeleteUser = async () => {
    if (!_devoteeProfileData || !isSuperAdmin()) return;
    const { userId, userName } = _devoteeProfileData;
    if (!confirm(`⚠️ DELETE "${userName}"?\n\nThis will permanently remove:\n• User document\n• All sadhana entries\n• All notifications\n\nThis CANNOT be undone!`)) return;
    const typed = prompt(`Type the user's name exactly to confirm:\n\n"${userName}"`);
    if (typed !== userName) { showToast('Name mismatch — deletion cancelled', 'error'); return; }
    try {
        showToast('Deleting user data…', 'info');
        // Delete sadhana subcollection in batches
        const sSnap = await db.collection('users').doc(userId).collection('sadhana').get();
        if (!sSnap.empty) {
            const batch = db.batch();
            sSnap.docs.forEach(d => batch.delete(d.ref));
            await batch.commit();
        }
        // Delete notifications subcollection
        const nSnap = await db.collection('users').doc(userId).collection('notifications').get();
        if (!nSnap.empty) {
            const batch2 = db.batch();
            nSnap.docs.forEach(d => batch2.delete(d.ref));
            await batch2.commit();
        }
        // Delete user doc
        await db.collection('users').doc(userId).delete();
        closeDevoteeProfile();
        showToast(`✅ "${userName}" deleted successfully`, 'success');
        adminPanelLoaded = false;
        loadAdminPanel();
    } catch (err) {
        console.error('Delete error:', err);
        showToast('❌ Delete failed: ' + err.message, 'error');
    }
};

// ─── REJECT / RESTORE entry (in-row button) ──────────────
window.toggleRejectEntry = async (userId, dateStr, isCurrentlyRejected) => {
    if (!isSuperAdmin()) return;

    if (isCurrentlyRejected) {
        // RESTORE
        if (!confirm(`✅ Restore entry for ${dateStr}?\n\nOriginal score will be reinstated.`)) return;
        try {
            const docSnap = await db.collection('users').doc(userId).collection('sadhana').doc(dateStr).get();
            const d = docSnap.data();
            await db.collection('users').doc(userId).collection('sadhana').doc(dateStr).update({
                rejected: false,
                totalScore: d.originalTotalScore ?? d.totalScore,
                dayPercent: d.originalDayPercent ?? d.dayPercent,
                bonusTotal: d.originalBonusTotal ?? d.bonusTotal ?? 0,
                revokedAt: firebase.firestore.FieldValue.serverTimestamp(),
                revokedBy: userProfile.name
            });
            showToast('✅ Entry restored!', 'success');
        } catch(err) { showToast('❌ ' + err.message, 'error'); }
    } else {
        // REJECT
        const reason = prompt(`🚫 Reject entry for ${dateStr}?\n\nEnter reason (required):`);
        if (!reason?.trim()) { showToast('Rejection cancelled — reason required', 'warn'); return; }
        if (!confirm(`Apply −50 penalty and reject this entry?\nReason: ${reason}`)) return;
        try {
            const docSnap = await db.collection('users').doc(userId).collection('sadhana').doc(dateStr).get();
            const d = docSnap.data();
            await db.collection('users').doc(userId).collection('sadhana').doc(dateStr).update({
                rejected: true,
                rejectedAt: firebase.firestore.FieldValue.serverTimestamp(),
                rejectedBy: userProfile.name,
                rejectionReason: reason.trim(),
                originalTotalScore: d.totalScore ?? 0,
                originalDayPercent: d.dayPercent ?? 0,
                originalBonusTotal: d.bonusTotal ?? 0,
                totalScore: -50,
                dayPercent: -31,
                bonusTotal: 0
            });
            showToast('🚫 Entry rejected!', 'success');
        } catch(err) { showToast('❌ ' + err.message, 'error'); }
    }
};

// ═══════════════════════════════════════════════════════════
// 12. DATE SELECT & PROFILE FORM
// ═══════════════════════════════════════════════════════════
function setupDateSelect() {
    const s = document.getElementById('sadhana-date');
    if (!s) return;
    s.innerHTML = '';
    for (let i=0;i<2;i++) {
        const ds = localDateStr(i);
        const opt = document.createElement('option');
        opt.value = ds;
        const parts = ds.split('-');
        opt.textContent = parts[2] + '/' + parts[1] + '/' + parts[0] + (i===0 ? ' (Today)' : ' (Yesterday)');
        s.appendChild(opt);
    }
    refreshFormFields();
}


function refreshFormFields() {
    if (!userProfile) return;
    const level  = userProfile.level || 'Level-1';
    const dept   = userProfile.department || '';
    const instrument = userProfile.instrument || 'Instrument';
    const isL34  = level==='Level-3'||level==='Level-4';
    const isL4   = level==='Level-4';

    // Notes Revision — L4 only
    const notesArea = document.getElementById('notes-area');
    if (notesArea) notesArea.classList.toggle('hidden', !isL4);

    // Instrument label — show instrument name from profile
    const instrLabel = document.getElementById('instrument-form-label');
    if (instrLabel) instrLabel.textContent = `🎵 ${instrument} — Minutes${isL34?' (Compulsory)':' (Bonus)'}`;

    // Sunday bonus — show only if today is Sunday
    const todayDay = new Date().getDay();
    const selectedDate = document.getElementById('sadhana-date')?.value;
    const selDay = selectedDate ? (() => { const [y,m,d] = selectedDate.split('-').map(Number); return new Date(y,m-1,d).getDay(); })() : -1;
    const isSunday = selDay === 0;
    const sundayArea = document.getElementById('sunday-bonus-area');
    if (sundayArea) sundayArea.classList.toggle('hidden', !isSunday);

    // Sunday dress fields based on dept
    if (isSunday) {
        const dress1Label = (dept==='IGF'||dept==='ICF_MTG') ? 'Gopi Dress' : 'Dhoti';
        const dress2Label = (dept==='IGF'||dept==='ICF_MTG') ? 'Blouse'     : 'Kurta';
        const noOpt = isL34
            ? '<option value="no">No (-5) ❌</option><option value="yes">Yes (+5) ✅</option>'
            : '<option value="yes">Yes (+5) ✅</option><option value="no">No (0)</option>';
        document.getElementById('dress-fields').innerHTML = `
            <label class="form-label">👗 ${dress1Label}</label>
            <select id="dress1-field">${noOpt}</select>
            <label class="form-label">👗 ${dress2Label}</label>
            <select id="dress2-field">${noOpt}</select>`;
        // Tilak/Mala options based on level
        const tilakMalaOpts = isL34
            ? '<option value="no">No (-5) ❌</option><option value="yes">Yes (+5) ✅</option>'
            : '<option value="yes">Yes (+5) ✅</option><option value="no">No (0)</option>';
        const tilakSel = document.getElementById('tilak-field');
        const malaSel  = document.getElementById('mala-field');
        if (tilakSel) tilakSel.innerHTML = tilakMalaOpts;
        if (malaSel)  malaSel.innerHTML  = tilakMalaOpts;
    }
}

// Re-check Sunday bonus when date changes
document.addEventListener('DOMContentLoaded', () => {
    const dateEl = document.getElementById('sadhana-date');
    if (dateEl) dateEl.addEventListener('change', () => {
        refreshFormFields();
        // Clear time pickers on date change
        setTimePicker('sleep-time-picker',    'sleep-time',    '');
        setTimePicker('wakeup-time-picker',   'wakeup-time',   '');
        setTimePicker('chanting-time-picker', 'chanting-time', '');
    });
});
document.getElementById('profile-form').onsubmit = async (e) => {
    e.preventDefault();
    const data = {
        name:             document.getElementById('profile-name').value.trim(),
        level:            userProfile?.level || 'Level-1',  // Level admin set karega, user nahi
        department:       document.getElementById('profile-dept').value,
        team:             document.getElementById('profile-team').value,
        chantingCategory: document.getElementById('profile-chanting').value,
        exactRounds:      document.getElementById('profile-exact-rounds').value,
        instrument:       document.getElementById('profile-instrument').value || '',
        role:             userProfile?.role || 'user'
    };
    if (window._profilePicDataUrl) data.photoURL = window._profilePicDataUrl;
    if (!data.name)       { alert('Please enter your name.'); return; }
    if (!data.department || !data.team) { alert('Please select Department and Team.'); return; }
    await db.collection('users').doc(currentUser.uid).set(data, { merge: true });
    alert('✅ Profile saved!');
    location.reload();
};

// ═══════════════════════════════════════════════════════════
// SHOW/HIDE PASSWORD TOGGLE
// ═══════════════════════════════════════════════════════════
window.togglePwd = (id, btn) => {
    const inp = document.getElementById(id);
    if (!inp) return;
    inp.type = inp.type === 'password' ? 'text' : 'password';
    btn.textContent = inp.type === 'password' ? '👁' : '🙈';
};

// ═══════════════════════════════════════════════════════════
// 13. PASSWORD MODAL
// ═══════════════════════════════════════════════════════════
window.openPasswordModal = () => {
    document.getElementById('pwd-new').value     = '';
    document.getElementById('pwd-confirm').value = '';
    document.getElementById('password-modal').classList.remove('hidden');
};

window.closePasswordModal = () => {
    document.getElementById('password-modal').classList.add('hidden');
};

window.submitPasswordChange = async () => {
    const newPwd  = document.getElementById('pwd-new').value.trim();
    const confPwd = document.getElementById('pwd-confirm').value.trim();
    if (!newPwd)           { alert('❌ Please enter a new password.'); return; }
    if (newPwd.length < 6) { alert('❌ Password must be at least 6 characters.'); return; }
    if (newPwd !== confPwd){ alert('❌ Passwords do not match!'); return; }
    if (!confirm('🔑 Confirm password change?')) return;
    try {
        await currentUser.updatePassword(newPwd);
        closePasswordModal();
        showToast('✅ Password changed successfully!', 'success');
    } catch (err) {
        if (err.code === 'auth/requires-recent-login') {
            // Prompt for current password to reauthenticate
            const currentPwd = prompt('For security, please enter your CURRENT password to confirm:');
            if (!currentPwd) return;
            try {
                const cred = firebase.auth.EmailAuthProvider.credential(currentUser.email, currentPwd);
                await currentUser.reauthenticateWithCredential(cred);
                await currentUser.updatePassword(newPwd);
                closePasswordModal();
                showToast('✅ Password changed successfully!', 'success');
            } catch (e) {
                alert('❌ Failed: ' + e.message);
            }
        } else {
            alert('❌ Failed: ' + err.message);
        }
    }
};

// ═══════════════════════════════════════════════════════════
// 14. MISC BINDINGS
// ═══════════════════════════════════════════════════════════
function friendlyAuthError(err) {
    const map = {
        'auth/invalid-email':           'The email address is not valid. Please check and try again.',
        'auth/user-disabled':           'This account has been disabled. Please contact your coordinator.',
        'auth/user-not-found':          'No account found with this email. Please check the email or sign up first.',
        'auth/wrong-password':          'Incorrect password. Please try again.',
        'auth/invalid-credential':      'Incorrect email or password. Please check and try again.',
        'auth/email-already-in-use':    'An account with this email already exists. Try logging in instead.',
        'auth/weak-password':           'Password is too weak. Please use at least 6 characters.',
        'auth/too-many-requests':       'Too many failed attempts. Please wait a few minutes and try again.',
        'auth/network-request-failed':  'No internet connection. Please check your network and try again.',
        'auth/requires-recent-login':   'For security, please log out and log back in before trying this.',
        'auth/operation-not-allowed':   'This sign-in method is not enabled. Please contact support.',
        'auth/invalid-action-code':     'This link has expired or already been used. Please request a new one.',
        'auth/expired-action-code':     'This link has expired. Please request a new password reset link.',
    };
    return map[err.code] || 'Something went wrong. Please try again later.';
}

// Clear login error when user types
['login-email','login-password'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => {
        const m = document.getElementById('login-msg');
        if (m) m.style.display = 'none';
    });
});

document.getElementById('login-form').onsubmit = (e) => {
    e.preventDefault();
    const btn = document.getElementById('login-btn');
    const msgEl = document.getElementById('login-msg');
    btn.disabled = true;
    btn.textContent = 'Logging in…';
    msgEl.style.display = 'none';
    auth.signInWithEmailAndPassword(
        document.getElementById('login-email').value.trim(),
        document.getElementById('login-password').value
    ).catch(err => {
        const txt = friendlyAuthError(err);
        msgEl.style.display = 'block';
        msgEl.style.background = '#ffebee';
        msgEl.style.color = '#dc2626';
        msgEl.textContent = '❌ ' + txt;
        btn.disabled = false;
        btn.textContent = 'Login';
    });
};

document.getElementById('logout-btn').onclick = () => auth.signOut();

window.openUserModal = (id, name) => {
    document.getElementById('user-report-modal').classList.remove('hidden');
    document.getElementById('modal-user-name').textContent = `📋 ${name} — History`;
    loadReports(id, 'modal-report-container');
};

window.closeUserModal = () => {
    document.getElementById('user-report-modal').classList.add('hidden');
    if (activeListener) { activeListener(); activeListener = null; }
};

window.openProfileEdit = () => {
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    const setTxt = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };

    setTxt('profile-title',    'Edit Profile');
    setTxt('profile-subtitle', 'Update your details');
    setVal('profile-name',     userProfile.name             || '');
    setVal('profile-chanting', userProfile.chantingCategory || '');
    setVal('profile-exact-rounds', userProfile.exactRounds  || '');

    const deptSel = document.getElementById('profile-dept');
    if (deptSel) deptSel.value = userProfile.department || '';
    populateDeptTeams('profile-team', userProfile.department || '', userProfile.team || '');
    populateInstrumentOptions(userProfile.level || 'Level-1');
    const instrSel = document.getElementById('profile-instrument');
    if (instrSel) instrSel.value = userProfile.instrument || '';

    // Populate profile picture preview
    window._profilePicDataUrl = null;
    const ppPreview = document.getElementById('profile-pic-preview');
    const ppInit    = document.getElementById('profile-pic-init');
    if (userProfile.photoURL) {
        if (ppPreview) { ppPreview.src = userProfile.photoURL; ppPreview.style.display = ''; }
        if (ppInit) ppInit.style.display = 'none';
    } else {
        if (ppPreview) ppPreview.style.display = 'none';
        if (ppInit) { ppInit.textContent = (userProfile.name||'?')[0].toUpperCase(); ppInit.style.display = ''; }
    }

    const cancelBtn = document.getElementById('cancel-edit');
    if (cancelBtn) cancelBtn.classList.remove('hidden');
    showSection('profile');
};

// ═══════════════════════════════════════════════════════════
// 15. FORGOT PASSWORD
// ═══════════════════════════════════════════════════════════
window.openForgotPassword = (e) => {
    e.preventDefault();
    const panel = document.getElementById('forgot-panel');
    const emailInput = document.getElementById('forgot-email');
    const msgEl = document.getElementById('forgot-msg');
    if (panel) {
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        if (panel.style.display === 'block') {
            emailInput.value = document.getElementById('login-email').value || '';
            msgEl.style.display = 'none';
            emailInput.focus();
        }
    }
};

window.closeForgotPanel = () => {
    const panel = document.getElementById('forgot-panel');
    if (panel) panel.style.display = 'none';
};

window.sendForgotEmail = async () => {
    const emailInput = document.getElementById('forgot-email');
    const btn = document.getElementById('forgot-send-btn');
    const msgEl = document.getElementById('forgot-msg');
    const email = emailInput.value.trim();
    if (!email) {
        msgEl.style.display = 'block';
        msgEl.style.background = '#ffebee'; msgEl.style.color = '#dc2626';
        msgEl.textContent = '❌ Please enter your email address.';
        return;
    }
    btn.disabled = true;
    btn.textContent = 'Sending…';
    msgEl.style.display = 'none';
    try {
        await auth.sendPasswordResetEmail(email);
        msgEl.style.display = 'block';
        msgEl.style.background = '#e8f5e9'; msgEl.style.color = '#059669';
        msgEl.innerHTML = `✅ Reset link sent to <b>${email}</b>!<br><small style="font-weight:400;">Check your inbox and spam folder.</small>`;
        btn.textContent = 'Sent ✓';
        setTimeout(() => {
            document.getElementById('forgot-panel').style.display = 'none';
            btn.disabled = false; btn.textContent = 'Send Reset Link';
        }, 3500);
    } catch (error) {
        msgEl.style.display = 'block';
        msgEl.style.background = '#ffebee'; msgEl.style.color = '#dc2626';
        msgEl.textContent = '❌ ' + friendlyAuthError(error);
        btn.disabled = false;
        btn.textContent = 'Send Reset Link';
    }
};


// ═══════════════════════════════════════════════════════════
// PWA — Service Worker Registration
// ═══════════════════════════════════════════════════════════
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => {
                console.log('SW registered:', reg.scope);
                window._swReg = reg;
            })
            .catch(err => console.log('SW registration failed:', err));
    });
}

// ── PWA Install Prompt ──
let _deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    _deferredInstallPrompt = e;
    const banner = document.getElementById('install-banner');
    if (banner && !localStorage.getItem('install-banner-dismissed')) {
        banner.classList.remove('hidden');
        banner.style.display = 'flex';
    }
});

window.installApp = async () => {
    if (!_deferredInstallPrompt) return;
    _deferredInstallPrompt.prompt();
    const { outcome } = await _deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') {
        const banner = document.getElementById('install-banner');
        if (banner) { banner.classList.add('hidden'); banner.style.display = 'none'; }
    }
    _deferredInstallPrompt = null;
};

window.dismissInstallBanner = () => {
    const banner = document.getElementById('install-banner');
    if (banner) { banner.classList.add('hidden'); banner.style.display = 'none'; }
    localStorage.setItem('install-banner-dismissed', '1');
};

// Auto-hide if already installed (standalone mode)
if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) {
    const banner = document.getElementById('install-banner');
    if (banner) { banner.classList.add('hidden'); banner.style.display = 'none'; }
}

// ═══════════════════════════════════════════════════════════
// NOTIFICATIONS SYSTEM
// ═══════════════════════════════════════════════════════════

// VAPID public key — replace with your actual key from Firebase Console
// For now using a placeholder — see setup instructions
const VAPID_PUBLIC_KEY = 'BBIaVXF1wlqwE_41UCqmXQpi89u0tIt5UUHjibouttw0b_BE-Xt7EmTaNaP8JY0wYH279aiWlUVSQ2w6zbr00Tc';

// Convert VAPID key to Uint8Array
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    return new Uint8Array([...rawData].map(c => c.charCodeAt(0)));
}

// ── Request notification permission ──
window.requestNotificationPermission = async () => {
    if (isAnyAdmin()) { showToast('Admins do not receive sadhana notifications.', 'warn'); return; }
    if (!('Notification' in window)) {
        alert('This browser does not support notifications.');
        return;
    }
    const perm = await Notification.requestPermission();
    const btn = document.getElementById('notif-bell-btn');
    if (perm === 'granted') {
        if (btn) { btn.classList.add('granted'); btn.title = 'Notifications enabled ✅'; }
        await saveNotificationToken();
        showToast('🔔 Notifications enabled!', 'success');
    } else {
        showToast('Notifications blocked. Please enable in browser settings.', 'warn');
    }
};

// ── Save FCM/Push token to Firestore ──
async function saveNotificationToken() {
    if (!currentUser) return;
    try {
        const reg = window._swReg || await navigator.serviceWorker.ready;
        if (!reg.pushManager) return;

        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
            if (VAPID_PUBLIC_KEY === 'BBIaVXF1wlqwE_41UCqmXQpi89u0tIt5UUHjibouttw0b_BE-Xt7EmTaNaP8JY0wYH279aiWlUVSQ2w6zbr00Tc') return; // not configured yet
            sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
            });
        }
        // Save subscription to Firestore under user doc
        await db.collection('users').doc(currentUser.uid).update({
            pushSubscription: JSON.stringify(sub),
            notifEnabled: true,
            notifUpdatedAt: new Date().toISOString()
        });
        console.log('Push subscription saved.');
    } catch (err) {
        console.warn('Push subscription failed:', err);
    }
}

// ── Show toast notification (in-app) ──
function showToast(msg, type = 'info') {
    const existing = document.getElementById('sadhana-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.id = 'sadhana-toast';
    const bg = type === 'success' ? '#16a34a' : type === 'warn' ? '#d97706' : type === 'error' ? '#dc2626' : '#1A3C5E';
    toast.style.cssText = `
        position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
        background:${bg}; color:white; padding:12px 22px; border-radius:12px;
        font-size:14px; font-weight:600; z-index:9999; box-shadow:0 4px 16px rgba(0,0,0,0.2);
        max-width:90vw; text-align:center; transition:opacity 0.4s;
    `;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 400); }, 3500);
}

// ── In-app notification sender (for admin actions) ──
// Called after admin does role changes, promotions etc.
async function sendInAppNotification(userId, title, body) {
    try {
        await db.collection('notifications').add({
            userId,
            title,
            body,
            read: false,
            createdAt: new Date().toISOString()
        });
    } catch (err) {
        console.warn('Notification save failed:', err);
    }
}

// ── Check unread notifications for current user ──
async function loadUserNotifications() {
    if (!currentUser) return;
    try {
        const snap = await db.collection('notifications')
            .where('userId', '==', currentUser.uid)
            .where('read', '==', false)
            .orderBy('createdAt', 'desc')
            .limit(10)
            .get();

        const count = snap.docs.length;
        // Update sidebar badge
        const badge = document.getElementById('sidebar-notif-badge');
        if (badge) {
            if (count > 0) { badge.textContent = count; badge.classList.remove('hidden'); }
            else { badge.classList.add('hidden'); }
        }

        if (count > 0) {
            // Show latest notification as toast
            const latest = snap.docs[0].data();
            showToast(`${latest.title}: ${latest.body}`, 'info');
            // Mark all as read
            snap.docs.forEach(d => d.ref.update({ read: true }));
        }
    } catch (err) {
        // notifications collection may not exist yet — silent fail
    }
}

// ── Sadhana fill reminder check (runs on dashboard load) ──
async function checkSadhanaReminder() {
    if (!currentUser) return;
    try {
        const today = localDateStr(0);
        const yesterday = localDateStr(1);
        const dayBefore = localDateStr(2);

        const snap = await db.collection('users').doc(currentUser.uid)
            .collection('sadhana')
            .where(firebase.firestore.FieldPath.documentId(), 'in', [today, yesterday, dayBefore])
            .get();

        const submitted = new Set(snap.docs.map(d => d.id));
        const missedDays = [yesterday, dayBefore].filter(d => !submitted.has(d) && d >= APP_START);

        if (missedDays.length >= 2 && Notification.permission === 'granted') {
            new Notification('🙏 Sadhana Reminder', {
                body: `You haven't filled Sadhana for ${missedDays.length} days. Please submit now.`,
                icon: ''
            });
        }

        if (missedDays.length >= 2) {
            showToast(`⚠️ Sadhana pending for ${missedDays.length} days — please fill now!`, 'warn');
        }
    } catch (err) {
        console.warn('Reminder check failed:', err);
    }
}

// ── Hook into admin role change — send notification ──
// Called after handleRoleDropdown updates Firestore
window._sendRoleNotification = async (userId, userName, newRole, category) => {
    let msg = '';
    if (newRole === 'superAdmin') msg = 'You have been promoted to Super Admin!';
    else if (newRole === 'admin' && category) msg = `You have been made Admin — ${category.replace(' Coordinator','')}`;
    else if (newRole === 'user') msg = 'Your admin role has been updated.';
    else if (newRole === 'sb') msg = 'You have been moved to Senior Batch (Level-4).'; // legacy

    if (msg) await sendInAppNotification(userId, '👑 Role Update', msg);
};

// ── Init notifications on dashboard load ──
window._initNotifications = () => {
    loadUserNotifications();
    checkSadhanaReminder();
    // (adminBtn removed — bottom nav handles admin visibility)
};

// USER SIDEBAR
window.openUserSidebar = () => {
    document.getElementById('user-sidebar').classList.add('open');
    document.getElementById('sidebar-overlay').classList.add('open');
    document.body.style.overflow = 'hidden';
    if (typeof userProfile !== 'undefined' && userProfile) {
        const n = document.getElementById('sidebar-user-name');
        const r = document.getElementById('sidebar-user-role');
        if (n) n.textContent = userProfile.name || '';
        if (r) r.textContent = userProfile.role === 'superAdmin' ? '👑 Super Admin'
            : userProfile.role === 'deptAdmin' ? `🛡️ Dept Admin — ${userProfile.department||''}`
            : userProfile.role === 'teamLeader' ? `👥 Team Leader — ${userProfile.team||''}`
            : `${userProfile.level||'Level-1'} | ${userProfile.department||''} | ${userProfile.team||''}`;
    }
    const bellIcon = document.getElementById('sidebar-bell-icon');
    const bellLabel = document.getElementById('sidebar-bell-label');
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        if (bellIcon) bellIcon.textContent = '✅';
        if (bellLabel) bellLabel.textContent = 'Notifications Enabled';
    }
};
window.closeUserSidebar = () => {
    document.getElementById('user-sidebar').classList.remove('open');
    document.getElementById('sidebar-overlay').classList.remove('open');
    document.body.style.overflow = '';
};
// openUserGuide is defined inline in index.html (handles level-based tab jumping)
window.openAbout = () => { document.getElementById('about-modal').classList.remove('hidden'); };
window.closeNotificationsPanel = () => { document.getElementById('notifications-modal').classList.add('hidden'); };
window.openNotificationsPanel = async () => {
    document.getElementById('notifications-modal').classList.remove('hidden');
    if (!currentUser) return;
    try {
        const snap = await db.collection('notifications').where('userId','==',currentUser.uid).orderBy('createdAt','desc').limit(20).get();
        const list = document.getElementById('notifications-list');
        if (!list) return;
        if (snap.empty) { list.innerHTML = '<p style="color:gray;text-align:center;padding:20px 0;font-size:13px;">No notifications yet</p>'; return; }
        list.innerHTML = snap.docs.map(d => { const n=d.data(); const u=!n.read; return '<div style="padding:10px 12px;border-radius:8px;margin-bottom:6px;background:'+(u?'#eff6ff':'#f9fafb')+';border-left:3px solid '+(u?'#3b82f6':'#e5e7eb')+';"><div style="font-weight:600;font-size:13px;">'+( n.title||'')+'</div><div style="font-size:12px;color:#555;margin-top:2px;">'+(n.body||'')+'</div><div style="font-size:10px;color:gray;margin-top:4px;">'+(n.createdAt||'').slice(0,10)+'</div></div>'; }).join('');
        snap.docs.forEach(d => { if (!d.data().read) d.ref.update({read:true}); });
        const badge = document.getElementById('sidebar-notif-badge');
        if (badge) badge.classList.add('hidden');
    } catch(e) { console.warn(e); }
};

// ═══════════════════════════════════════════════════════════
// PROFILE PICTURE
// ═══════════════════════════════════════════════════════════
window._profilePicDataUrl = null;

window.handleProfilePicSelect = (input) => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const MAX = 200;
            let w = img.width, h = img.height;
            if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
            else       { w = Math.round(w * MAX / h); h = MAX; }
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
            window._profilePicDataUrl = dataUrl;
            const preview = document.getElementById('profile-pic-preview');
            const init    = document.getElementById('profile-pic-init');
            if (preview) { preview.src = dataUrl; preview.style.display = ''; }
            if (init) init.style.display = 'none';
        };
        img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
};

function updateAvatarDisplay(photoURL, name) {
    const initial = (name || '?').split(' ').map(n=>n[0]).join('').substring(0,2).toUpperCase();
    const pairs = [
        ['header-av-img', 'header-av-init'],
        ['sidebar-av-img', 'sidebar-av-init'],
    ];
    pairs.forEach(([imgId, initId]) => {
        const img  = document.getElementById(imgId);
        const init = document.getElementById(initId);
        if (!img || !init) return;
        if (photoURL) {
            img.src = photoURL; img.style.display = '';
            init.style.display = 'none';
        } else {
            img.style.display  = 'none';
            init.textContent   = initial;
            init.style.display = '';
        }
    });
}

function avatarHtml(photoURL, name, size) {
    const sz = size || 32;
    const initial = (name || '?').split(' ').map(n=>n[0]).join('').substring(0,2).toUpperCase();
    if (photoURL) {
        return `<div class="av" style="width:${sz}px;height:${sz}px;"><img src="${photoURL}"></div>`;
    }
    return `<div class="av" style="width:${sz}px;height:${sz}px;"><span class="av-init" style="font-size:${Math.round(sz*0.38)}px;">${initial}</span></div>`;
}

// ═══════════════════════════════════════════════════════════
// USER ACTION BOTTOM SHEET (UAC)
// ═══════════════════════════════════════════════════════════
let _uacUID = null, _uacName = null;

window.openUAC = (uid, name, level, chanting, rounds, role, dept, team) => {
    _uacUID  = uid;
    _uacName = name;
    document.getElementById('uac-name').textContent = name;
    document.getElementById('uac-sub').textContent  = `${level||''} · ${dept||''} · ${team||''} · ${chanting||''} · ${rounds||'?'} rounds`;

    // Level change: superAdmin or deptAdmin in same dept
    const levelWrap = document.getElementById('uac-level-wrap');
    const levelSel  = document.getElementById('uac-level-sel');
    if (levelWrap && levelSel) {
        if (isSuperAdmin() || (isDeptAdmin() && dept === userProfile.department)) {
            levelSel.value = level || '';
            levelWrap.style.display = '';
        } else {
            levelWrap.style.display = 'none';
        }
    }

    // Role change: admin-only
    const roleWrap = document.getElementById('uac-role-wrap');
    if (isSuperAdmin() || (isDeptAdmin() && dept === userProfile.department)) {
        let opts = '<option value="" disabled selected>Change Role…</option>';
        if (isSuperAdmin()) {
            if (role !== 'superAdmin') opts += '<option value="superAdmin">👑 Make Super Admin</option>';
            ['IGF','IYF','ICF_MTG','ICF_PRJI'].forEach(d => {
                opts += `<option value="deptAdmin:${d}">🛡️ Dept Admin — ${d}</option>`;
                if (DEPT_TEAMS[d]) DEPT_TEAMS[d].filter(t=>t!=='Other').forEach(t =>
                    opts += `<option value="teamLeader:${d}:${t}">👥 TL — ${t} (${d})</option>`
                );
            });
            if (role !== 'user') opts += '<option value="demote">🚫 Revoke to User</option>';
        } else if (isDeptAdmin()) {
            if (DEPT_TEAMS[userProfile.department]) DEPT_TEAMS[userProfile.department].filter(t=>t!=='Other').forEach(t =>
                opts += `<option value="teamLeader:${userProfile.department}:${t}">👥 TL — ${t}</option>`
            );
            if (role !== 'user') opts += '<option value="demote">🚫 Revoke to User</option>';
        }
        document.getElementById('uac-role-sel').innerHTML = opts;
        roleWrap.style.display = '';
    } else {
        roleWrap.style.display = 'none';
    }

    // Remove button: superAdmin only
    const removeBtn = document.getElementById('uac-remove-btn');
    if (removeBtn) removeBtn.style.display = isSuperAdmin() ? '' : 'none';

    // Activity Analysis: admins only
    const actWrap = document.getElementById('uac-activity-wrap');
    if (actWrap) actWrap.style.display = isAnyAdmin() ? '' : 'none';

    document.getElementById('uac-sheet').classList.add('open');
    document.getElementById('uac-overlay').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
};

window.closeUAC = () => {
    document.getElementById('uac-sheet').classList.remove('open');
    document.getElementById('uac-overlay').classList.add('hidden');
    document.body.style.overflow = '';
};

window.uacHistory  = () => { closeUAC(); openUserModal(_uacUID, _uacName); };
window.uacExcel    = () => { closeUAC(); downloadUserExcel(_uacUID, _uacName); };
window.uacProgress = () => { closeUAC(); openProgressModal(_uacUID, _uacName); };

window.openWCRUser = (idx) => {
    const u = (window._wcrUserList || [])[idx];
    if (!u) return;
    openUAC(u.uid, u.name, u.level, u.chanting, u.rounds, u.role, u.dept, u.team);
};

window.openAdminCmpUser = (idx) => {
    const u = (window._adminCmpUserList || [])[idx];
    if (!u) return;
    openUAC(u.uid, u.name, u.level, u.chanting, u.rounds, u.role, u.dept, u.team);
};

window.uacRoleChange = async (sel) => {
    const val = sel.value; if (!val) return;
    const parts = val.split(':');
    try {
        if (val === 'superAdmin') {
            if (!confirm(`Make ${_uacName} a Super Admin?`)) { sel.value=''; return; }
            await db.collection('users').doc(_uacUID).update({ role: 'superAdmin' });
        } else if (val === 'demote') {
            if (!confirm(`Revoke admin role for ${_uacName}?`)) { sel.value=''; return; }
            await db.collection('users').doc(_uacUID).update({ role: 'user' });
        } else if (parts[0] === 'deptAdmin') {
            if (!confirm(`Make ${_uacName} Dept Admin of ${parts[1]}?`)) { sel.value=''; return; }
            await db.collection('users').doc(_uacUID).update({ role: 'deptAdmin', department: parts[1] });
        } else if (parts[0] === 'teamLeader') {
            if (!confirm(`Make ${_uacName} Team Leader of ${parts[2]} (${parts[1]})?`)) { sel.value=''; return; }
            await db.collection('users').doc(_uacUID).update({ role: 'teamLeader', department: parts[1], team: parts[2] });
        }
        showToast('✅ Role updated!', 'success');
        sel.value = '';
        closeUAC();
        adminPanelLoaded = false;
        _userWCRLoaded = false;
    } catch(e) {
        alert('Error: ' + e.message);
    }
};

window.uacLevelChange = async (sel) => {
    const newLevel = sel.value; if (!newLevel) return;
    if (!confirm(`Change ${_uacName}'s level to ${newLevel}?`)) { sel.value = ''; return; }
    try {
        await db.collection('users').doc(_uacUID).update({ level: newLevel });
        showToast(`✅ Level changed to ${newLevel}!`, 'success');
        closeUAC();
        adminPanelLoaded = false;
        _userWCRLoaded = false;
    } catch(e) {
        alert('Error: ' + e.message);
    }
};

window.uacRemove = async () => {
    if (!isSuperAdmin()) return;
    const typed = prompt(`Type "${_uacName}" to confirm deletion:`);
    if (typed !== _uacName) { alert('Name did not match. Cancelled.'); return; }
    try {
        await db.collection('users').doc(_uacUID).delete();
        showToast('✅ User removed.', 'success');
        closeUAC();
        adminPanelLoaded = false;
        _userWCRLoaded = false;
    } catch(e) { alert('Error: ' + e.message); }
};

// ═══════════════════════════════════════════════════════════
// ACTIVITY ANALYSIS
// ═══════════════════════════════════════════════════════════
let _aaUID = null, _aaName = null, _aaTab = 'current-week';
let _aaChartDonut = null, _aaChartBar = null;

window.uacActivity = () => {
    const uid = _uacUID, name = _uacName;
    closeUAC();
    openActivityAnalysis(uid, name);
};

window.openActivityAnalysis = (uid, name) => {
    _aaUID = uid; _aaName = name; _aaTab = 'current-week';
    document.getElementById('aa-user-name').textContent = name;
    document.getElementById('aa-modal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    document.querySelectorAll('.aa-tab-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
    renderActivityAnalysis(uid, 'current-week');
};

window.closeActivityModal = () => {
    document.getElementById('aa-modal').classList.add('hidden');
    document.body.style.overflow = '';
    if (_aaChartDonut) { try { _aaChartDonut.destroy(); } catch(e){} _aaChartDonut = null; }
    if (_aaChartBar)   { try { _aaChartBar.destroy();   } catch(e){} _aaChartBar   = null; }
};

window.setAATab = (tab, btn) => {
    _aaTab = tab;
    document.querySelectorAll('.aa-tab-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderActivityAnalysis(_aaUID, tab);
};

function getActivityConfig(level) {
    const isL4  = level === 'Level-4';
    const isL3  = level === 'Level-3';
    const isL12 = level === 'Level-1' || level === 'Level-2';

    const actKeys = ['sleep','wakeup','chanting','reading','hearing'];
    if (isL3 || isL4) actKeys.push('instrument');
    if (isL4) actKeys.push('notes');
    actKeys.push('daySleep');

    const actLabels = {
        sleep:'Sleep', wakeup:'Wake-up', chanting:'Chanting',
        reading:'Reading', hearing:'Hearing', instrument:'Instrument',
        notes:'Notes', daySleep:'Day Sleep'
    };

    const actMax = {
        sleep:25, wakeup:25, chanting:25, daySleep:10,
        reading:  isL12 ? 20 : 25,
        hearing:  isL12 ? 20 : 25,
        instrument: (isL3 || isL4) ? 5 : 0,
        notes: isL4 ? 20 : 0
    };

    return { actKeys, actLabels, actMax, dailyMax: getDailyMax(level) };
}

async function renderActivityAnalysis(uid, period) {
    const statusEl  = document.getElementById('aa-status');
    const donutWrap = document.getElementById('aa-donut-wrap');
    const barWrap   = document.getElementById('aa-bar-wrap');
    statusEl.textContent = 'Loading…';
    if (donutWrap) donutWrap.style.opacity = '0.3';
    if (barWrap)   barWrap.style.opacity   = '0.3';

    if (_aaChartDonut) { try { _aaChartDonut.destroy(); } catch(e){} _aaChartDonut = null; }
    if (_aaChartBar)   { try { _aaChartBar.destroy();   } catch(e){} _aaChartBar   = null; }

    try {
        const weekOffset = period === 'prev-week' ? 1 : 0;
        const { dates, weekStart, weekEnd } = getWeekDates(weekOffset);
        const startStr = dates[0], endStr = dates[dates.length - 1];

        const [saSnap, userSnap] = await Promise.all([
            db.collection('users').doc(uid).collection('sadhana')
                .where(firebase.firestore.FieldPath.documentId(), '>=', startStr)
                .where(firebase.firestore.FieldPath.documentId(), '<=', endStr)
                .get(),
            db.collection('users').doc(uid).get()
        ]);

        const level = userSnap.data()?.level || 'Level-1';
        const { actKeys, actLabels, actMax, dailyMax } = getActivityConfig(level);

        const validDocs = saSnap.docs.filter(d => {
            const data = d.data();
            return data.sleepTime && data.sleepTime !== 'NR';
        });

        if (validDocs.length === 0) {
            statusEl.textContent = 'No entries found for this period.';
            if (donutWrap) donutWrap.style.opacity = '1';
            if (barWrap)   barWrap.style.opacity   = '1';
            return;
        }
        statusEl.textContent = '';

        const totals = {};
        actKeys.forEach(k => totals[k] = 0);
        validDocs.forEach(d => {
            const scores = d.data().scores || {};
            actKeys.forEach(k => { totals[k] += (scores[k] ?? 0); });
        });

        const n = validDocs.length;
        const totalSvcMins = validDocs.reduce((s, d) => s + (d.data().serviceMinutes||0), 0);
        const totalScore = validDocs.reduce((sum, d) => sum + (d.data().totalScore ?? 0) + (d.data().bonusTotal ?? 0), 0) + calcServiceWeekly(totalSvcMins, level);
        const weekPct = Math.round(totalScore * 100 / (n * dailyMax));
        const weekScores = {};
        actKeys.forEach(k => { weekScores[k] = Math.round(totals[k] * 10) / 10; });

        const fmtD = d => d.toLocaleDateString('en-IN', { day:'numeric', month:'short' });
        document.getElementById('aa-period-label').textContent =
            `${fmtD(weekStart)} – ${fmtD(weekEnd)} · ${n} day${n>1?'s':''} · ${totalScore} pts`;

        if (donutWrap) donutWrap.style.opacity = '1';
        if (barWrap)   barWrap.style.opacity   = '1';

        // Donut chart
        const donutColor = weekPct >= 70 ? '#16a34a' : weekPct >= 50 ? '#d97706' : '#dc2626';
        const donutCanvas = document.getElementById('aa-donut-canvas');
        _aaChartDonut = new Chart(donutCanvas.getContext('2d'), {
            type: 'doughnut',
            data: { datasets: [{ data: [weekPct, Math.max(0, 100 - weekPct)], backgroundColor: [donutColor, '#e5e7eb'], borderWidth: 0 }] },
            options: { cutout: '74%', responsive: true, maintainAspectRatio: true, plugins: { legend: { display: false }, tooltip: { enabled: false } }, animation: { duration: 500 } },
            plugins: [{
                id: 'centerText',
                afterDraw(chart) {
                    const { ctx, chartArea: { left, top, width, height } } = chart;
                    const cx = left + width / 2, cy = top + height / 2;
                    ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                    ctx.font = `bold ${Math.round(width * 0.2)}px Segoe UI`;
                    ctx.fillStyle = donutColor;
                    ctx.fillText(weekPct + '%', cx, cy - 7);
                    ctx.font = `${Math.round(width * 0.1)}px Segoe UI`;
                    ctx.fillStyle = '#6b7280';
                    ctx.fillText('week score', cx, cy + 12);
                    ctx.restore();
                }
            }]
        });

        // Horizontal bar chart
        const barColors = actKeys.map(k => {
            const maxK = actMax[k] * n;
            const pct = maxK > 0 ? (weekScores[k] / maxK) * 100 : 0;
            return pct >= 75 ? '#16a34a' : pct >= 50 ? '#f59e0b' : '#ef4444';
        });

        const barCanvas = document.getElementById('aa-bar-canvas');
        _aaChartBar = new Chart(barCanvas.getContext('2d'), {
            type: 'bar',
            data: {
                labels: actKeys.map(k => actLabels[k]),
                datasets: [{ data: actKeys.map(k => weekScores[k]), backgroundColor: barColors, borderRadius: 4, barThickness: 14 }]
            },
            options: {
                indexAxis: 'y', responsive: true, maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: ctx => {
                                const k = actKeys[ctx.dataIndex];
                                const maxK = actMax[k] * n;
                                const pctStr = maxK > 0 ? ` (${Math.round(weekScores[k]*100/maxK)}%)` : '';
                                return ` ${weekScores[k]} / ${maxK} pts${pctStr}`;
                            }
                        }
                    }
                },
                scales: {
                    x: { min: Math.floor(-5 * n), max: Math.ceil(25 * n), grid: { color: '#f3f4f6' }, ticks: { font: { size: 10 } } },
                    y: { ticks: { font: { size: 11 } } }
                }
            }
        });

    } catch (e) {
        statusEl.textContent = 'Error loading data.';
        console.error('Activity Analysis error:', e);
    }
}

// ═══════════════════════════════════════════════════════════
// BOTTOM NAVIGATION
// ═══════════════════════════════════════════════════════════
function initBottomNav() {
    const userNav  = document.getElementById('user-bottom-nav');
    const adminNav = document.getElementById('admin-bottom-nav');
    if (isAnyAdmin()) {
        if (adminNav) adminNav.classList.add('visible');
        if (userNav)  userNav.classList.remove('visible');
    } else {
        if (userNav)  userNav.classList.add('visible');
        if (adminNav) adminNav.classList.remove('visible');
    }
    document.body.classList.add('has-bottom-nav');
}

window.bnavSwitch = (tab, btn) => {
    document.querySelectorAll('#user-bottom-nav .bnav-item').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    switchTab(tab);
};

window.bnavAdminSwitch = (tab, btn) => {
    document.querySelectorAll('#admin-bottom-nav .bnav-item').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    switchTab(tab);
};

// ═══════════════════════════════════════════════════════════
// HOME PANEL
// ═══════════════════════════════════════════════════════════
function drawRing(canvas, pct, color) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height, cx = w/2, cy = h/2, r = Math.min(w,h)/2 - 8;
    ctx.clearRect(0,0,w,h);
    ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.strokeStyle='#e2e8f0'; ctx.lineWidth=10; ctx.stroke();
    if (pct > 0) {
        ctx.beginPath(); ctx.arc(cx,cy,r,-Math.PI/2,-Math.PI/2+(Math.min(pct,100)/100)*Math.PI*2);
        ctx.strokeStyle=color; ctx.lineWidth=10; ctx.lineCap='round'; ctx.stroke();
    }
}

function animateRing(canvas, targetPct, color) {
    const start = performance.now();
    const duration = 900;
    function frame(now) {
        const p = Math.min((now - start) / duration, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        drawRing(canvas, targetPct * eased, color);
        if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
}

async function loadHomePanel(weekOffset) {
    const level = userProfile?.level || 'Level-1';
    const dailyMax = getDailyMax(level);
    const { actKeys, actLabels, actMax } = getActivityConfig(level);
    const { dates, weekStart, weekEnd } = getWeekDates(weekOffset);
    const todayStr = localDateStr(0);

    // Fetch sadhana entries for this week
    const startStr = dates[0], endStr = dates[dates.length-1];
    let saSnap;
    try {
        saSnap = await db.collection('users').doc(currentUser.uid).collection('sadhana')
            .where(firebase.firestore.FieldPath.documentId(), '>=', startStr)
            .where(firebase.firestore.FieldPath.documentId(), '<=', endStr).get();
    } catch(e) { console.warn('Home panel error:', e); return; }

    const filledSet = new Set();
    const entryMap = new Map();
    saSnap.docs.forEach(d => {
        const data = d.data();
        if (data.sleepTime && data.sleepTime !== 'NR') {
            filledSet.add(d.id);
            entryMap.set(d.id, data);
        }
    });

    // Count ALL eligible days — apply NR penalty for missed ones
    const joinedDate = userProfile?.joinedDate || APP_START;
    let totalScore = 0, totalDays = 0, filledDays = 0, svcMinsWeek = 0;
    const actTotals = {};
    actKeys.forEach(k => actTotals[k] = 0);

    dates.forEach(ds => {
        if (ds < APP_START || ds < joinedDate || ds > todayStr) return;
        if (ds === todayStr && !filledSet.has(ds)) return; // today not filled yet — skip, don't penalize
        totalDays++;
        if (filledSet.has(ds)) {
            const data = entryMap.get(ds);
            totalScore += (data.totalScore || 0) + (data.bonusTotal || 0);
            svcMinsWeek += data.serviceMinutes || 0;
            filledDays++;
            const sc = data.scores || {};
            actKeys.forEach(k => { actTotals[k] += (sc[k] ?? 0); });
        } else {
            totalScore += -30; // NR penalty
        }
    });
    totalScore += calcServiceWeekly(svcMinsWeek, level);

    const weekPct = totalDays > 0 ? Math.round(totalScore * 100 / (totalDays * dailyMax + 25)) : 0;

    // Ring chart with animation
    const ringColor = weekPct >= 70 ? '#16a34a' : weekPct >= 50 ? '#d97706' : '#dc2626';
    const canvas = document.getElementById('home-ring-canvas');
    if (canvas) animateRing(canvas, weekPct, ringColor);
    const pctEl = document.getElementById('home-ring-pct');
    if (pctEl) pctEl.innerHTML = `<span style="font-size:24px;font-weight:800;color:${ringColor};">${weekPct}%</span><span style="font-size:10px;color:#6b7280;">week score</span>`;

    // Stats
    const ptsEl = document.getElementById('home-week-pts');
    const daysEl = document.getElementById('home-days-count');
    if (ptsEl) ptsEl.textContent = totalScore;
    if (daysEl) daysEl.textContent = filledDays + '/' + totalDays;

    // Streak
    let streak = 0;
    const checkDates = [...dates].reverse();
    for (const ds of checkDates) {
        if (ds > todayStr) continue;
        if (filledSet.has(ds)) streak++; else break;
    }
    const streakEl = document.getElementById('home-streak-count');
    if (streakEl) streakEl.textContent = streak;

    // Streak dots with staggered animation
    const dotsEl = document.getElementById('home-streak-dots');
    if (dotsEl) {
        const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        dotsEl.innerHTML = dates.map((ds, i) => {
            const [_dy,_dm,_dd] = ds.split('-').map(Number); const dow = new Date(_dy,_dm-1,_dd).getDay();
            const cls = filledSet.has(ds) ? 'filled' : (ds < todayStr ? 'missed' : (ds === todayStr ? 'today' : ''));
            return `<div class="streak-day-wrap" style="animation-delay:${i*50}ms;">
                <div class="streak-dot ${cls}"></div>
                <span class="streak-dot-label">${dayNames[dow]}</span>
            </div>`;
        }).join('');
    }

    // Fill alert
    const alertEl = document.getElementById('home-fill-alert');
    if (alertEl) {
        if (weekOffset === 0 && !filledSet.has(todayStr)) alertEl.classList.remove('hidden');
        else alertEl.classList.add('hidden');
    }

    // Activity bars
    const barsEl = document.getElementById('home-activity-bars');
    if (barsEl && filledDays > 0) {
        barsEl.innerHTML = actKeys.filter(k => actMax[k] > 0).map(k => {
            const maxK = actMax[k] * filledDays;
            const pct = maxK > 0 ? Math.round(actTotals[k] * 100 / maxK) : 0;
            const color = pct >= 75 ? '#16a34a' : pct >= 50 ? '#f59e0b' : '#ef4444';
            return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                <span style="font-size:11px;width:60px;color:#6b7280;text-align:right;">${actLabels[k]}</span>
                <div class="home-act-bar"><div class="home-act-fill" style="width:${pct}%;background:${color};"></div></div>
                <span style="font-size:11px;font-weight:600;color:${color};width:32px;">${pct}%</span>
            </div>`;
        }).join('');
    } else if (barsEl) {
        barsEl.innerHTML = '<p style="color:#aaa;text-align:center;font-size:12px;">No data for this period</p>';
    }
}

// ═══════════════════════════════════════════════════════════
// LEADERBOARD
// ═══════════════════════════════════════════════════════════
let _lbLoading = false, _lbMode = 'weekly';

window.setLBMode = (mode, btn) => {
    _lbMode = mode;
    document.querySelectorAll('#lb-mode-tabs .chart-tab-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    loadLeaderboard(true);
};

async function loadLeaderboard(force) {
    if (_lbLoading && !force) return;
    _lbLoading = true;
    const container = document.getElementById('leaderboard-container');
    const podiumEl  = document.getElementById('lb-podium');
    if (!container) { _lbLoading = false; return; }
    container.innerHTML = '<p style="color:#aaa;text-align:center;padding:20px;">Loading…</p>';

    try {
        const usersSnap = await db.collection('users').get();
        const filtered = usersSnap.docs.filter(doc => {
            const d = doc.data();
            // Exclude all admins — only regular users in leaderboard
            if (d.role === 'superAdmin' || d.role === 'deptAdmin' || d.role === 'overallTeamLeader' || d.role === 'teamLeader' || d.role === 'admin') return false;
            return matchesViewScope(d) && d.name;
        });

        const rows = [];
        const MEDALS = ['🥇','🥈','🥉'];

        if (_lbMode === 'daily') {
            const targetDate = localDateStr(1);
            const daySnaps = await Promise.all(filtered.map(uDoc => uDoc.ref.collection('sadhana').doc(targetDate).get()));
            filtered.forEach((uDoc, i) => {
                const u = uDoc.data(), snap = daySnaps[i];
                const joinedDate = u.joinedDate || APP_START;
                if (targetDate < joinedDate) return; // not yet joined
                const dailyMax = getDailyMax(u.level || 'Level-1');
                if (snap.exists && snap.data().sleepTime && snap.data().sleepTime !== 'NR') {
                    const d = snap.data();
                    const score = (d.totalScore??0) + (d.bonusTotal||0);
                    rows.push({ uid: uDoc.id, name: u.name||'—', photo: u.photoURL||null, level: u.level||'L1', score, pct: Math.round(score*100/dailyMax), rejected: !!d.rejected });
                } else {
                    // NR — penalize
                    rows.push({ uid: uDoc.id, name: u.name||'—', photo: u.photoURL||null, level: u.level||'L1', score: -30, pct: Math.round(-30*100/dailyMax), rejected: false, isNR: true });
                }
            });
        } else {
            const weekOffset = _lbMode === 'lastweek' ? 1 : 0;
            const { dates } = getWeekDates(weekOffset);
            const startStr = dates[0], endStr = dates[dates.length-1];
            const weekSnaps = await Promise.all(filtered.map(uDoc =>
                uDoc.ref.collection('sadhana')
                    .where(firebase.firestore.FieldPath.documentId(), '>=', startStr)
                    .where(firebase.firestore.FieldPath.documentId(), '<=', endStr).get()
            ));
            const todayStr = localDateStr(0);
            filtered.forEach((uDoc, i) => {
                const u = uDoc.data();
                const dailyMax = getDailyMax(u.level || 'Level-1');
                const joinedDate = u.joinedDate || APP_START;
                const entryMap = new Map();
                weekSnaps[i].docs.forEach(d => entryMap.set(d.id, d.data()));

                // Count all eligible days and apply NR penalty for missed/NR ones
                let totalScore = 0, totalDays = 0, filledDays = 0, svcMinsWeek = 0;
                dates.forEach(ds => {
                    if (ds < APP_START || ds < joinedDate) return;
                    if (ds > todayStr) return;
                    if (ds === todayStr) {
                        const entry = entryMap.get(ds);
                        // Today: skip if no entry at all (not yet submitted). If NR, penalize.
                        if (!entry || !entry.sleepTime) return;
                    }
                    totalDays++;
                    const entry = entryMap.get(ds);
                    if (entry && entry.sleepTime && entry.sleepTime !== 'NR') {
                        totalScore += (entry.totalScore ?? 0) + (entry.bonusTotal || 0);
                        svcMinsWeek += entry.serviceMinutes || 0;
                        filledDays++;
                    } else {
                        totalScore += -30; // NR penalty (including explicit today NR)
                    }
                });
                totalScore += calcServiceWeekly(svcMinsWeek, u.level || 'Level-1');
                if (totalDays === 0) return;
                const pct = Math.round(totalScore * 100 / (totalDays * dailyMax + 25));
                rows.push({
                    uid: uDoc.id, name: u.name||'—', photo: u.photoURL||null,
                    level: u.level||'L1', score: totalScore, pct,
                    days: filledDays + '/' + dates.length, rejected: false
                });
            });
        }

        rows.sort((a,b) => b.score - a.score);

        // Podium with dramatic stagger (3rd → 2nd → 1st)
        if (podiumEl && rows.length >= 2) {
            const top = rows.slice(0, Math.min(3, rows.length));
            // Visual order: 2nd | 1st (center) | 3rd
            const order = top.length === 2 ? [top[1], top[0]] : [top[1], top[0], top[2]];
            const delays = top.length === 2 ? [0.4, 1.2] : [1.0, 1.6, 0.4];
            const sizes = [74, 96, 62]; // rank2, rank1, rank3
            const borders = ['#94a3b8', '#fbbf24', '#cd7f32'];
            const topMargins = ['28px', '0px', '48px']; // stepped heights: 2nd slightly lower, 3rd lowest
            podiumEl.innerHTML = order.map((r, i) => {
                const rank = top.indexOf(r);
                const medal = MEDALS[rank];
                const sz = sizes[i] || 54;
                const borderColor = borders[i] || '#e5e7eb';
                const confetti = rank === 0 ? `<span style="position:absolute;top:-10px;font-size:24px;animation:confettiBurst 1.2s ease ${delays[i]+0.4}s both;">🎉</span>` : '';
                return `<div style="display:flex;flex-direction:column;align-items:center;gap:5px;min-width:86px;position:relative;margin-top:${topMargins[i]};animation:podiumRise 0.6s cubic-bezier(0.34,1.56,0.64,1) ${delays[i]}s both;">
                    ${confetti}
                    <div class="av" style="width:${sz}px;height:${sz}px;border:3px solid ${borderColor};">${r.photo ? `<img src="${r.photo}">` : `<span class="av-init" style="font-size:${Math.round(sz*0.38)}px;">${(r.name||'?').split(' ').map(n=>n[0]).join('').substring(0,2).toUpperCase()}</span>`}</div>
                    <span style="font-size:22px;">${medal}</span>
                    <span style="font-size:12px;font-weight:700;color:#1A3C5E;text-align:center;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${r.name}</span>
                    <span style="font-size:13px;font-weight:800;color:${r.pct>=70?'#16a34a':'#d97706'};">${r.score} pts</span>
                </div>`;
            }).join('');
        } else if (podiumEl) { podiumEl.innerHTML = ''; }

        // List
        container.innerHTML = rows.length === 0
            ? '<p style="color:#aaa;text-align:center;padding:20px;">No entries for this period.</p>'
            : rows.map((r, i) => {
                const isSelf = r.uid === currentUser.uid;
                const medal = i < 3 ? MEDALS[i] : `<span style="font-size:13px;font-weight:700;color:#9ca3af;">#${i+1}</span>`;
                const scoreColor = r.pct >= 70 ? '#15803d' : r.pct >= 50 ? '#d97706' : '#dc2626';
                const subLine = r.isNR ? 'NR' : r.rejected ? 'Rejected' : (r.days ? `${r.pct}% · ${r.days}d` : `${r.pct}%`);
                return `<div class="lb-row${isSelf?' lb-self':''}" data-level="${r.level}" onclick="openWCRUser(${i})" style="cursor:pointer;animation-delay:${Math.min(i*0.03,0.18)}s;${r.isNR?'opacity:0.6;':''}">
                    <div class="lb-rank">${medal}</div>
                    ${avatarHtml(r.photo, r.name, 34)}
                    <div class="lb-name">${r.name}<span style="font-size:10px;color:#9ca3af;margin-left:5px;">${r.level}</span></div>
                    <div class="lb-score-wrap">
                        <div class="lb-score" style="color:${scoreColor};">${r.rejected?'🚫':r.score}</div>
                        <div class="lb-pct">${subLine}</div>
                    </div>
                </div>`;
            }).join('');

        // Cache user list for UAC clicks
        window._wcrUserList = rows.map(r => ({
            uid: r.uid, name: r.name, level: r.level,
            chanting: '', rounds: '?', role: 'user',
            dept: userProfile?.department || '', team: userProfile?.team || ''
        }));

    } catch(err) { console.error('Leaderboard error:', err); container.innerHTML = '<p style="color:#dc2626;text-align:center;">Error loading.</p>'; }
    _lbLoading = false;
}

// ═══════════════════════════════════════════════════════════
// ADMIN LEADERBOARD (scope-aware — SA sees all, deptAdmin sees dept, TL sees team)
// ═══════════════════════════════════════════════════════════
let _adminLbMode = 'weekly', _adminLbLoading = false;

window.setAdminLBMode = (mode, btn) => {
    _adminLbMode = mode;
    document.querySelectorAll('#sa-lb-mode-tabs .chart-tab-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    // Reset filters on mode change
    const fd = document.getElementById('sa-lb-filter-dept'); if (fd) fd.value = '';
    const fl = document.getElementById('sa-lb-filter-level'); if (fl) fl.value = '';
    const ft = document.getElementById('sa-lb-filter-team'); if (ft) ft.innerHTML = '<option value="">All Teams</option>';
    loadAdminLeaderboard(true);
};

// Populate team dropdown based on selected dept filter
window.updateSALBTeams = () => {
    const dept = document.getElementById('sa-lb-filter-dept')?.value || '';
    const teamSel = document.getElementById('sa-lb-filter-team');
    if (!teamSel) return;
    teamSel.innerHTML = '<option value="">All Teams</option>';
    if (dept && DEPT_TEAMS[dept]) {
        DEPT_TEAMS[dept].forEach(t => {
            const o = document.createElement('option');
            o.value = t; o.textContent = t;
            teamSel.appendChild(o);
        });
    }
};

// Filter admin leaderboard rows by dept/level/team
window.filterAdminLB = () => {
    const dept  = document.getElementById('sa-lb-filter-dept')?.value || '';
    const level = document.getElementById('sa-lb-filter-level')?.value || '';
    const team  = document.getElementById('sa-lb-filter-team')?.value || '';
    const rows = document.querySelectorAll('#sa-leaderboard-container .lb-row');
    rows.forEach(row => {
        const d = row.dataset.dept || '';
        const l = row.dataset.level || '';
        const t = row.dataset.team || '';
        const show = (!dept || d === dept) && (!level || l === level) && (!team || t === team);
        row.style.display = show ? '' : 'none';
    });
    // Hide podium when filtering (partial data makes podium misleading)
    const podium = document.getElementById('sa-lb-podium');
    if (podium) podium.style.display = (dept || level || team) ? 'none' : 'flex';
};

// Filter user leaderboard rows by level
window.filterUserLB = () => {
    const level = document.getElementById('lb-filter-level')?.value || '';
    const rows = document.querySelectorAll('#leaderboard-container .lb-row');
    rows.forEach(row => {
        const l = row.dataset.level || '';
        const show = !level || l === level;
        row.style.display = show ? '' : 'none';
    });
    const podium = document.getElementById('lb-podium');
    if (podium) podium.style.display = level ? 'none' : 'flex';
};

async function loadAdminLeaderboard(force) {
    if (_adminLbLoading && !force) return;
    _adminLbLoading = true;
    const container = document.getElementById('sa-leaderboard-container');
    const podiumEl  = document.getElementById('sa-lb-podium');
    if (!container) { _adminLbLoading = false; return; }
    container.innerHTML = '<p style="color:#aaa;text-align:center;padding:20px;">Loading…</p>';

    try {
        const usersSnap = await db.collection('users').get();
        const filtered = usersSnap.docs.filter(doc => {
            const d = doc.data();
            if (d.role === 'superAdmin' || d.role === 'deptAdmin' || d.role === 'overallTeamLeader' || d.role === 'teamLeader' || d.role === 'admin') return false;
            return matchesScope(d) && d.name;
        });

        const rows = [];
        const MEDALS = ['🥇','🥈','🥉'];

        if (_adminLbMode === 'daily') {
            const targetDate = localDateStr(1);
            const daySnaps = await Promise.all(filtered.map(uDoc => uDoc.ref.collection('sadhana').doc(targetDate).get()));
            filtered.forEach((uDoc, i) => {
                const u = uDoc.data(), snap = daySnaps[i];
                const joinedDate = u.joinedDate || APP_START;
                if (targetDate < joinedDate) return;
                const dailyMax = getDailyMax(u.level || 'Level-1');
                if (snap.exists && snap.data().sleepTime && snap.data().sleepTime !== 'NR') {
                    const d = snap.data();
                    const score = (d.totalScore??0) + (d.bonusTotal||0);
                    rows.push({ uid: uDoc.id, name: u.name||'—', photo: u.photoURL||null, level: u.level||'L1', dept: u.department||'', team: u.team||'', score, pct: Math.round(score*100/dailyMax), rejected: !!d.rejected });
                } else {
                    rows.push({ uid: uDoc.id, name: u.name||'—', photo: u.photoURL||null, level: u.level||'L1', dept: u.department||'', team: u.team||'', score: -30, pct: Math.round(-30*100/dailyMax), rejected: false, isNR: true });
                }
            });
        } else {
            const weekOffset = _adminLbMode === 'lastweek' ? 1 : 0;
            const { dates } = getWeekDates(weekOffset);
            const startStr = dates[0], endStr = dates[dates.length-1];
            const weekSnaps = await Promise.all(filtered.map(uDoc =>
                uDoc.ref.collection('sadhana')
                    .where(firebase.firestore.FieldPath.documentId(), '>=', startStr)
                    .where(firebase.firestore.FieldPath.documentId(), '<=', endStr).get()
            ));
            const todayStr = localDateStr(0);
            filtered.forEach((uDoc, i) => {
                const u = uDoc.data();
                const dailyMax = getDailyMax(u.level || 'Level-1');
                const joinedDate = u.joinedDate || APP_START;
                const entryMap = new Map();
                weekSnaps[i].docs.forEach(d => entryMap.set(d.id, d.data()));

                let totalScore = 0, totalDays = 0, filledDays = 0, svcMinsWeek = 0;
                dates.forEach(ds => {
                    if (ds < APP_START || ds < joinedDate || ds > todayStr) return;
                    if (ds === todayStr) {
                        const entry = entryMap.get(ds);
                        if (!entry || !entry.sleepTime) return; // not submitted yet — skip
                    }
                    totalDays++;
                    const entry = entryMap.get(ds);
                    if (entry && entry.sleepTime && entry.sleepTime !== 'NR') {
                        totalScore += (entry.totalScore ?? 0) + (entry.bonusTotal || 0);
                        svcMinsWeek += entry.serviceMinutes || 0;
                        filledDays++;
                    } else {
                        totalScore += -30; // NR penalty
                    }
                });
                totalScore += calcServiceWeekly(svcMinsWeek, u.level || 'Level-1');
                if (totalDays === 0) return;
                const pct = Math.round(totalScore * 100 / (totalDays * dailyMax + 25));
                rows.push({ uid: uDoc.id, name: u.name||'—', photo: u.photoURL||null, level: u.level||'L1', dept: u.department||'', team: u.team||'', score: totalScore, pct, days: filledDays + '/' + dates.length, rejected: false });
            });
        }

        rows.sort((a,b) => b.score - a.score);

        // Podium
        if (podiumEl && rows.length >= 2) {
            const top = rows.slice(0, Math.min(3, rows.length));
            const order = top.length === 2 ? [top[1], top[0]] : [top[1], top[0], top[2]];
            const delays = top.length === 2 ? [0.4, 1.2] : [1.0, 1.6, 0.4];
            const sizes = [74, 96, 62];
            const borders = ['#94a3b8', '#fbbf24', '#cd7f32'];
            const topMargins = ['28px', '0px', '48px'];
            podiumEl.innerHTML = order.map((r, i) => {
                const rank = top.indexOf(r);
                const medal = MEDALS[rank];
                const sz = sizes[i] || 54;
                const borderColor = borders[i] || '#e5e7eb';
                const confetti = rank === 0 ? `<span style="position:absolute;top:-10px;font-size:24px;animation:confettiBurst 1.2s ease ${delays[i]+0.4}s both;">🎉</span>` : '';
                return `<div style="display:flex;flex-direction:column;align-items:center;gap:5px;min-width:86px;position:relative;margin-top:${topMargins[i]};animation:podiumRise 0.6s cubic-bezier(0.34,1.56,0.64,1) ${delays[i]}s both;">
                    ${confetti}
                    <div class="av" style="width:${sz}px;height:${sz}px;border:3px solid ${borderColor};">${r.photo ? `<img src="${r.photo}">` : `<span class="av-init" style="font-size:${Math.round(sz*0.38)}px;">${(r.name||'?').split(' ').map(n=>n[0]).join('').substring(0,2).toUpperCase()}</span>`}</div>
                    <span style="font-size:22px;">${medal}</span>
                    <span style="font-size:12px;font-weight:700;color:#1A3C5E;text-align:center;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${r.name}</span>
                    <span style="font-size:13px;font-weight:800;color:${r.pct>=70?'#16a34a':'#d97706'};">${r.score} pts</span>
                </div>`;
            }).join('');
        } else if (podiumEl) { podiumEl.innerHTML = ''; }

        // List
        window._adminCmpUserList = rows.map(r => ({ uid: r.uid, name: r.name, level: r.level, chanting: '', rounds: '?', role: 'user', dept: r.dept, team: r.team }));
        container.innerHTML = rows.length === 0
            ? '<p style="color:#aaa;text-align:center;padding:20px;">No entries for this period.</p>'
            : rows.map((r, i) => {
                const medal = i < 3 ? MEDALS[i] : `<span style="font-size:13px;font-weight:700;color:#9ca3af;">#${i+1}</span>`;
                const scoreColor = r.pct >= 70 ? '#15803d' : r.pct >= 50 ? '#d97706' : '#dc2626';
                const subLine = r.isNR ? 'NR' : r.rejected ? 'Rejected' : (r.days ? `${r.pct}% · ${r.days}d` : `${r.pct}%`);
                return `<div class="lb-row" data-dept="${r.dept}" data-level="${r.level}" data-team="${r.team}" onclick="openAdminCmpUser(${i})" style="cursor:pointer;animation-delay:${Math.min(i*0.03,0.18)}s;${r.isNR?'opacity:0.6;':''}">
                    <div class="lb-rank">${medal}</div>
                    ${avatarHtml(r.photo, r.name, 34)}
                    <div class="lb-name">${r.name}<span style="font-size:10px;color:#9ca3af;margin-left:5px;">${r.level} · ${r.dept}</span></div>
                    <div class="lb-score-wrap">
                        <div class="lb-score" style="color:${scoreColor};">${r.rejected?'🚫':r.score}</div>
                        <div class="lb-pct">${subLine}</div>
                    </div>
                </div>`;
            }).join('');

    } catch(err) { console.error('Admin Leaderboard error:', err); container.innerHTML = '<p style="color:#dc2626;text-align:center;">Error loading.</p>'; }
    _adminLbLoading = false;
}

// ═══════════════════════════════════════════════════════════
// SA HOME DASHBOARD
// ═══════════════════════════════════════════════════════════
let _saHomeLoaded = false;
async function loadSAHome() {
    if (_saHomeLoaded) return;
    _saHomeLoaded = true;
    try { await _doLoadSAHome(); } catch(e) { console.error('SA Home error:', e); _saHomeLoaded = false; }
}
async function _doLoadSAHome() {
        const usersSnap = await db.collection('users').get();
        const allUsers = usersSnap.docs.filter(d => {
            const u = d.data();
            if (u.role === 'superAdmin' || u.role === 'deptAdmin' || u.role === 'overallTeamLeader' || u.role === 'teamLeader' || u.role === 'admin') return false;
            return matchesScope(u) && u.name;
        }).sort((a,b) => (a.data().name||'').localeCompare(b.data().name||''));

        document.getElementById('sa-total-users').textContent = allUsers.length;

        // Build dept pills with counts
        const deptCounts = { IGF:0, IYF:0, ICF_MTG:0, ICF_PRJI:0 };
        allUsers.forEach(d => { const dept = d.data().department; if (deptCounts[dept] !== undefined) deptCounts[dept]++; });
        const pillsEl = document.getElementById('sa-home-dept-pills');
        if (pillsEl) {
            let pillsHtml = `<button class="chart-tab-btn active" onclick="filterSAHomeTable('',this)" style="font-size:11px;padding:5px 12px;">All</button>`;
            Object.entries(deptCounts).forEach(([dept, cnt]) => {
                pillsHtml += `<button class="chart-tab-btn" onclick="filterSAHomeTable('${dept}',this)" style="font-size:11px;padding:5px 12px;">${dept} (${cnt})</button>`;
            });
            pillsEl.innerHTML = pillsHtml;
        }

        // Store for fill table rendering
        window._saHomeAllUsers = allUsers;
        renderSAFillTable(0);
}

let _saHomeWeekOffset = 0;
window.switchSAHomeWeek = (offset, btn) => {
    _saHomeWeekOffset = offset;
    document.querySelectorAll('#sa-home-week-tabs .chart-tab-btn').forEach((b,i) => b.classList.toggle('active', i === offset));
    renderSAFillTable(offset);
};

window.filterSAHomeTable = (dept, btn) => {
    document.querySelectorAll('#sa-home-dept-pills .chart-tab-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    const rows = document.querySelectorAll('#sa-fill-table .sa-fill-row');
    rows.forEach(r => {
        r.style.display = (!dept || r.dataset.dept === dept) ? '' : 'none';
    });
};

async function renderSAFillTable(weekOffset) {
    const tableEl = document.getElementById('sa-fill-table');
    if (!tableEl) return;
    const allUsers = window._saHomeAllUsers;
    if (!allUsers || allUsers.length === 0) { tableEl.innerHTML = '<p style="color:#aaa;font-size:12px;text-align:center;">No data.</p>'; return; }

    tableEl.innerHTML = '<p style="color:#aaa;text-align:center;padding:20px;">Loading…</p>';

    const { dates } = getWeekDates(weekOffset);
    const todayStr = localDateStr(0);
    const startStr = dates[0], endStr = dates[dates.length-1];

    // Fetch sadhana for all users in the week range
    const snaps = await Promise.all(allUsers.map(uDoc =>
        uDoc.ref.collection('sadhana')
            .where(firebase.firestore.FieldPath.documentId(), '>=', startStr)
            .where(firebase.firestore.FieldPath.documentId(), '<=', endStr).get()
    ));

    const rows = [];
    allUsers.forEach((uDoc, idx) => {
        const u = uDoc.data();
        const snap = snaps[idx];
        const entrySet = new Set();
        if (snap) snap.docs.forEach(d => { if (d.data().sleepTime && d.data().sleepTime !== 'NR') entrySet.add(d.id); });

        let filled = 0, missed = 0, totalDays = 0;
        const joinedDate = u.joinedDate || APP_START;
        dates.forEach(ds => {
            if (ds < APP_START || ds < joinedDate || ds > todayStr) return;
            if (ds === todayStr && !entrySet.has(ds)) return; // today not filled yet — don't penalize
            totalDays++;
            if (entrySet.has(ds)) filled++; else missed++;
        });

        const dailyMax = getDailyMax(u.level || 'Level-1');
        let totalScore = 0, svcMinsWeek = 0;
        if (snap) snap.docs.forEach(d => { const dd = d.data(); if (dd.sleepTime && dd.sleepTime !== 'NR') { totalScore += (dd.totalScore||0) + (dd.bonusTotal||0); svcMinsWeek += (dd.serviceMinutes||0); } });
        totalScore += calcServiceWeekly(svcMinsWeek, u.level||'Level-1');
        totalScore += missed * -30;
        const pct = totalDays > 0 ? Math.round(totalScore * 100 / (totalDays * dailyMax + 25)) : 0;

        rows.push({ uid: uDoc.id, name: u.name, dept: u.department||'-', team: u.team||'-', level: u.level||'L1', chanting: u.chantingCategory||'', rounds: u.exactRounds||'?', filled, missed, totalDays, pct });
    });

    rows.sort((a,b) => b.pct - a.pct);

    // Store for UAC clicks
    window._saFillUserList = rows;

    const pctColor = p => p >= 70 ? '#16a34a' : p >= 50 ? '#d97706' : '#dc2626';
    tableEl.innerHTML = `<table class="data-table" style="font-size:12px;width:100%;">
        <thead><tr>
            <th style="text-align:left;position:sticky;left:0;background:#f8f9fa;z-index:4;box-shadow:2px 0 4px rgba(0,0,0,0.06);">Devotee</th>
            <th>Dept</th><th>Filled</th><th>Missed</th><th>%</th>
        </tr></thead>
        <tbody>${rows.map((r, i) => `<tr class="sa-fill-row" data-dept="${r.dept}">
            <td style="text-align:left;font-weight:600;position:sticky;left:0;background:white;z-index:2;box-shadow:2px 0 4px rgba(0,0,0,0.06);cursor:pointer;color:#1A3C5E;" onclick="openSAFillUser(${i})">${r.name}</td>
            <td style="font-size:11px;color:#6b7280;">${r.dept}</td>
            <td style="color:#16a34a;font-weight:600;">📋 ${r.filled}/${r.totalDays}</td>
            <td style="color:${r.missed>0?'#dc2626':'#6b7280'};font-weight:${r.missed>0?'700':'400'};">${r.missed>0?'✕ '+r.missed:'—'}</td>
            <td style="color:${pctColor(r.pct)};font-weight:700;">${r.pct}%</td>
        </tr>`).join('')}</tbody></table>`;
}

window.openSAFillUser = (idx) => {
    const r = (window._saFillUserList || [])[idx];
    if (!r) return;
    openUAC(r.uid, r.name, r.level, r.chanting, r.rounds, 'user', r.dept, r.team);
};

// ═══════════════════════════════════════════════════════════
// SA TASKS VIEW
// ═══════════════════════════════════════════════════════════
async function loadSATasks() {
    const container = document.getElementById('sa-tasks-container');
    if (!container) return;
    container.innerHTML = '<p style="color:#aaa;text-align:center;padding:20px;">Loading…</p>';
    try {
        const [taskSnap, usersSnap] = await Promise.all([
            db.collection('tasks').orderBy('createdAt','desc').limit(20).get(),
            db.collection('users').get()
        ]);
        if (taskSnap.empty) { container.innerHTML = '<p style="color:#aaa;text-align:center;padding:20px;">No tasks yet. Create one!</p>'; return; }

        const userMap = {};
        usersSnap.docs.forEach(d => { const u = d.data(); if (u.name) userMap[d.id] = u; });

        container.innerHTML = taskSnap.docs.map(d => {
            const t = d.data();
            const completedBy = t.completedBy || [];
            // Count target users
            const targetUsers = Object.entries(userMap).filter(([uid, u]) => {
                if (u.role === 'superAdmin' || u.role === 'deptAdmin' || u.role === 'overallTeamLeader' || u.role === 'teamLeader' || u.role === 'admin') return false;
                return t.targetDept === 'all' || u.department === t.targetDept;
            });
            const done = targetUsers.filter(([uid]) => completedBy.includes(uid)).length;
            const total = targetUsers.length;
            const pct = total > 0 ? Math.round(done * 100 / total) : 0;
            const pctColor = pct >= 70 ? '#16a34a' : pct >= 40 ? '#d97706' : '#dc2626';
            const target = t.targetDept === 'all' ? 'All Depts' : t.targetDept;

            return `<div class="card" style="padding:14px;margin-bottom:10px;">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;">
                    <div style="flex:1;">
                        <div style="font-size:14px;font-weight:700;color:#1A3C5E;">${t.title||'Untitled'}</div>
                        <div style="font-size:12px;color:#555;margin-top:4px;white-space:pre-wrap;">${t.body||''}</div>
                        ${t.attachmentUrl ? `<a href="${t.attachmentUrl}" target="_blank" style="font-size:12px;color:#3498db;">🔗 Attachment</a>` : ''}
                        <div style="font-size:10px;color:#9ca3af;margin-top:6px;">📌 ${target} · by ${t.createdBy||'Admin'}</div>
                    </div>
                    ${isSuperAdmin() ? `<button onclick="deleteTask('${d.id}')" style="background:none;border:none;color:#dc2626;cursor:pointer;font-size:16px;padding:4px;margin:0;width:auto;">🗑️</button>` : ''}
                </div>
                <div style="margin-top:10px;display:flex;align-items:center;gap:8px;">
                    <div class="home-act-bar" style="flex:1;"><div class="home-act-fill" style="width:${pct}%;background:${pctColor};"></div></div>
                    <span style="font-size:12px;font-weight:700;color:${pctColor};">${done}/${total} (${pct}%)</span>
                </div>
            </div>`;
        }).join('');
    } catch(e) { console.error('SA Tasks error:', e); container.innerHTML = '<p style="color:#dc2626;text-align:center;">Error loading tasks.</p>'; }
}

// ═══════════════════════════════════════════════════════════
// TASKS & ANNOUNCEMENTS (User view)
// ═══════════════════════════════════════════════════════════
async function loadTasks() {
    const container = document.getElementById('tasks-container');
    if (!container) return;
    try {
        const snap = await db.collection('tasks').orderBy('createdAt','desc').limit(10).get();
        if (snap.empty) { container.innerHTML = '<p style="color:#aaa;font-size:12px;text-align:center;">No tasks yet.</p>'; updateTasksBadge(0); return; }
        const myDept = userProfile?.department || '';
        const myTasks = snap.docs.filter(d => {
            const t = d.data();
            return t.targetDept === 'all' || t.targetDept === myDept;
        });
        const pendingCount = myTasks.filter(d => !(d.data().completedBy||[]).includes(currentUser?.uid)).length;
        updateTasksBadge(pendingCount);
        const cards = myTasks.map(d => buildTaskCard(d.id, d.data(), false));
        container.innerHTML = cards.length ? cards.join('') : '<p style="color:#aaa;font-size:12px;text-align:center;">No tasks for your department.</p>';
    } catch(e) {
        console.warn('Tasks load error:', e);
        if (container) container.innerHTML = '<p style="color:#aaa;font-size:12px;text-align:center;">No tasks yet.</p>';
        updateTasksBadge(0);
    }
}

function updateTasksBadge(count) {
    const badge = document.getElementById('header-tasks-badge');
    if (!badge) return;
    if (count > 0) { badge.textContent = count; badge.classList.remove('hidden'); }
    else { badge.classList.add('hidden'); }
}

function buildTaskCard(id, t, showAdmin) {
    const done = (t.completedBy || []).includes(currentUser?.uid);
    const doneStyle = done ? 'opacity:0.6;' : '';
    const urlLink = t.attachmentUrl ? `<a href="${t.attachmentUrl}" target="_blank" style="font-size:12px;color:#3498db;display:block;margin-top:4px;">🔗 ${t.attachmentUrl.length > 40 ? t.attachmentUrl.substring(0,40)+'...' : t.attachmentUrl}</a>` : '';
    const fileLink = t.attachmentData && t.attachmentName ? `<a href="${t.attachmentData}" download="${t.attachmentName}" style="font-size:12px;color:#3498db;display:inline-flex;align-items:center;gap:4px;margin-top:6px;background:#f0f7ff;padding:4px 10px;border-radius:6px;text-decoration:none;">📎 ${t.attachmentName}</a>` : '';
    const doneBtn = !isAnyAdmin() && !done ? `<button onclick="markTaskDone('${id}')" class="btn-success btn-sm" style="margin-top:8px;">✅ Mark Done</button>` : '';
    const doneLbl = done ? '<span style="color:#16a34a;font-size:12px;font-weight:600;">✅ Completed</span>' : '';
    const delBtn = showAdmin && isSuperAdmin() ? `<button onclick="deleteTask('${id}')" class="btn-danger btn-sm" style="margin-top:6px;">🗑️ Delete</button>` : '';
    const target = t.targetDept === 'all' ? 'All Depts' : t.targetDept;
    return `<div class="card" style="padding:14px;margin-bottom:10px;${doneStyle}">
        <div style="font-size:14px;font-weight:700;color:#1A3C5E;">${t.title||'Untitled'}</div>
        <div style="font-size:12px;color:#555;margin-top:4px;white-space:pre-wrap;">${t.body||''}</div>
        ${urlLink}${fileLink}
        <div style="font-size:10px;color:#9ca3af;margin-top:6px;">📌 ${target} · by ${t.createdBy||'Admin'} · ${(t.createdAt?.toDate?.() || new Date()).toLocaleDateString()}</div>
        ${doneLbl}${doneBtn}${delBtn}
    </div>`;
}

window.markTaskDone = async (taskId) => {
    try {
        await db.collection('tasks').doc(taskId).update({ completedBy: firebase.firestore.FieldValue.arrayUnion(currentUser.uid) });
        showToast('✅ Task marked done!', 'success');
        loadTasks();
    } catch(e) { showToast('Error: ' + e.message, 'error'); }
};

let _taskFileData = null, _taskFileName = null;

window.handleTaskFileSelect = (input) => {
    const file = input.files[0];
    if (!file) { _taskFileData = null; _taskFileName = null; return; }
    if (file.size > 5 * 1024 * 1024) { showToast('File too large (max 5MB)', 'warn'); input.value = ''; return; }
    _taskFileName = file.name;
    document.getElementById('task-file-name').textContent = file.name;
    const reader = new FileReader();
    reader.onload = (e) => { _taskFileData = e.target.result; };
    reader.readAsDataURL(file);
};

window.openTaskModal = () => {
    if (!isAnyAdmin()) return;
    document.getElementById('task-title').value = '';
    document.getElementById('task-body').value = '';
    document.getElementById('task-url').value = '';
    document.getElementById('task-file-input').value = '';
    document.getElementById('task-file-name').textContent = '';
    _taskFileData = null; _taskFileName = null;
    document.getElementById('task-target-dept').value = isDeptAdmin() ? userProfile.department : 'all';
    document.getElementById('task-create-modal').classList.remove('hidden');
};
window.closeTaskModal = () => { document.getElementById('task-create-modal').classList.add('hidden'); };

window.submitTask = async () => {
    const title = document.getElementById('task-title').value.trim();
    const body  = document.getElementById('task-body').value.trim();
    const url   = document.getElementById('task-url').value.trim();
    const dept  = document.getElementById('task-target-dept').value;
    if (!title) { showToast('Title required', 'warn'); return; }
    try {
        const taskData = {
            title, body, attachmentUrl: url, targetDept: dept,
            createdBy: userProfile.name, createdByUid: currentUser.uid,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            completedBy: []
        };
        if (_taskFileData && _taskFileName) {
            taskData.attachmentData = _taskFileData;
            taskData.attachmentName = _taskFileName;
        }
        await db.collection('tasks').add(taskData);
        showToast('✅ Task posted!', 'success');
        _taskFileData = null; _taskFileName = null;
        closeTaskModal();
        loadTasks();
    } catch(e) { showToast('Error: ' + e.message, 'error'); }
};

window.deleteTask = async (taskId) => {
    if (!isSuperAdmin()) return;
    if (!confirm('Delete this task?')) return;
    try {
        await db.collection('tasks').doc(taskId).delete();
        showToast('Task deleted.', 'success');
        loadTasks();
    } catch(e) { showToast('Error: ' + e.message, 'error'); }
};

// ═══════════════════════════════════════════════════════════
// REJECT MODAL (replaces inline prompt)
// ═══════════════════════════════════════════════════════════
let _rejectState = null;

window.openRejectModal = async (userId, dateStr, isRevoke) => {
    try {
        const docSnap = await db.collection('users').doc(userId).collection('sadhana').doc(dateStr).get();
        if (!docSnap.exists) { showToast('Entry not found', 'error'); return; }
        const d = docSnap.data();
        const uSnap = await db.collection('users').doc(userId).get();
        const uData = uSnap.exists ? uSnap.data() : {};
        const dailyMax = getDailyMax(uData.level || 'Level-1');

        _rejectState = { userId, dateStr, isRevoke, data: d };
        const titleEl = document.getElementById('reject-modal-title');
        const bodyEl  = document.getElementById('reject-modal-body');
        const btnEl   = document.getElementById('reject-confirm-btn');

        if (isRevoke) {
            titleEl.textContent = `✅ Restore Entry — ${dateStr}`;
            bodyEl.innerHTML = `Current: <strong style="color:#dc2626;">-50 (rejected)</strong><br>Will restore to: <strong style="color:#16a34a;">${d.originalTotalScore??0} pts</strong>`;
            btnEl.textContent = 'Restore';
            btnEl.className = 'btn-success';
            btnEl.style.flex = '1';
        } else {
            titleEl.textContent = `🚫 Reject Entry — ${dateStr}`;
            bodyEl.innerHTML = `Current score: <strong>${d.totalScore??0}</strong> / ${dailyMax}<br>Will be replaced with: <strong style="color:#dc2626;">-50 penalty</strong>`;
            btnEl.textContent = 'Reject';
            btnEl.className = 'btn-danger';
            btnEl.style.flex = '1';
        }
        document.getElementById('reject-remarks').value = '';
        document.getElementById('reject-modal').classList.remove('hidden');
    } catch(e) { showToast('Error: ' + e.message, 'error'); }
};

window.closeRejectModal = () => {
    document.getElementById('reject-modal').classList.add('hidden');
    _rejectState = null;
};

window.submitRejectAction = async () => {
    if (!_rejectState) return;
    const { userId, dateStr, isRevoke, data } = _rejectState;
    const remarks = document.getElementById('reject-remarks').value.trim();
    if (!remarks) { showToast('Remarks required', 'warn'); return; }

    try {
        const ref = db.collection('users').doc(userId).collection('sadhana').doc(dateStr);
        if (isRevoke) {
            await ref.update({
                rejected: false,
                totalScore: data.originalTotalScore ?? data.totalScore,
                dayPercent: data.originalDayPercent ?? data.dayPercent,
                bonusTotal: data.originalBonusTotal ?? data.bonusTotal ?? 0,
                revokedAt: firebase.firestore.FieldValue.serverTimestamp(),
                revokedBy: userProfile.name,
                revocationReason: remarks
            });
            showToast('✅ Entry restored!', 'success');
        } else {
            await ref.update({
                rejected: true,
                rejectedAt: firebase.firestore.FieldValue.serverTimestamp(),
                rejectedBy: userProfile.name,
                rejectionReason: remarks,
                originalTotalScore: data.totalScore ?? 0,
                originalDayPercent: data.dayPercent ?? 0,
                originalBonusTotal: data.bonusTotal ?? 0,
                totalScore: -50,
                dayPercent: -31,
                bonusTotal: 0
            });
            showToast('🚫 Entry rejected with -50 penalty!', 'success');
        }
        closeRejectModal();
        adminPanelLoaded = false;
        _userWCRLoaded = false;
        loadAdminPanel();
    } catch(e) { showToast('Error: ' + e.message, 'error'); }
};

// ═══════════════════════════════════════════════════════════
// BEST/WEAK PERFORMERS
// ═══════════════════════════════════════════════════════════
let _perfAllData = [], _perfTab = 'weekly', _perfYear = null, _perfMonth = null, _perfWeekIdx = 0;

function computePerformers(filteredDocs, sadhanaCache) {
    _perfAllData = filteredDocs.map((uDoc) => {
        const u = uDoc.data();
        const ents = sadhanaCache.get(uDoc.id) || [];
        const _entsMap = new Map(); ents.forEach(e => _entsMap.set(e.date, e));
        return { id: uDoc.id, name: u.name||'', level: u.level||'Level-1', ents, _entsMap, joinedDate: u.joinedDate||APP_START };
    });
    initPerfDropdowns();
    renderPerformers();
}

// Read perf selector value from whichever panel is currently active
function _perfRead(baseId) {
    const isAdmin = document.getElementById('admin-panel')?.classList.contains('active');
    const primaryId = isAdmin ? 'sa-' + baseId : baseId;
    const fallbackId = isAdmin ? baseId : 'sa-' + baseId;
    const val = document.getElementById(primaryId)?.value ?? document.getElementById(fallbackId)?.value ?? null;
    return val;
}

// Sync a value to both perf selectors
function _perfSync(baseId, val) {
    [baseId, 'sa-' + baseId].forEach(id => { const el = document.getElementById(id); if (el) el.value = String(val); });
}

function initPerfDropdowns() {
    const now = new Date();
    const curYear = now.getFullYear();
    const curMon = now.getMonth();
    const startYear = parseInt(APP_START.substring(0,4));

    let yearOpts = '';
    for (let y = curYear; y >= startYear; y--) yearOpts += `<option value="${y}">${y}</option>`;
    ['perf-year-sel','sa-perf-year-sel'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.innerHTML = yearOpts; el.value = String(curYear); }
    });
    _perfYear = curYear;
    _perfMonth = curMon;
    populateMonthDropdown();
    populateWeekDropdown();
}

function populateMonthDropdown() {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const now = new Date();
    const curYear = now.getFullYear(), curMon = now.getMonth();
    const startYear = parseInt(APP_START.substring(0,4)), startMon = parseInt(APP_START.substring(5,7)) - 1;
    const fromMon = _perfYear === startYear ? startMon : 0;
    const toMon = _perfYear === curYear ? curMon : 11;
    // Clamp _perfMonth to valid range for the selected year
    _perfMonth = Math.min(toMon, Math.max(fromMon, _perfMonth));
    let opts = '';
    for (let m = toMon; m >= fromMon; m--) opts += `<option value="${m}">${months[m]}</option>`;
    ['perf-month-sel','sa-perf-month-sel'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.innerHTML = opts; el.value = String(_perfMonth); }
    });
    // _perfMonth already set above — no re-read needed
}

function populateWeekDropdown() {
    const monthStart = new Date(_perfYear, _perfMonth, 1);
    const monthEnd = new Date(_perfYear, _perfMonth + 1, 0);
    const weeks = getWeeksInMonth(monthStart, monthEnd);
    const fmt = d => `${String(d.getDate()).padStart(2,'0')} ${d.toLocaleString('en-GB',{month:'short'})}`;
    let opts = '';
    weeks.forEach((sunStr, i) => {
        const [y,m,d] = sunStr.split('-').map(Number);
        const sun = new Date(y, m-1, d);
        const sat = new Date(y, m-1, d+6);
        opts += `<option value="${i}">${fmt(sun)} – ${fmt(sat)}</option>`;
    });
    // Default to the week that contains today; for past months default to last week
    const todayDs = localDateStr(0);
    let defaultIdx = weeks.length - 1;
    for (let i = 0; i < weeks.length; i++) {
        const [wy,wm,wd] = weeks[i].split('-').map(Number);
        const sat = new Date(wy, wm-1, wd+6);
        const satDs = toLocalDS(sat);
        if (satDs >= todayDs) { defaultIdx = i; break; } // first week whose end >= today
    }
    // Clamp to last valid week if all weeks are in the future (shouldn't happen)
    defaultIdx = Math.max(0, Math.min(defaultIdx, weeks.length - 1));
    ['perf-week-sel','sa-perf-week-sel'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.innerHTML = opts; el.value = String(defaultIdx); el.style.display = _perfTab === 'weekly' ? '' : 'none'; }
    });
    _perfWeekIdx = defaultIdx;
}

function getWeeksInMonth(monthStart, monthEnd) {
    const weeks = [];
    const firstSun = new Date(monthStart);
    firstSun.setDate(firstSun.getDate() - firstSun.getDay());
    let cur = new Date(firstSun);
    const toLocal = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    while (cur <= monthEnd) {
        weeks.push(toLocal(cur));
        cur.setDate(cur.getDate() + 7);
    }
    return weeks;
}

window.onPerfYearChange = () => {
    const raw = _perfRead('perf-year-sel');
    if (raw == null) return;
    _perfYear = parseInt(raw);
    _perfSync('perf-year-sel', _perfYear);
    populateMonthDropdown();
    populateWeekDropdown();
    renderPerformers();
};

window.onPerfMonthChange = () => {
    const raw = _perfRead('perf-month-sel');
    if (raw == null) return;
    _perfMonth = parseInt(raw);
    _perfSync('perf-month-sel', _perfMonth);
    populateWeekDropdown();
    renderPerformers();
};

window.onPerfWeekChange = () => {
    const raw = _perfRead('perf-week-sel');
    if (raw == null) return;
    _perfWeekIdx = parseInt(raw);
    _perfSync('perf-week-sel', _perfWeekIdx);
    renderPerformers();
};

window.setPerfTab = (tab, btn) => {
    _perfTab = tab;
    document.querySelectorAll('.perf-tab-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    // Also sync the other panel's buttons
    document.querySelectorAll('.perf-tab-btn').forEach(b => {
        if (b.textContent.trim().toLowerCase() === tab) b.classList.add('active');
    });
    ['perf-week-sel','sa-perf-week-sel'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = tab === 'weekly' ? '' : 'none';
    });
    renderPerformers();
};

function renderPerformers() {
    if (_perfAllData.length < 2) {
        ['perf-charts','admin-perf-charts'].forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = ''; });
        highlightWCRColumn(null);
        return;
    }

    const monthStart = new Date(_perfYear, _perfMonth, 1);
    const monthEnd = new Date(_perfYear, _perfMonth + 1, 0);
    const weeks = getWeeksInMonth(monthStart, monthEnd);
    const todayStr = localDateStr(0);

    const results = _perfAllData.map(u => {
        let pct = 0;
        if (_perfTab === 'weekly') {
            // Single week
            const weekSun = weeks[Math.min(_perfWeekIdx, weeks.length-1)] || weeks[0];
            let tot = 0, svcMinsWeek = 0;
            const weekEnts = [];
            const [pwy,pwm,pwd] = weekSun.split('-').map(Number);
            for (let i = 0; i < 7; i++) {
                const d = new Date(pwy,pwm-1,pwd+i);
                const ds = toLocalDS(d);
                if (ds < APP_START || ds > todayStr) continue;
                const e = u._entsMap ? u._entsMap.get(ds) : u.ents.find(en => en.date === ds);
                if (e) { tot += (e.score||0) + (e.bonus||0); svcMinsWeek += (e.svcMins||0); weekEnts.push({ id: ds }); }
                else if (ds < todayStr) { tot += -30; }
                // today not submitted — skip (matches WCR behavior)
            }
            tot += calcServiceWeekly(svcMinsWeek, u.level);
            const fd = fairDenominator(weekSun, weekEnts, u.level);
            pct = Math.round(tot * 100 / fd);
        } else {
            // Monthly — average of all weeks
            let sum = 0, count = 0;
            weeks.forEach(weekSun => {
                let tot = 0, svcMinsWeek = 0, eligibleDays = 0;
                const weekEnts = [];
                const [mwy,mwm,mwd] = weekSun.split('-').map(Number);
                for (let i = 0; i < 7; i++) {
                    const d = new Date(mwy,mwm-1,mwd+i);
                    const ds = toLocalDS(d);
                    if (ds < APP_START || ds > todayStr) continue;
                    eligibleDays++;
                    const e = u._entsMap ? u._entsMap.get(ds) : u.ents.find(en => en.date === ds);
                    if (e) { tot += (e.score||0) + (e.bonus||0); svcMinsWeek += (e.svcMins||0); weekEnts.push({ id: ds }); }
                    else if (ds < todayStr) { tot += -30; }
                    // today not submitted — skip (matches WCR behavior)
                }
                tot += calcServiceWeekly(svcMinsWeek, u.level);
                const fd = fairDenominator(weekSun, weekEnts, u.level);
                const weekPct = Math.round(tot * 100 / fd);
                if (eligibleDays > 0) { sum += weekPct; count++; }
            });
            pct = count > 0 ? Math.round(sum / count) : 0;
        }
        return { name: u.name, pct, level: u.level };
    });

    results.sort((a,b) => b.pct - a.pct);
    const best = results.slice(0, 3);
    const weak = results.slice(-3).reverse();

    // SVG ring chart builder
    function svgRing(items, colors, centerPct, centerColor, centerLabel) {
        const radii = [68, 50, 32];
        const sw = 13;
        let arcs = '';
        items.forEach((r, i) => {
            if (i >= 3) return;
            const rd = radii[i];
            const circ = 2 * Math.PI * rd;
            const pctClamped = Math.max(0, Math.min(r.pct, 100));
            const dashLen = (pctClamped / 100) * circ;
            arcs += `<circle cx="80" cy="80" r="${rd}" fill="none" stroke="#e5e7eb" stroke-width="${sw}" />`;
            arcs += `<circle cx="80" cy="80" r="${rd}" fill="none" stroke="${colors[i]}" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${dashLen} ${circ}" transform="rotate(-90 80 80)" style="transition:stroke-dasharray 0.8s ease;" />`;
        });
        return `<svg viewBox="0 0 160 160" style="width:140px;height:140px;">
            ${arcs}
            <text x="80" y="74" text-anchor="middle" font-size="20" font-weight="800" fill="${centerColor}">${centerPct}%</text>
            <text x="80" y="92" text-anchor="middle" font-size="9" fill="#6b7280">${centerLabel}</text>
        </svg>`;
    }

    const legendHtml = (items, colors) => items.map((r, i) => `<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;">
        <div style="width:8px;height:8px;border-radius:50%;background:${colors[i]||'#888'};flex-shrink:0;"></div>
        <span style="font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${r.name}</span>
        <span style="font-size:12px;font-weight:700;color:${colors[i]||'#888'};">${r.pct}%</span>
    </div>`).join('');

    const bestColors = ['#3b82f6','#60a5fa','#93c5fd'];
    const weakColors = ['#ef4444','#f97316','#fbbf24'];

    const html = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div class="card" style="padding:12px;text-align:center;">
            <div style="font-size:12px;font-weight:700;color:#1d4ed8;margin-bottom:8px;">🏆 Top Performers</div>
            ${svgRing(best, bestColors, best[0]?.pct||0, '#3b82f6', 'top score')}
            <div style="text-align:left;margin-top:8px;">${legendHtml(best, bestColors)}</div>
        </div>
        <div class="card" style="padding:12px;text-align:center;">
            <div style="font-size:12px;font-weight:700;color:#dc2626;margin-bottom:8px;">🔻 Needs Attention</div>
            ${svgRing(weak, weakColors, weak[0]?.pct||0, '#ef4444', 'lowest')}
            <div style="text-align:left;margin-top:8px;">${legendHtml(weak, weakColors)}</div>
        </div>
    </div>`;

    ['perf-charts','admin-perf-charts'].forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = html; });

    // Highlight the selected week's column in WCR table
    if (_perfTab === 'weekly') {
        const selectedSun = weeks[Math.min(_perfWeekIdx, weeks.length-1)];
        setTimeout(() => highlightWCRColumn(selectedSun), 100);
    } else {
        highlightWCRColumn(null);
    }
}

function highlightWCRColumn(selectedSunStr) {
    // Remove all existing highlights
    document.querySelectorAll('.col-highlight').forEach(el => el.classList.remove('col-highlight'));
    if (!selectedSunStr) return;

    // Find matching column in WCR tables by header text
    const [sy,sm,sd] = selectedSunStr.split('-').map(Number);
    const sun = new Date(sy, sm-1, sd);
    const fmt = d => `${String(d.getDate()).padStart(2,'0')} ${d.toLocaleString('en-GB',{month:'short'})}`;
    const matchText = fmt(sun);

    ['comp-perf-table','admin-comparative-reports-container'].forEach(containerId => {
        const container = document.getElementById(containerId);
        if (!container) return;
        const table = container.querySelector?.('table') || container;
        if (!table || !table.querySelectorAll) return;
        const ths = table.querySelectorAll('th.comp-th, th');
        let matchCol = -1;
        ths.forEach((th, i) => { if (th.textContent.trim().includes(matchText)) matchCol = i; });
        if (matchCol < 0) return;
        if (ths[matchCol]) ths[matchCol].classList.add('col-highlight');
        table.querySelectorAll('tbody tr').forEach(tr => {
            const tds = tr.querySelectorAll('td');
            if (tds[matchCol]) tds[matchCol].classList.add('col-highlight');
        });
    });
}

// ═══════════════════════════════════════════════════════════
// DEPARTMENT EXCEL DOWNLOAD
// ═══════════════════════════════════════════════════════════
window.downloadDeptExcel = async (dept) => {
    if (!dept || !isAnyAdmin()) return;
    showToast('Generating ' + dept + ' report…', 'info');
    try {
        const usersSnap = await db.collection('users').get();
        const deptUsers = usersSnap.docs.filter(d => {
            const u = d.data();
            if (u.role === 'superAdmin' || u.role === 'deptAdmin' || u.role === 'overallTeamLeader' || u.role === 'teamLeader' || u.role === 'admin') return false;
            return u.department === dept && u.name && matchesScope(u);
        }).sort((a,b) => (a.data().name||'').localeCompare(b.data().name||''));

        if (deptUsers.length === 0) { showToast('No users found in ' + dept, 'warn'); return; }

        const wb = XLSX.utils.book_new();
        const allDeptSnaps = await Promise.all(deptUsers.map(uDoc => uDoc.ref.collection('sadhana').get()));
        for (let di = 0; di < deptUsers.length; di++) {
            const uDoc = deptUsers[di];
            const u = uDoc.data();
            const saSnap = allDeptSnaps[di];
            const level = u.level || 'Level-1';
            const dailyMax = getDailyMax(level);

            // Group by week
            const weekMap = {};
            saSnap.docs.forEach(d => {
                const wi = getWeekInfo(d.id);
                if (!weekMap[wi.label]) weekMap[wi.label] = { sunStr: wi.sunStr, label: wi.label, data: [] };
                weekMap[wi.label].data.push({ id: d.id, ...d.data() });
            });

            const DCOLS = 12;
            const rows = [
                [`${dept} — SADHANA REPORT`, ...Array(DCOLS-1).fill('')],
                ['Name',     u.name||'',               ...Array(DCOLS-2).fill('')],
                ['Level',    level,                    ...Array(DCOLS-2).fill('')],
                ['Team',     u.team||'',               ...Array(DCOLS-2).fill('')],
                ['Chanting', u.chantingCategory||'',   ...Array(DCOLS-2).fill('')],
                ['Rounds',   u.exactRounds||'',        ...Array(DCOLS-2).fill('')],
                Array(DCOLS).fill(''),
                ['Date','Sleep','Wake','Chant','Read(m)','Hear(m)','Inst(m)','DaySleep(m)','Service(m)','Notes(m)','Total','%']
            ];
            const PROF_ROWS = 8; // rows 0-7 are profile/header block

            Object.values(weekMap).sort((a,b) => b.sunStr.localeCompare(a.sunStr)).forEach(wk => {
                rows.push([`── WEEK: ${wk.label.replace('_',' ')} ──`, ...Array(DCOLS-1).fill('')]);
                wk.data.sort((a,b) => a.id.localeCompare(b.id)).forEach(e => {
                    rows.push([
                        e.id, e.sleepTime||'NR', e.wakeupTime||'NR', e.chantingTime||'NR',
                        e.readingMinutes||0, e.hearingMinutes||0, e.instrumentMinutes||0,
                        e.daySleepMinutes||0, e.serviceMinutes||0, e.notesMinutes||0,
                        (e.totalScore||0)+(e.bonusTotal||0), (e.dayPercent||0)+'%'
                    ]);
                });
                const wkSvcMins = wk.data.reduce((s,e) => s + (e.serviceMinutes||0), 0);
                const wkTotal   = wk.data.reduce((s,e) => s + (e.totalScore||0) + (e.bonusTotal||0), 0) + calcServiceWeekly(wkSvcMins, level);
                const wkFD      = wk.data.length * dailyMax + 25;
                const wkPct     = wk.data.length ? Math.round(wkTotal*100/wkFD) : 0;
                rows.push(['WEEK TOTAL','','','','','','','','','', wkTotal, wkPct+'%']);
                rows.push(Array(DCOLS).fill(''));
            });

            const ws = XLSX.utils.aoa_to_sheet(rows);

            // ── MERGES ───────────────────────────────────────
            const dMerges = [{ s:{r:0,c:0}, e:{r:0,c:DCOLS-1} }]; // title
            for (let r=1;r<=5;r++) dMerges.push({s:{r,c:1}, e:{r,c:DCOLS-1}}); // profile values
            // Week header rows only — merge all cols (WEEK TOTAL NOT merged so score/% are visible)
            for (let r=PROF_ROWS;r<rows.length;r++) {
                const cell0 = String(rows[r]?.[0]||'');
                if (cell0.startsWith('──')) dMerges.push({s:{r,c:0},e:{r,c:DCOLS-1}});
            }
            ws['!merges'] = dMerges;

            // ── STYLES ───────────────────────────────────────
            // Title row
            for (let c=0;c<DCOLS;c++) styleCell(ws, `${colLetter(c)}1`, { bold:true, fill:'1A3C5E', fontColor:'FFFFFF', sz:13, align:'center' });

            // Profile rows (rows 1-5 = Excel rows 2-6)
            for (let r=1;r<=5;r++) {
                styleCell(ws, `A${r+1}`, { bold:true, fill:'2E86C1', fontColor:'FFFFFF', align:'left' });
                for (let c=1;c<DCOLS;c++) styleCell(ws, `${colLetter(c)}${r+1}`, { fill:'EBF3FB', align:'left' });
            }
            // Blank row (row 6 = Excel row 7)
            for (let c=0;c<DCOLS;c++) styleCell(ws, `${colLetter(c)}7`, { fill:'F0F4F8' });

            // Column headers (row 7 = Excel row 8)
            for (let c=0;c<DCOLS;c++) styleCell(ws, `${colLetter(c)}8`, { bold:true, fill:'2E86C1', fontColor:'FFFFFF', sz:10, align:'center' });

            // Data rows
            let stripeToggle = 0;
            for (let r=PROF_ROWS;r<rows.length;r++) {
                const row    = rows[r];
                const rNum   = r+1;
                const isBlank = !row || row.every(v=>v==='');
                if (isBlank) { for(let c=0;c<DCOLS;c++) styleCell(ws,`${colLetter(c)}${rNum}`,{fill:'FFFFFF'}); continue; }

                const cell0  = String(row[0]||'');
                const isWeekHdr  = cell0.startsWith('──');
                const isWeekTot  = cell0 === 'WEEK TOTAL';
                const isNR       = row[1] === 'NR';

                if (isWeekHdr) {
                    for(let c=0;c<DCOLS;c++) styleCell(ws,`${colLetter(c)}${rNum}`,{ bold:true, fill:'1A3C5E', fontColor:'FFFFFF', sz:11, align:'center' });
                    stripeToggle = 0;
                } else if (isWeekTot) {
                    // Style all cols with blue-tint; then override total and % cols with conditional color
                    for(let c=0;c<DCOLS;c++) styleCell(ws,`${colLetter(c)}${rNum}`,{ bold:true, fill:'D5E8F7', fontColor:'1A3C5E', sz:11, align:'center' });
                    styleCell(ws,`A${rNum}`,{ bold:true, fill:'D5E8F7', fontColor:'1A3C5E', align:'left', sz:11 });
                    // Total col (DCOLS-2) — bold score value
                    styleCell(ws,`${colLetter(DCOLS-2)}${rNum}`,{ bold:true, fill:'D5E8F7', fontColor:'1A3C5E', sz:12, align:'center' });
                    // % col (DCOLS-1) — conditional color
                    const pctRef = `${colLetter(DCOLS-1)}${rNum}`;
                    const pv = ws[pctRef] ? parseInt(String(ws[pctRef].v))||0 : 0;
                    const tf = pv>=70?'C6EFCE':pv>=50?'FFEB9C':'FFC7CE';
                    const tc = pv>=70?'006100':pv>=50?'9C5700':'C0392B';
                    styleCell(ws,pctRef,{ bold:true, fill:tf, fontColor:tc, sz:12, align:'center' });
                } else {
                    // Regular data row
                    stripeToggle++;
                    const bg = isNR ? 'FFC7CE' : (stripeToggle%2===0?'F8FAFC':'FFFFFF');
                    const fc = isNR ? 'C0392B' : '1A252F';
                    styleCell(ws,`A${rNum}`,{ bold:true, fill:bg, fontColor:fc, align:'left' });
                    for(let c=1;c<DCOLS-1;c++) styleCell(ws,`${colLetter(c)}${rNum}`,{ fill:bg, fontColor:fc, align:'center' });
                    // % col conditional
                    const pctRef = `${colLetter(DCOLS-1)}${rNum}`;
                    if (ws[pctRef] && !isNR) {
                        const pv = parseInt(ws[pctRef].v)||0;
                        const tf = pv>=70?'C6EFCE':pv>=50?'FFEB9C':'FFC7CE';
                        const tc = pv>=70?'006100':pv>=50?'9C5700':'C0392B';
                        styleCell(ws,pctRef,{ bold:true, fill:tf, fontColor:tc, align:'center' });
                    } else if (ws[pctRef]) {
                        styleCell(ws,pctRef,{ bold:true, fill:'FFC7CE', fontColor:'C0392B', align:'center' });
                    }
                    // Total col — re-style as bold
                    styleCell(ws,`${colLetter(DCOLS-2)}${rNum}`,{ bold:true, fill:bg, fontColor:fc, sz:12, align:'center' });
                }
            }

            ws['!cols'] = [{ wch:14 }, { wch:9 }, { wch:9 }, { wch:9 }, { wch:8 }, { wch:8 }, { wch:8 }, { wch:10 }, { wch:10 }, { wch:9 }, { wch:8 }, { wch:7 }];
            ws['!freeze'] = { xSplit:1, ySplit:PROF_ROWS, topLeftCell:`B${PROF_ROWS+1}` };
            const sheetName = (u.name||'User').substring(0,31);
            XLSX.utils.book_append_sheet(wb, ws, sheetName);
        }

        xlsxSave(wb, `${dept}_Sadhana_Report.xlsx`);
        showToast('✅ Downloaded!', 'success');
    } catch(e) { showToast('Error: ' + e.message, 'error'); console.error(e); }
};
