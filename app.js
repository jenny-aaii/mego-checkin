(function () {
  "use strict";

  var FIREBASE_CONFIG = {
    apiKey: "AIzaSyBQ5s8Rvu79XLlEBzWUjD24CXpbdRBokQc",
    authDomain: "mevolution-go.firebaseapp.com",
    projectId: "mevolution-go",
    storageBucket: "mevolution-go.firebasestorage.app",
    messagingSenderId: "824909531681",
    appId: "1:824909531681:web:87c700c23ec04085797160"
  };

  // TEMP: while true, clock in/out buttons stay clickable even after already
  // used today, so testing isn't blocked. Set back to true to re-lock once
  // testing is done.
  var LOCK_AFTER_CLOCK = false;

  var LEAVE_TYPES = ["病假", "事假", "公假", "其他"];
  var WEEKDAY_CHARS = ["日", "一", "二", "三", "四", "五", "六"];

  var LAST_MONTH_KEY = "mius_lastMonth";
  var LAST_INTERN_KEY = "mius_lastInternEmail";

  firebase.initializeApp(FIREBASE_CONFIG);
  var auth = firebase.auth();
  var db = firebase.firestore();

  // ---------- state ----------
  var state = {
    user: null, // {email, name, role}
    interns: [], // [{email, name}] — HR only
    viewingEmail: "",
    viewingName: "",
    year: 0,
    month: 0, // 1-12
    periodStart: "",
    periodEnd: "",
    records: {}, // dateStr -> {clockIn, clockOut, leaveType, note}
    supervisorName: "",
    buName: ""
  };

  var today = new Date();
  var todayStr = formatDate(today);

  // ---------- date helpers ----------
  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  function formatDate(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function yyyyMM(year, month) {
    return year + "-" + pad2(month);
  }

  function addDaysISO(dateStr, n) {
    var parts = dateStr.split("-").map(Number);
    var d = new Date(parts[0], parts[1] - 1, parts[2]);
    d.setDate(d.getDate() + n);
    return formatDate(d);
  }

  function formatPeriodRange(startStr, endStr) {
    var s = startStr.split("-");
    var e = endStr.split("-");
    return s[1] + "/" + s[2] + " - " + e[1] + "/" + e[2];
  }

  function dateRange(startStr, endStr) {
    var dates = [];
    var cur = startStr;
    var guard = 0;
    while (cur <= endStr && guard < 366) {
      dates.push(cur);
      cur = addDaysISO(cur, 1);
      guard++;
    }
    return dates;
  }

  // Default cycle is the 25th of the previous month through the 24th of this
  // month (submission deadline is the 24th). Either end can be overridden
  // per month (checkinMeta) for occasional early cutoffs — see chat.
  function defaultPeriodEnd(year, month) {
    return year + "-" + pad2(month) + "-24";
  }

  var periodMetaCache = {}; // yyyyMM -> {periodStart, periodEnd} override doc data

  function loadPeriodMeta(year, month) {
    var key = yyyyMM(year, month);
    if (periodMetaCache[key] !== undefined) return Promise.resolve(periodMetaCache[key]);
    return db.collection("checkinMeta").doc(key).get().then(function (doc) {
      var data = doc.exists ? doc.data() : null;
      periodMetaCache[key] = data;
      return data;
    });
  }

  function resolvePeriodEnd(year, month) {
    return loadPeriodMeta(year, month).then(function (meta) {
      return (meta && meta.periodEnd) || defaultPeriodEnd(year, month);
    });
  }

  function resolvePeriodStart(year, month) {
    return loadPeriodMeta(year, month).then(function (meta) {
      if (meta && meta.periodStart) return meta.periodStart;
      var py = month === 1 ? year - 1 : year;
      var pm = month === 1 ? 12 : month - 1;
      return resolvePeriodEnd(py, pm).then(function (prevEnd) {
        return addDaysISO(prevEnd, 1);
      });
    });
  }

  function resolvePeriod(year, month) {
    return Promise.all([resolvePeriodStart(year, month), resolvePeriodEnd(year, month)])
      .then(function (results) {
        return { start: results[0], end: results[1] };
      });
  }

  function savePeriodOverride(year, month, field, value) {
    var key = yyyyMM(year, month);
    var patch = {};
    patch[field] = value;
    periodMetaCache[key] = Object.assign({}, periodMetaCache[key] || {}, patch);
    return db.collection("checkinMeta").doc(key).set(patch, { merge: true });
  }

  // ---------- checkins doc ----------
  function checkinDocId(email, year, month) {
    return email + "_" + yyyyMM(year, month);
  }

  function emptyCheckinData(email, name) {
    return { internEmail: email, name: name, buName: "", supervisorName: "", records: {} };
  }

  function loadCheckinDoc(email, name, year, month) {
    return db.collection("checkins").doc(checkinDocId(email, year, month)).get()
      .then(function (doc) {
        return doc.exists ? doc.data() : emptyCheckinData(email, name);
      });
  }

  function saveCheckinDoc() {
    var data = {
      internEmail: state.viewingEmail,
      name: state.viewingName,
      buName: state.buName || "",
      supervisorName: state.supervisorName || "",
      records: state.records
    };
    return db.collection("checkins").doc(checkinDocId(state.viewingEmail, state.year, state.month)).set(data);
  }

  function getRecord(dateStr) {
    return state.records[dateStr] || { clockIn: "", clockOut: "", leaveType: "", note: "" };
  }

  function setRecord(dateStr, patch) {
    var rec = getRecord(dateStr);
    var updated = {};
    updated.clockIn = patch.clockIn !== undefined ? patch.clockIn : rec.clockIn;
    updated.clockOut = patch.clockOut !== undefined ? patch.clockOut : rec.clockOut;
    updated.leaveType = patch.leaveType !== undefined ? patch.leaveType : rec.leaveType;
    updated.note = patch.note !== undefined ? patch.note : rec.note;
    if (!updated.clockIn && !updated.clockOut && !updated.leaveType && !updated.note) {
      delete state.records[dateStr];
    } else {
      state.records[dateStr] = updated;
    }
    return saveCheckinDoc().catch(function (err) {
      console.error("save error:", err);
      window.alert("儲存失敗，請檢查網路連線後再試一次。");
    });
  }

  function timeToMinutes(t) {
    if (!t) return null;
    var parts = t.split(":");
    var h = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10);
    if (isNaN(h) || isNaN(m)) return null;
    return h * 60 + m;
  }

  // Core work-hour rule (Sec 3.2): hours = (clockOut - clockIn) - lunch deduction
  // Lunch deduction: >=4hr worked -> deduct 1hr; otherwise no deduction.
  function calcDay(rec) {
    if (rec.leaveType) {
      return { lunch: null, hours: 0, complete: true, isLeave: true };
    }
    var inMin = timeToMinutes(rec.clockIn);
    var outMin = timeToMinutes(rec.clockOut);
    if (inMin === null || outMin === null) {
      return { lunch: null, hours: null, complete: false, isLeave: false };
    }
    var durationMin = outMin - inMin;
    if (durationMin <= 0) {
      return { lunch: null, hours: null, complete: false, isLeave: false, error: true };
    }
    var durationHours = durationMin / 60;
    var lunch = durationHours >= 4 ? 1 : 0;
    var hours = Math.max(durationHours - lunch, 0);
    hours = Math.round(hours * 100) / 100;
    return { lunch: lunch, hours: hours, complete: true, isLeave: false };
  }

  // ---------- DOM refs ----------
  var loginScreen = document.getElementById("loginScreen");
  var appRoot = document.getElementById("appRoot");
  var googleLoginBtn = document.getElementById("googleLoginBtn");
  var loginError = document.getElementById("loginError");
  var logoutBtn = document.getElementById("logoutBtn");
  var userBadge = document.getElementById("userBadge");

  var internSelectGroup = document.getElementById("internSelectGroup");
  var internSelect = document.getElementById("internSelect");
  var prevMonthBtn = document.getElementById("prevMonthBtn");
  var nextMonthBtn = document.getElementById("nextMonthBtn");
  var monthLabel = document.getElementById("monthLabel");
  var supervisorInput = document.getElementById("supervisorInput");
  var buInput = document.getElementById("buInput");
  var periodStartInput = document.getElementById("periodStartInput");
  var periodEndInput = document.getElementById("periodEndInput");

  var statusDot = document.getElementById("statusDot");
  var statusText = document.getElementById("statusText");
  var todayLabel = document.getElementById("todayLabel");
  var clockInBtn = document.getElementById("clockInBtn");
  var clockOutBtn = document.getElementById("clockOutBtn");
  var notTodayNotice = document.getElementById("notTodayNotice");

  var totalHoursEl = document.getElementById("totalHours");
  var attendDaysEl = document.getElementById("attendDays");
  var leaveDaysEl = document.getElementById("leaveDays");

  var recordTbody = document.getElementById("recordTbody");
  var leaveStatList = document.getElementById("leaveStatList");
  var exportBtn = document.getElementById("exportBtn");

  // ---------- auth ----------
  function showLoginError(msg) {
    loginError.textContent = msg;
    loginError.classList.remove("hidden");
  }

  googleLoginBtn.addEventListener("click", function () {
    loginError.classList.add("hidden");
    googleLoginBtn.disabled = true;
    var provider = new firebase.auth.GoogleAuthProvider();
    auth.signInWithPopup(provider).catch(function (err) {
      console.error("google sign-in error:", err);
      if (err.code === "auth/popup-blocked") {
        showLoginError("瀏覽器封鎖了登入視窗，請允許此網站的彈出視窗後再試一次。");
      } else if (err.code !== "auth/popup-closed-by-user" && err.code !== "auth/cancelled-popup-request") {
        showLoginError("登入失敗，請稍後再試。");
      }
    }).finally(function () {
      googleLoginBtn.disabled = false;
    });
  });

  logoutBtn.addEventListener("click", function () {
    auth.signOut();
  });

  var handledAuthUid = null;
  auth.onAuthStateChanged(function (fbUser) {
    if (!fbUser) {
      handledAuthUid = null;
      state.user = null;
      loginScreen.style.display = "flex";
      appRoot.classList.add("hidden");
      return;
    }
    if (handledAuthUid === fbUser.uid) return;
    handledAuthUid = fbUser.uid;
    var email = (fbUser.email || "").toLowerCase();
    db.collection("checkinUsers").doc(email).get().then(function (doc) {
      if (!doc.exists) {
        showLoginError("此 Google 帳號（" + email + "）不在授權名單中，請確認信箱是否正確或聯絡管理員。");
        return auth.signOut();
      }
      state.user = Object.assign({ email: email }, doc.data());
      return enterApp();
    }).catch(function (err) {
      console.error("login lookup error:", err);
      showLoginError("登入時發生錯誤，請稍後再試。");
      auth.signOut();
    });
  });

  // ---------- app entry ----------
  function enterApp() {
    loginScreen.style.display = "none";
    appRoot.classList.remove("hidden");
    userBadge.textContent = state.user.name + "（" + (state.user.role === "hr" ? "HR" : "實習生") + "）";

    var setupPromise;
    if (state.user.role === "hr") {
      internSelectGroup.classList.remove("hidden");
      setupPromise = db.collection("checkinUsers").where("role", "==", "intern").get().then(function (snap) {
        state.interns = snap.docs.map(function (d) { return { email: d.id, name: d.data().name }; });
        populateInternSelect();
        var lastEmail = localStorage.getItem(LAST_INTERN_KEY);
        var initial = state.interns.some(function (i) { return i.email === lastEmail; })
          ? lastEmail
          : (state.interns[0] ? state.interns[0].email : "");
        internSelect.value = initial;
        return setViewingIntern(initial);
      });
    } else {
      internSelectGroup.classList.add("hidden");
      setupPromise = setViewingIntern(state.user.email);
    }

    var lastMonth = localStorage.getItem(LAST_MONTH_KEY);
    var y, m;
    if (lastMonth) {
      var parts = lastMonth.split("-");
      y = parseInt(parts[0], 10);
      m = parseInt(parts[1], 10);
    }
    if (!y || !m) {
      y = today.getFullYear();
      m = today.getMonth() + 1;
    }
    state.year = y;
    state.month = m;

    return setupPromise.then(function () { return render(); });
  }

  function populateInternSelect() {
    internSelect.innerHTML = "";
    state.interns.forEach(function (i) {
      var opt = document.createElement("option");
      opt.value = i.email;
      opt.textContent = i.name;
      internSelect.appendChild(opt);
    });
  }

  function setViewingIntern(email) {
    var intern = state.interns.find(function (i) { return i.email === email; });
    state.viewingEmail = email;
    state.viewingName = intern ? intern.name : state.user.name;
    if (state.user.role === "hr") localStorage.setItem(LAST_INTERN_KEY, email);
    return refreshMonthData();
  }

  function refreshMonthData() {
    if (!state.viewingEmail) return Promise.resolve();
    return Promise.all([
      resolvePeriod(state.year, state.month),
      loadCheckinDoc(state.viewingEmail, state.viewingName, state.year, state.month)
    ]).then(function (results) {
      state.periodStart = results[0].start;
      state.periodEnd = results[0].end;
      var doc = results[1];
      state.records = doc.records || {};
      state.buName = doc.buName || "";
      state.supervisorName = doc.supervisorName || "";
    });
  }

  // ---------- month management ----------
  function switchMonth(year, month) {
    state.year = year;
    state.month = month;
    localStorage.setItem(LAST_MONTH_KEY, yyyyMM(year, month));
    refreshMonthData().then(function () { render(); });
  }

  function goPrevMonth() {
    var m = state.month - 1;
    var y = state.year;
    if (m < 1) { m = 12; y -= 1; }
    switchMonth(y, m);
  }

  function goNextMonth() {
    var m = state.month + 1;
    var y = state.year;
    if (m > 12) { m = 1; y += 1; }
    switchMonth(y, m);
  }

  function isViewingCurrentPeriod() {
    return todayStr >= state.periodStart && todayStr <= state.periodEnd;
  }

  // ---------- clock in/out ----------
  function currentTimeStr() {
    var now = new Date();
    return pad2(now.getHours()) + ":" + pad2(now.getMinutes());
  }

  function handleClockIn() {
    if (!state.viewingEmail || !isViewingCurrentPeriod()) return;
    var rec = getRecord(todayStr);
    if (LOCK_AFTER_CLOCK && rec.clockIn) return;
    setRecord(todayStr, { clockIn: currentTimeStr() }).then(render);
  }

  function handleClockOut() {
    if (!state.viewingEmail || !isViewingCurrentPeriod()) return;
    var rec = getRecord(todayStr);
    if (LOCK_AFTER_CLOCK && (!rec.clockIn || rec.clockOut)) return;
    setRecord(todayStr, { clockOut: currentTimeStr() }).then(render);
  }

  function renderClockCard() {
    var viewingCurrent = isViewingCurrentPeriod();
    notTodayNotice.classList.toggle("hidden", viewingCurrent);
    todayLabel.textContent = viewingCurrent
      ? "今日 " + todayStr + "（週" + WEEKDAY_CHARS[today.getDay()] + "）"
      : "";

    if (!viewingCurrent) {
      statusText.textContent = "非本期檢視";
      statusDot.className = "status-dot";
      clockInBtn.disabled = true;
      clockOutBtn.disabled = true;
      return;
    }

    var rec = getRecord(todayStr);
    if (rec.leaveType) {
      statusText.textContent = "今日請假（" + rec.leaveType + "）";
      statusDot.className = "status-dot done";
      clockInBtn.disabled = true;
      clockOutBtn.disabled = true;
    } else if (!rec.clockIn) {
      statusText.textContent = "尚未上班";
      statusDot.className = "status-dot";
      clockInBtn.disabled = false;
      clockOutBtn.disabled = LOCK_AFTER_CLOCK;
    } else if (!rec.clockOut) {
      statusText.textContent = "上班中";
      statusDot.className = "status-dot working";
      clockInBtn.disabled = LOCK_AFTER_CLOCK;
      clockOutBtn.disabled = false;
    } else {
      statusText.textContent = "今日已完成";
      statusDot.className = "status-dot done";
      clockInBtn.disabled = LOCK_AFTER_CLOCK;
      clockOutBtn.disabled = LOCK_AFTER_CLOCK;
    }
  }

  // ---------- table rendering ----------
  function buildLeaveSelect(dateStr, currentValue) {
    var select = document.createElement("select");
    select.className = "leave-select";
    var noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "正常";
    select.appendChild(noneOpt);
    LEAVE_TYPES.forEach(function (lt) {
      var opt = document.createElement("option");
      opt.value = lt;
      opt.textContent = lt;
      select.appendChild(opt);
    });
    select.value = currentValue || "";
    select.addEventListener("change", function () {
      setRecord(dateStr, { leaveType: select.value }).then(render);
    });
    return select;
  }

  function buildTimeInput(dateStr, field, currentValue, disabled) {
    var input = document.createElement("input");
    input.type = "time";
    input.value = currentValue || "";
    input.disabled = !!disabled;
    input.addEventListener("change", function () {
      var patch = {};
      patch[field] = input.value;
      setRecord(dateStr, patch).then(render);
    });
    return input;
  }

  function buildNoteInput(dateStr, currentValue) {
    var input = document.createElement("input");
    input.type = "text";
    input.className = "note-input";
    input.value = currentValue || "";
    input.placeholder = "備註";
    input.addEventListener("change", function () {
      setRecord(dateStr, { note: input.value }).then(render);
    });
    return input;
  }

  function renderTable() {
    recordTbody.innerHTML = "";
    var dates = dateRange(state.periodStart, state.periodEnd);

    var totalHours = 0;
    var attendDays = 0;
    var leaveDays = 0;
    var leaveCounts = {};
    LEAVE_TYPES.forEach(function (lt) { leaveCounts[lt] = 0; });

    for (var i = 0; i < dates.length; i++) {
      var dateStr = dates[i];
      var dateParts = dateStr.split("-").map(Number);
      var dateObj = new Date(dateParts[0], dateParts[1] - 1, dateParts[2]);
      var weekday = WEEKDAY_CHARS[dateObj.getDay()];
      var rec = getRecord(dateStr);
      var calc = calcDay(rec);

      var tr = document.createElement("tr");
      if (dateStr === todayStr) tr.classList.add("today-row");
      if (rec.leaveType) tr.classList.add("leave-row");

      var tdDate = document.createElement("td");
      tdDate.textContent = dateParts[1] + "/" + dateParts[2];
      tr.appendChild(tdDate);

      var tdWeekday = document.createElement("td");
      tdWeekday.textContent = weekday;
      tr.appendChild(tdWeekday);

      var tdIn = document.createElement("td");
      tdIn.appendChild(buildTimeInput(dateStr, "clockIn", rec.clockIn, !!rec.leaveType));
      tr.appendChild(tdIn);

      var tdOut = document.createElement("td");
      tdOut.appendChild(buildTimeInput(dateStr, "clockOut", rec.clockOut, !!rec.leaveType));
      tr.appendChild(tdOut);

      var tdLeave = document.createElement("td");
      tdLeave.appendChild(buildLeaveSelect(dateStr, rec.leaveType));
      tr.appendChild(tdLeave);

      var tdHours = document.createElement("td");
      if (calc.error) {
        tdHours.textContent = "時間錯誤";
      } else {
        tdHours.textContent = calc.hours === null ? "-" : calc.hours.toFixed(2);
      }
      tr.appendChild(tdHours);

      var tdNote = document.createElement("td");
      tdNote.appendChild(buildNoteInput(dateStr, rec.note));
      tr.appendChild(tdNote);

      recordTbody.appendChild(tr);

      if (rec.leaveType) {
        leaveDays++;
        if (leaveCounts[rec.leaveType] !== undefined) leaveCounts[rec.leaveType]++;
      } else if (calc.complete && calc.hours !== null) {
        totalHours += calc.hours;
        attendDays++;
      }
    }

    totalHours = Math.round(totalHours * 100) / 100;
    totalHoursEl.textContent = totalHours.toFixed(2);
    attendDaysEl.textContent = attendDays;
    leaveDaysEl.textContent = leaveDays;

    leaveStatList.innerHTML = "";
    LEAVE_TYPES.forEach(function (lt) {
      var span = document.createElement("span");
      span.innerHTML = lt + "：<span class=\"leave-count\">" + leaveCounts[lt] + "</span> 天";
      leaveStatList.appendChild(span);
    });

    return { totalHours: totalHours, attendDays: attendDays, leaveDays: leaveDays, leaveCounts: leaveCounts };
  }

  // ---------- render ----------
  function render() {
    monthLabel.innerHTML = state.year + " 年 " + state.month + " 月"
      + '<span class="month-range">（' + formatPeriodRange(state.periodStart, state.periodEnd) + '）</span>';
    periodStartInput.value = state.periodStart;
    periodEndInput.value = state.periodEnd;
    periodStartInput.disabled = state.user.role !== "hr";
    periodEndInput.disabled = state.user.role !== "hr";
    supervisorInput.value = state.supervisorName || "";
    buInput.value = state.buName || "";
    renderClockCard();
    renderTable();
  }

  // ---------- PDF export ----------
  function exportPdf() {
    var summary = renderTable(); // ensure freshest numbers

    document.getElementById("printTitle").textContent = "米果計畫 實習生打卡月結表";
    document.getElementById("printName").textContent = "姓名：" + state.viewingName;
    document.getElementById("printBu").textContent = "BU / 部門：" + (state.buName || "＿＿＿＿＿＿＿＿");
    document.getElementById("printSupervisor").textContent = "主管：" + (state.supervisorName || "＿＿＿＿＿＿＿＿");
    document.getElementById("printMonth").textContent = "期間：" + formatPeriodRange(state.periodStart, state.periodEnd);
    document.getElementById("printTotalHours").textContent = "總工時：" + summary.totalHours.toFixed(2) + " 小時";
    document.getElementById("printAttendDays").textContent = "出勤天數：" + summary.attendDays;
    document.getElementById("printLeaveDays").textContent = "請假天數：" + summary.leaveDays;
    document.getElementById("printSupervisorName").textContent = state.supervisorName || " ";

    var printTbody = document.getElementById("printTbody");
    printTbody.innerHTML = "";
    var dates = dateRange(state.periodStart, state.periodEnd);
    for (var i = 0; i < dates.length; i++) {
      var dateStr = dates[i];
      var dateParts = dateStr.split("-").map(Number);
      var dateObj = new Date(dateParts[0], dateParts[1] - 1, dateParts[2]);
      var weekday = WEEKDAY_CHARS[dateObj.getDay()];
      var rec = getRecord(dateStr);
      var calc = calcDay(rec);

      var tr = document.createElement("tr");
      if (rec.leaveType) tr.classList.add("leave-row");
      var cells = [
        dateParts[1] + "/" + dateParts[2],
        weekday,
        rec.clockIn || "-",
        rec.clockOut || "-",
        calc.hours === null ? "-" : calc.hours.toFixed(2),
        rec.leaveType || "-",
        rec.note || ""
      ];
      cells.forEach(function (val) {
        var td = document.createElement("td");
        td.textContent = val;
        tr.appendChild(td);
      });
      printTbody.appendChild(tr);
    }

    var printLeaveStats = document.getElementById("printLeaveStats");
    printLeaveStats.innerHTML = LEAVE_TYPES.map(function (lt) {
      return lt + "：" + summary.leaveCounts[lt] + " 天";
    }).join("　");

    window.print();
  }

  // ---------- init ----------
  internSelect.addEventListener("change", function () {
    setViewingIntern(internSelect.value).then(render);
  });
  prevMonthBtn.addEventListener("click", goPrevMonth);
  nextMonthBtn.addEventListener("click", goNextMonth);
  clockInBtn.addEventListener("click", handleClockIn);
  clockOutBtn.addEventListener("click", handleClockOut);
  exportBtn.addEventListener("click", exportPdf);
  supervisorInput.addEventListener("change", function () {
    state.supervisorName = supervisorInput.value.trim();
    saveCheckinDoc();
  });
  buInput.addEventListener("change", function () {
    state.buName = buInput.value.trim();
    saveCheckinDoc();
  });
  periodStartInput.addEventListener("change", function () {
    if (periodStartInput.value > state.periodEnd) {
      window.alert("起始日不能晚於結束日。");
      periodStartInput.value = state.periodStart;
      return;
    }
    savePeriodOverride(state.year, state.month, "periodStart", periodStartInput.value).then(function () {
      state.periodStart = periodStartInput.value;
      render();
    });
  });
  periodEndInput.addEventListener("change", function () {
    if (periodEndInput.value < state.periodStart) {
      window.alert("結束日不能早於起始日。");
      periodEndInput.value = state.periodEnd;
      return;
    }
    savePeriodOverride(state.year, state.month, "periodEnd", periodEndInput.value).then(function () {
      state.periodEnd = periodEndInput.value;
      render();
    });
  });
})();
