(function () {
  "use strict";

  // TEMP: while true, clock in/out buttons stay clickable even after already
  // used today, so testing isn't blocked. Set back to true to re-lock once
  // testing is done.
  var LOCK_AFTER_CLOCK = false;

  var LEAVE_TYPES = ["病假", "事假", "公假", "其他"];
  var WEEKDAY_CHARS = ["日", "一", "二", "三", "四", "五", "六"];

  var NAMES_KEY = "mius_names";
  var LAST_NAME_KEY = "mius_lastName";
  var LAST_MONTH_KEY = "mius_lastMonth";

  // ---------- state ----------
  var state = {
    name: "",
    year: 0,
    month: 0, // 1-12
    records: {}, // dateStr -> {clockIn, clockOut, leaveType, note}
    supervisorName: "", // varies by month: HR supervisor at first, then per-BU supervisor later
    buName: "" // e.g. "MESH+ / 媒體傳播部", set once assigned to a BU
  };

  var today = new Date();
  var todayStr = formatDate(today);

  // ---------- helpers ----------
  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  function formatDate(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function yyyyMM(year, month) {
    return year + "-" + pad2(month);
  }

  function daysInMonth(year, month) {
    return new Date(year, month, 0).getDate();
  }

  function recordsKey(name, year, month) {
    return "mius_records_" + name + "_" + yyyyMM(year, month);
  }

  function supervisorKey(name, year, month) {
    return "mius_supervisor_" + name + "_" + yyyyMM(year, month);
  }

  function buKey(name, year, month) {
    return "mius_bu_" + name + "_" + yyyyMM(year, month);
  }

  function loadNames() {
    try {
      return JSON.parse(localStorage.getItem(NAMES_KEY) || "[]");
    } catch (e) {
      return [];
    }
  }

  function saveNames(names) {
    localStorage.setItem(NAMES_KEY, JSON.stringify(names));
  }

  function loadRecords(name, year, month) {
    try {
      return JSON.parse(localStorage.getItem(recordsKey(name, year, month)) || "{}");
    } catch (e) {
      return {};
    }
  }

  function saveRecords() {
    if (!state.name) return;
    localStorage.setItem(recordsKey(state.name, state.year, state.month), JSON.stringify(state.records));
  }

  // Looks back up to 24 months for the most recent saved value, and carries it
  // forward into the requested month — BU/supervisor rarely change monthly,
  // so interns shouldn't have to retype them every month.
  function loadWithCarryForward(keyFn, name, year, month) {
    var direct = localStorage.getItem(keyFn(name, year, month));
    if (direct) return direct;

    var y = year, m = month;
    for (var i = 0; i < 24; i++) {
      m -= 1;
      if (m < 1) { m = 12; y -= 1; }
      var prev = localStorage.getItem(keyFn(name, y, m));
      if (prev) {
        localStorage.setItem(keyFn(name, year, month), prev);
        return prev;
      }
    }
    return "";
  }

  function loadSupervisor(name, year, month) {
    return loadWithCarryForward(supervisorKey, name, year, month);
  }

  function saveSupervisor() {
    if (!state.name) return;
    localStorage.setItem(supervisorKey(state.name, state.year, state.month), state.supervisorName || "");
  }

  function loadBu(name, year, month) {
    return loadWithCarryForward(buKey, name, year, month);
  }

  function saveBu() {
    if (!state.name) return;
    localStorage.setItem(buKey(state.name, state.year, state.month), state.buName || "");
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
    // drop empty records to keep storage tidy
    if (!updated.clockIn && !updated.clockOut && !updated.leaveType && !updated.note) {
      delete state.records[dateStr];
    } else {
      state.records[dateStr] = updated;
    }
    saveRecords();
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
  var nameSelect = document.getElementById("nameSelect");
  var addNameBtn = document.getElementById("addNameBtn");
  var prevMonthBtn = document.getElementById("prevMonthBtn");
  var nextMonthBtn = document.getElementById("nextMonthBtn");
  var monthLabel = document.getElementById("monthLabel");
  var supervisorInput = document.getElementById("supervisorInput");
  var buInput = document.getElementById("buInput");

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

  // ---------- name management ----------
  function populateNameSelect() {
    var names = loadNames();
    nameSelect.innerHTML = "";
    if (names.length === 0) {
      var opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "尚無姓名，請點右側新增";
      nameSelect.appendChild(opt);
      return;
    }
    names.forEach(function (n) {
      var opt = document.createElement("option");
      opt.value = n;
      opt.textContent = n;
      nameSelect.appendChild(opt);
    });
  }

  function addName() {
    var name = window.prompt("請輸入實習生姓名：");
    if (!name) return;
    name = name.trim();
    if (!name) return;
    var names = loadNames();
    if (names.indexOf(name) === -1) {
      names.push(name);
      saveNames(names);
    }
    populateNameSelect();
    nameSelect.value = name;
    switchName(name);
  }

  function switchName(name) {
    state.name = name;
    localStorage.setItem(LAST_NAME_KEY, name);
    state.records = loadRecords(state.name, state.year, state.month);
    state.supervisorName = loadSupervisor(state.name, state.year, state.month);
    state.buName = loadBu(state.name, state.year, state.month);
    render();
  }

  // ---------- month management ----------
  function switchMonth(year, month) {
    state.year = year;
    state.month = month;
    localStorage.setItem(LAST_MONTH_KEY, yyyyMM(year, month));
    if (state.name) {
      state.records = loadRecords(state.name, state.year, state.month);
      state.supervisorName = loadSupervisor(state.name, state.year, state.month);
      state.buName = loadBu(state.name, state.year, state.month);
    }
    render();
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

  function isViewingCurrentMonth() {
    return state.year === today.getFullYear() && state.month === (today.getMonth() + 1);
  }

  // ---------- clock in/out ----------
  function currentTimeStr() {
    var now = new Date();
    return pad2(now.getHours()) + ":" + pad2(now.getMinutes());
  }

  function handleClockIn() {
    if (!state.name || !isViewingCurrentMonth()) return;
    var rec = getRecord(todayStr);
    if (LOCK_AFTER_CLOCK && rec.clockIn) return;
    setRecord(todayStr, { clockIn: currentTimeStr() });
    render();
  }

  function handleClockOut() {
    if (!state.name || !isViewingCurrentMonth()) return;
    var rec = getRecord(todayStr);
    if (LOCK_AFTER_CLOCK && (!rec.clockIn || rec.clockOut)) return;
    setRecord(todayStr, { clockOut: currentTimeStr() });
    render();
  }

  function renderClockCard() {
    var viewingCurrent = isViewingCurrentMonth();
    notTodayNotice.classList.toggle("hidden", viewingCurrent);
    todayLabel.textContent = viewingCurrent
      ? "今日 " + todayStr + "（週" + WEEKDAY_CHARS[today.getDay()] + "）"
      : "";

    if (!state.name) {
      statusText.textContent = "請先選擇姓名";
      statusDot.className = "status-dot";
      clockInBtn.disabled = true;
      clockOutBtn.disabled = true;
      return;
    }

    if (!viewingCurrent) {
      statusText.textContent = "非本月檢視";
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
      setRecord(dateStr, { leaveType: select.value });
      render();
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
      setRecord(dateStr, patch);
      render();
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
      setRecord(dateStr, { note: input.value });
      render();
    });
    return input;
  }

  function renderTable() {
    recordTbody.innerHTML = "";
    var total = daysInMonth(state.year, state.month);

    var totalHours = 0;
    var attendDays = 0;
    var leaveDays = 0;
    var leaveCounts = {};
    LEAVE_TYPES.forEach(function (lt) { leaveCounts[lt] = 0; });

    for (var d = 1; d <= total; d++) {
      var dateObj = new Date(state.year, state.month - 1, d);
      var dateStr = formatDate(dateObj);
      var weekday = WEEKDAY_CHARS[dateObj.getDay()];
      var rec = getRecord(dateStr);
      var calc = calcDay(rec);

      var tr = document.createElement("tr");
      if (dateStr === todayStr) tr.classList.add("today-row");
      if (rec.leaveType) tr.classList.add("leave-row");

      var tdDate = document.createElement("td");
      tdDate.textContent = state.month + "/" + d;
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

      var tdLunch = document.createElement("td");
      tdLunch.textContent = calc.lunch === null ? "-" : calc.lunch + " 小時";
      tr.appendChild(tdLunch);

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
    monthLabel.textContent = state.year + " 年 " + state.month + " 月";
    supervisorInput.value = state.supervisorName || "";
    supervisorInput.disabled = !state.name;
    buInput.value = state.buName || "";
    buInput.disabled = !state.name;
    renderClockCard();
    if (!state.name) {
      recordTbody.innerHTML = "";
      totalHoursEl.textContent = "0.00";
      attendDaysEl.textContent = "0";
      leaveDaysEl.textContent = "0";
      leaveStatList.innerHTML = "";
      return;
    }
    renderTable();
  }

  // ---------- PDF export ----------
  function exportPdf() {
    if (!state.name) {
      window.alert("請先選擇姓名再匯出。");
      return;
    }
    var summary = renderTable(); // ensure freshest numbers

    document.getElementById("printTitle").textContent = "米果計畫 實習生打卡月結表";
    document.getElementById("printName").textContent = "姓名：" + state.name;
    document.getElementById("printBu").textContent = state.buName ? ("BU / 部門：" + state.buName) : "";
    document.getElementById("printSupervisor").textContent = state.supervisorName ? ("主管：" + state.supervisorName) : "";
    document.getElementById("printMonth").textContent = "月份：" + state.year + " 年 " + state.month + " 月";
    document.getElementById("printTotalHours").textContent = "總工時：" + summary.totalHours.toFixed(2) + " 小時";
    document.getElementById("printAttendDays").textContent = "出勤天數：" + summary.attendDays;
    document.getElementById("printLeaveDays").textContent = "請假天數：" + summary.leaveDays;
    document.getElementById("printSupervisorName").textContent = state.supervisorName || " ";

    var printTbody = document.getElementById("printTbody");
    printTbody.innerHTML = "";
    var total = daysInMonth(state.year, state.month);
    for (var d = 1; d <= total; d++) {
      var dateObj = new Date(state.year, state.month - 1, d);
      var dateStr = formatDate(dateObj);
      var weekday = WEEKDAY_CHARS[dateObj.getDay()];
      var rec = getRecord(dateStr);
      var calc = calcDay(rec);

      var tr = document.createElement("tr");
      var cells = [
        state.month + "/" + d,
        weekday,
        rec.clockIn || "-",
        rec.clockOut || "-",
        calc.lunch === null ? "-" : calc.lunch + " 小時",
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
  function init() {
    var names = loadNames();
    populateNameSelect();

    var lastName = localStorage.getItem(LAST_NAME_KEY);
    var initialName = (lastName && names.indexOf(lastName) !== -1) ? lastName : (names[0] || "");

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
    state.name = initialName;
    if (initialName) {
      nameSelect.value = initialName;
      state.records = loadRecords(initialName, y, m);
      state.supervisorName = loadSupervisor(initialName, y, m);
      state.buName = loadBu(initialName, y, m);
    }

    render();

    nameSelect.addEventListener("change", function () {
      switchName(nameSelect.value);
    });
    addNameBtn.addEventListener("click", addName);
    prevMonthBtn.addEventListener("click", goPrevMonth);
    nextMonthBtn.addEventListener("click", goNextMonth);
    clockInBtn.addEventListener("click", handleClockIn);
    clockOutBtn.addEventListener("click", handleClockOut);
    exportBtn.addEventListener("click", exportPdf);
    supervisorInput.addEventListener("change", function () {
      state.supervisorName = supervisorInput.value.trim();
      saveSupervisor();
    });
    buInput.addEventListener("change", function () {
      state.buName = buInput.value.trim();
      saveBu();
    });
  }

  init();
})();
