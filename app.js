(function () {
  "use strict";

  var FIREBASE_CONFIG = {
    apiKey: "AIzaSyAkdX6kh-147M86sF39jB6H8UDzKpVjjbA",
    authDomain: "mego-checkin.firebaseapp.com",
    projectId: "mego-checkin",
    storageBucket: "mego-checkin.firebasestorage.app",
    messagingSenderId: "853475583238",
    appId: "1:853475583238:web:a7f76a8c6a6232ed236a87"
  };

  // Once clocked in/out for the day, the corresponding button locks so it
  // can't be pressed again; corrections after that go through the table.
  var LOCK_AFTER_CLOCK = true;

  var WEEKDAY_CHARS = ["日", "一", "二", "三", "四", "五", "六"];

  // Fixed lunch break: a shift that spans the whole window gets 1hr deducted.
  var LUNCH_START_MIN = 12 * 60 + 30;
  var LUNCH_END_MIN = 13 * 60 + 30;

  var LAST_MONTH_KEY = "mius_lastMonth";
  var LAST_INTERN_KEY = "mius_lastInternEmail";

  firebase.initializeApp(FIREBASE_CONFIG);
  var auth = firebase.auth();
  var db = firebase.firestore();

  // ---------- state ----------
  var state = {
    user: null, // {email, name, role}
    interns: [], // [{email, name}] — HR only, intern-role users for the viewer dropdown
    allUsers: [], // [{email, name, role}] — HR only, full whitelist for the admin panel
    viewingEmail: "",
    viewingName: "",
    year: 0,
    month: 0, // 1-12
    periodStart: "",
    periodEnd: "",
    records: {}, // dateStr -> {clockIn, clockOut, hoursOverride, note}
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
  // month (submission deadline is the 24th). Each intern's period is stored
  // on their own checkins doc, so one person adjusting it never affects
  // anyone else's view of the same month.
  function defaultPeriodEnd(year, month) {
    return year + "-" + pad2(month) + "-24";
  }

  // ---------- checkins doc ----------
  function checkinDocId(email, year, month) {
    return email + "_" + yyyyMM(year, month);
  }

  function emptyCheckinData(email, name) {
    return { internEmail: email, name: name, buName: "", supervisorName: "", periodStart: "", periodEnd: "", records: {} };
  }

  function fetchCheckinDoc(email, year, month) {
    return db.collection("checkins").doc(checkinDocId(email, year, month)).get()
      .then(function (doc) { return doc.exists ? doc.data() : null; });
  }

  function loadCheckinDoc(email, name, year, month) {
    return fetchCheckinDoc(email, year, month).then(function (data) {
      return data || emptyCheckinData(email, name);
    });
  }

  function resolvePeriodEnd(docData, year, month) {
    return (docData && docData.periodEnd) || defaultPeriodEnd(year, month);
  }

  function resolvePeriodStart(email, docData, year, month) {
    if (docData && docData.periodStart) return Promise.resolve(docData.periodStart);
    var py = month === 1 ? year - 1 : year;
    var pm = month === 1 ? 12 : month - 1;
    return fetchCheckinDoc(email, py, pm).then(function (prevDoc) {
      var prevEnd = resolvePeriodEnd(prevDoc, py, pm);
      return addDaysISO(prevEnd, 1);
    });
  }

  function resolvePeriod(email, docData, year, month) {
    return resolvePeriodStart(email, docData, year, month).then(function (start) {
      return { start: start, end: resolvePeriodEnd(docData, year, month) };
    });
  }

  function saveCheckinDoc() {
    var data = {
      internEmail: state.viewingEmail,
      name: state.viewingName,
      buName: state.buName || "",
      supervisorName: state.supervisorName || "",
      periodStart: state.periodStart || "",
      periodEnd: state.periodEnd || "",
      records: state.records
    };
    return db.collection("checkins").doc(checkinDocId(state.viewingEmail, state.year, state.month)).set(data);
  }

  function getRecord(dateStr) {
    return state.records[dateStr] || { clockIn: "", clockOut: "", hoursOverride: null, note: "" };
  }

  function setRecord(dateStr, patch) {
    var rec = getRecord(dateStr);
    var updated = {};
    updated.clockIn = patch.clockIn !== undefined ? patch.clockIn : rec.clockIn;
    updated.clockOut = patch.clockOut !== undefined ? patch.clockOut : rec.clockOut;
    updated.note = patch.note !== undefined ? patch.note : rec.note;
    if (patch.hoursOverride !== undefined) {
      // Editing the 工時 cell directly overrides the computed value.
      updated.hoursOverride = patch.hoursOverride;
    } else if (patch.clockIn !== undefined || patch.clockOut !== undefined) {
      // Editing the clock times always falls back to the computed value.
      updated.hoursOverride = null;
    } else {
      updated.hoursOverride = rec.hoursOverride;
    }
    if (!updated.clockIn && !updated.clockOut && !updated.hoursOverride && !updated.note) {
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

  // Core work-hour rule: hours = (clockOut - clockIn) - lunch deduction.
  // Lunch deduction: shift spans the whole 12:30-13:30 window -> deduct 1hr;
  // otherwise no deduction.
  // From the November period onward (BU assignment), hours are floored to
  // whole numbers instead of kept as decimals — see chat 2026-11 policy change.
  function isWholeHourPeriod(year, month) {
    return year > 2026 || (year === 2026 && month >= 11);
  }

  function calcDay(rec, wholeHour) {
    if (rec.hoursOverride !== null && rec.hoursOverride !== undefined && rec.hoursOverride !== "") {
      return { hours: Number(rec.hoursOverride), complete: true, overridden: true };
    }
    var inMin = timeToMinutes(rec.clockIn);
    var outMin = timeToMinutes(rec.clockOut);
    if (inMin === null || outMin === null) {
      return { hours: null, complete: false };
    }
    var durationMin = outMin - inMin;
    if (durationMin <= 0) {
      return { hours: null, complete: false, error: true };
    }
    var spansLunch = inMin <= LUNCH_START_MIN && outMin >= LUNCH_END_MIN;
    var netMin = durationMin - (spansLunch ? 60 : 0);
    var hours = Math.max(netMin / 60, 0);
    hours = wholeHour ? Math.floor(hours) : Math.round(hours * 100) / 100;
    return { hours: hours, complete: true };
  }

  function formatHours(hours, wholeHour) {
    return wholeHour ? String(hours) : hours.toFixed(1);
  }

  // ---------- DOM refs ----------
  var loginScreen = document.getElementById("loginScreen");
  var appRoot = document.getElementById("appRoot");
  var googleLoginBtn = document.getElementById("googleLoginBtn");
  var loginError = document.getElementById("loginError");
  var logoutBtn = document.getElementById("logoutBtn");
  var userBadge = document.getElementById("userBadge");
  var manageInternsBtn = document.getElementById("manageInternsBtn");
  var manageInternsOverlay = document.getElementById("manageInternsOverlay");
  var closeManageInternsBtn = document.getElementById("closeManageInternsBtn");
  var internListManage = document.getElementById("internListManage");
  var newInternName = document.getElementById("newInternName");
  var newInternEmail = document.getElementById("newInternEmail");
  var newInternRole = document.getElementById("newInternRole");
  var addInternBtn = document.getElementById("addInternBtn");

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

  var recordTbody = document.getElementById("recordTbody");
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
      manageInternsBtn.classList.remove("hidden");
      setupPromise = loadAllUsers().then(function () {
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

  function loadAllUsers() {
    return db.collection("checkinUsers").get().then(function (snap) {
      var all = snap.docs.map(function (d) {
        return { email: d.id, name: d.data().name, role: d.data().role };
      });
      state.allUsers = all;
      state.interns = all.filter(function (u) { return u.role !== "hr"; });
      populateInternSelect();
      renderInternManageList();
    });
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

  // ---------- HR: manage login whitelist (interns + HR) ----------
  function renderInternManageList() {
    internListManage.innerHTML = "";
    if (state.allUsers.length === 0) {
      var empty = document.createElement("p");
      empty.className = "notice-inline";
      empty.textContent = "目前沒有任何帳號。";
      internListManage.appendChild(empty);
      return;
    }
    state.allUsers.forEach(function (u) {
      var row = document.createElement("div");
      row.className = "intern-manage-row";

      var avatar = document.createElement("span");
      avatar.className = "intern-avatar";
      avatar.textContent = u.name.charAt(0);

      var info = document.createElement("div");
      info.className = "intern-info";
      var nameSpan = document.createElement("span");
      nameSpan.className = "intern-name";
      nameSpan.textContent = u.name;
      var roleTag = document.createElement("span");
      roleTag.className = "role-tag";
      roleTag.textContent = u.role === "hr" ? "HR" : "實習生";
      nameSpan.appendChild(roleTag);
      var emailSpan = document.createElement("span");
      emailSpan.className = "intern-email";
      emailSpan.textContent = u.email;
      info.appendChild(nameSpan);
      info.appendChild(emailSpan);

      var delBtn = document.createElement("button");
      delBtn.className = "btn-danger";
      delBtn.type = "button";
      delBtn.title = "刪除";
      delBtn.setAttribute("aria-label", "刪除" + u.name);
      delBtn.textContent = "×";
      delBtn.addEventListener("click", function () {
        var confirmMsg = "確定要刪除「" + u.name + "」的登入權限嗎？（已產生的打卡紀錄不會被刪除）";
        if (u.email === state.user.email) {
          confirmMsg = "這是您自己目前登入的帳號，刪除後會立刻失去存取權限。確定要刪除嗎？";
        }
        if (!window.confirm(confirmMsg)) return;
        db.collection("checkinUsers").doc(u.email).delete().then(function () {
          return loadAllUsers();
        }).then(function () {
          if (state.viewingEmail === u.email) {
            var nextEmail = state.interns[0] ? state.interns[0].email : "";
            internSelect.value = nextEmail;
            return setViewingIntern(nextEmail).then(render);
          }
        }).catch(function (err) {
          console.error("delete user error:", err);
          window.alert("刪除失敗，請稍後再試。");
        });
      });

      row.appendChild(avatar);
      row.appendChild(info);
      row.appendChild(delBtn);
      internListManage.appendChild(row);
    });
  }

  manageInternsBtn.addEventListener("click", function () {
    manageInternsOverlay.classList.remove("hidden");
  });
  closeManageInternsBtn.addEventListener("click", function () {
    manageInternsOverlay.classList.add("hidden");
  });
  addInternBtn.addEventListener("click", function () {
    var name = newInternName.value.trim();
    var email = newInternEmail.value.trim().toLowerCase();
    if (!name || !email) {
      window.alert("請填寫姓名與 email。");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      window.alert("email 格式不正確。");
      return;
    }
    var role = newInternRole.value;
    db.collection("checkinUsers").doc(email).get().then(function (doc) {
      if (doc.exists) {
        throw new Error("ALREADY_EXISTS:" + doc.data().name + ":" + doc.data().role);
      }
      return db.collection("checkinUsers").doc(email).set({ name: name, role: role });
    }).then(function () {
      newInternName.value = "";
      newInternEmail.value = "";
      newInternRole.value = "intern";
      return loadAllUsers();
    }).catch(function (err) {
      if (("" + err.message).indexOf("ALREADY_EXISTS:") === 0) {
        var parts = err.message.split(":");
        window.alert("這個 email 已經存在名單中（" + parts[1] + "／" + (parts[2] === "hr" ? "HR" : "實習生") + "），請確認後再試。");
        return;
      }
      console.error("add intern error:", err);
      window.alert("新增失敗，請稍後再試。");
    });
  });

  function setViewingIntern(email) {
    var intern = state.interns.find(function (i) { return i.email === email; });
    state.viewingEmail = email;
    state.viewingName = intern ? intern.name : state.user.name;
    if (state.user.role === "hr") localStorage.setItem(LAST_INTERN_KEY, email);
    return refreshMonthData();
  }

  function refreshMonthData() {
    if (!state.viewingEmail) return Promise.resolve();
    return loadCheckinDoc(state.viewingEmail, state.viewingName, state.year, state.month)
      .then(function (doc) {
        state.records = doc.records || {};
        state.buName = doc.buName || "";
        state.supervisorName = doc.supervisorName || "";
        return resolvePeriod(state.viewingEmail, doc, state.year, state.month);
      }).then(function (period) {
        state.periodStart = period.start;
        state.periodEnd = period.end;
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
    if (!rec.clockIn) {
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
  function buildTimeInput(dateStr, field, currentValue) {
    var input = document.createElement("input");
    input.type = "time";
    input.value = currentValue || "";
    input.addEventListener("change", function () {
      var patch = {};
      patch[field] = input.value;
      setRecord(dateStr, patch).then(render);
    });
    return input;
  }

  function buildHoursInput(dateStr, calc) {
    var input = document.createElement("input");
    input.type = "number";
    input.step = "0.1";
    input.min = "0";
    input.className = "hours-input";
    input.value = calc.hours === null ? "" : calc.hours;
    input.placeholder = "-";
    input.addEventListener("change", function () {
      var val = input.value === "" ? null : input.value;
      setRecord(dateStr, { hoursOverride: val }).then(render);
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
    var wholeHour = isWholeHourPeriod(state.year, state.month);

    var totalHours = 0;

    for (var i = 0; i < dates.length; i++) {
      var dateStr = dates[i];
      var dateParts = dateStr.split("-").map(Number);
      var dateObj = new Date(dateParts[0], dateParts[1] - 1, dateParts[2]);
      var weekday = WEEKDAY_CHARS[dateObj.getDay()];
      var rec = getRecord(dateStr);
      var calc = calcDay(rec, wholeHour);

      var tr = document.createElement("tr");
      if (dateStr === todayStr) tr.classList.add("today-row");

      var tdDate = document.createElement("td");
      tdDate.textContent = dateParts[1] + "/" + dateParts[2];
      tr.appendChild(tdDate);

      var tdWeekday = document.createElement("td");
      tdWeekday.textContent = weekday;
      tr.appendChild(tdWeekday);

      var tdIn = document.createElement("td");
      tdIn.appendChild(buildTimeInput(dateStr, "clockIn", rec.clockIn));
      tr.appendChild(tdIn);

      var tdOut = document.createElement("td");
      tdOut.appendChild(buildTimeInput(dateStr, "clockOut", rec.clockOut));
      tr.appendChild(tdOut);

      var tdHours = document.createElement("td");
      tdHours.appendChild(buildHoursInput(dateStr, calc));
      tr.appendChild(tdHours);

      var tdNote = document.createElement("td");
      tdNote.appendChild(buildNoteInput(dateStr, rec.note));
      tr.appendChild(tdNote);

      recordTbody.appendChild(tr);

      if (calc.hours !== null) {
        totalHours += calc.hours;
      }
    }

    totalHours = wholeHour ? totalHours : Math.round(totalHours * 100) / 100;
    totalHoursEl.textContent = formatHours(totalHours, wholeHour);

    return { totalHours: totalHours };
  }

  // ---------- render ----------
  function render() {
    monthLabel.innerHTML = state.year + " 年 " + state.month + " 月"
      + '<span class="month-range">（' + formatPeriodRange(state.periodStart, state.periodEnd) + '）</span>';
    periodStartInput.value = state.periodStart;
    periodEndInput.value = state.periodEnd;
    supervisorInput.value = state.supervisorName || "";
    buInput.value = state.buName || "";
    renderClockCard();
    renderTable();
  }

  // ---------- PDF export ----------
  function exportPdf() {
    var summary = renderTable(); // ensure freshest numbers
    var wholeHour = isWholeHourPeriod(state.year, state.month);

    document.getElementById("printTitle").textContent = "實習生每月時數表";
    document.getElementById("printName").textContent = "姓名：" + state.viewingName;
    document.getElementById("printBu").textContent = "BU / 部門：" + (state.buName || "＿＿＿＿＿＿＿＿");
    document.getElementById("printSupervisor").textContent = "主管：" + (state.supervisorName || "＿＿＿＿＿＿＿＿");
    document.getElementById("printMonth").textContent = "期間：" + formatPeriodRange(state.periodStart, state.periodEnd);
    document.getElementById("printTotalHours").textContent = "總工時：" + formatHours(summary.totalHours, wholeHour) + " 小時";

    var printTbody = document.getElementById("printTbody");
    printTbody.innerHTML = "";
    var dates = dateRange(state.periodStart, state.periodEnd);
    for (var i = 0; i < dates.length; i++) {
      var dateStr = dates[i];
      var dateParts = dateStr.split("-").map(Number);
      var dateObj = new Date(dateParts[0], dateParts[1] - 1, dateParts[2]);
      var weekday = WEEKDAY_CHARS[dateObj.getDay()];
      var rec = getRecord(dateStr);
      var calc = calcDay(rec, wholeHour);

      var tr = document.createElement("tr");
      var cells = [
        dateParts[1] + "/" + dateParts[2],
        weekday,
        rec.clockIn || "-",
        rec.clockOut || "-",
        calc.hours === null ? "-" : formatHours(calc.hours, wholeHour),
        rec.note || ""
      ];
      cells.forEach(function (val) {
        var td = document.createElement("td");
        td.textContent = val;
        tr.appendChild(td);
      });
      printTbody.appendChild(tr);
    }

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
    state.periodStart = periodStartInput.value;
    saveCheckinDoc().then(render);
  });
  periodEndInput.addEventListener("change", function () {
    if (periodEndInput.value < state.periodStart) {
      window.alert("結束日不能早於起始日。");
      periodEndInput.value = state.periodEnd;
      return;
    }
    state.periodEnd = periodEndInput.value;
    saveCheckinDoc().then(render);
  });
})();
