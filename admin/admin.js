/* 클라비어 운영실 — 원생 명부 · 시간표 현황 · 신규 등록 · 퇴원/휴원 · 통계 · 노션 가져오기
   자료: students/{id}, slots/{mon-1300 …}. 관리자 로그인 뒤에만 읽고 쓸 수 있습니다(firestore.rules). */
(function () {
  "use strict";
  var DAYS = [["mon", "월"], ["tue", "화"], ["wed", "수"], ["thu", "목"], ["fri", "금"]];
  var TIMES = []; for (var hh = 13; hh <= 19; hh++) { TIMES.push(hh + ":00"); if (hh < 19) TIMES.push(hh + ":30"); }
  var GRADES = ["6세", "7세", "초1", "초2", "초3", "초4", "초5", "초6", "중1", "중2", "중3", "고1", "고2", "고3", "성인"];
  var BOOKS = ["바이엘1", "바이엘2", "바이엘3", "바이엘4", "체르니100", "체르니30", "체르니40", "작품반"];
  var SCHOOLS = ["가득유치원", "새롬유치원", "새롬초", "가득초", "새뜸초", "새롬중", "새뜸중", "새롬고", "기타"];
  var CONSENTS = ["사진·영상 사용", "외벽 이름 게시", "얼굴 노출"];
  var SOURCES = ["재원생 소개", "지인 소개", "네이버 검색·플레이스", "맘카페", "블로그", "인스타그램", "간판·외벽", "이사 와서 찾음", "기타"];
  var WATCH = ["연습 횟수 감소", "같은 곡 3주 이상", "평가 하락", "결석·지각 증가", "다른 학원 시간 언급", "이탈 구간 학년", "형제 퇴원", "친구들과 마찰", "수업 태도 불량"];
  var LEAVE = ["다른 학원 시간", "흥미 저하", "난이도·악보", "비용", "이사", "다른 피아노 학원", "기타"];
  var FEES = { "초급": [110000, 120000, 130000, 140000, 150000], "중급": [120000, 130000, 140000, 150000, 160000], "고급": [130000, 140000, 150000, 160000, 170000] };
  var DOMAIN = "@klavier.admin";

  var db, auth, students = [], slots = {}, unsubs = [], route = location.hash === "#new-notice" ? { name: "notice" } : { name: "home" }, filters = {};
  var survey = null, subs = [], desk = {}, subsRound = null, subsUnsub = [], notices = [], awards = [], ledger = [], lgMonth = "", lgCarry = false, svTab = "order";
  if (location.hash === "#new-notice") try { history.replaceState(null, "", location.pathname); } catch (e) {}
  var view = document.getElementById("view");

  /* ── 작은 도구 ── */
  function h(tag, attrs) {
    var el = document.createElement(tag), i, k;
    if (attrs) for (k in attrs) {
      if (k === "class") el.className = attrs[k];
      else if (k === "text") el.textContent = attrs[k];
      else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] === true) el.setAttribute(k, "");
      else if (attrs[k] !== false && attrs[k] != null) el.setAttribute(k, attrs[k]);
    }
    for (i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) el.appendChild(typeof x === "string" ? document.createTextNode(x) : x); });
      else el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    }
    return el;
  }
  function won(n) { return n == null ? "확인 필요" : Number(n).toLocaleString("ko-KR"); }
  function today() { var d = new Date(); return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2); }
  function slotId(d, t) { return d + "-" + t.replace(":", ""); }
  function slotName(id) { var p = id.split("-"), d = DAYS.filter(function (x) { return x[0] === p[0]; })[0]; return (d ? d[1] : p[0]) + " " + p[1].slice(0, 2) + ":" + p[1].slice(2); }
  function slotOrder(id) { var p = id.split("-"); return DAYS.map(function (x) { return x[0]; }).indexOf(p[0]) * 10000 + Number(p[1]); }
  function sortSlots(a) { return (a || []).slice().sort(function (x, y) { return slotOrder(x) - slotOrder(y); }); }

  /* ── 계산 값 (노션 수식 대신) ── */
  function schoolYear(d) { d = d || new Date(); return d.getMonth() >= 2 ? d.getFullYear() : d.getFullYear() - 1; } // 3월에 학년이 바뀝니다 [확인 필요]
  function grade(s) {
    var i = GRADES.indexOf(s.gradeInput);
    if (i < 0) return s.gradeInput || "";
    if (s.gradeInput === "성인") return "성인";
    var up = schoolYear() - (s.gradeYear || schoolYear());
    return GRADES[Math.min(GRADES.length - 1, Math.max(0, i + up))];
  }
  function gradeOrder(s) { var i = GRADES.indexOf(grade(s)); return i < 0 ? 99 : i; }
  function stage(s) { var b = s.book || ""; return !b ? "" : b.indexOf("바이엘") === 0 ? "초급" : (b === "체르니100" || b === "체르니30") ? "중급" : "고급"; }
  function ruleFee(s) { var row = FEES[stage(s)], n = Number(s.weeklyCount); return row && n >= 1 && n <= row.length ? row[n - 1] : null; }
  function fee(s) {
    if (Number(s.fee) > 0) return Number(s.fee);
    if (Number(s.feeException) > 0) return Number(s.feeException);
    return ruleFee(s);
  }
  function months(s) {
    if (!s.enrolledOn) return null;
    var a = new Date(s.enrolledOn), b = s.leftOn ? new Date(s.leftOn) : new Date();
    return Math.max(0, (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth());
  }
  function active() { return students.filter(function (s) { return s.status === "재원"; }); }
  function inSlot(id) { return active().filter(function (s) { return (s.slots || []).indexOf(id) >= 0; }).sort(byName); }
  function cap(id) { return (slots[id] && slots[id].capacity) || 10; }
  function byName(a, b) { return (a.name || "").localeCompare(b.name || "", "ko"); }

  /* ── 화면 전환 ── */
  function go(name, arg) { route = { name: name, arg: arg }; window.scrollTo(0, 0); render(); }
  function page(title, sub) {
    view.innerHTML = "";
    if (route.name !== "home") view.appendChild(h("button", { class: "btn", type: "button", onclick: function () { go(route.back || "home"); }, style: "margin-bottom:14px" }, "← 돌아가기"));
    view.appendChild(h("h1", { text: title }));
    if (sub) view.appendChild(h("p", { class: "sub", text: sub }));
  }
  function render() {
    var r = { home: home, timetable: timetable, slot: slotDetail, roster: roster, student: studentForm, add: studentForm, gone: gone, stats: stats, importer: importer, survey: surveyView, notices: noticeList, notice: noticeForm, awards: awardList, award: awardForm, ledger: ledgerView, entry: entryForm }[route.name] || home;
    r(route.arg);
  }

  /* ── 로그인 ── */
  function login(msg) {
    view.innerHTML = "";
    var id = h("input", { type: "text", id: "login-id", autocomplete: "username", autocapitalize: "none" });
    var pw = h("input", { type: "password", id: "login-pw", autocomplete: "current-password" });
    var m = h("p", { class: "msg bad", text: msg || "" });
    var f = h("form", { class: "login", onsubmit: function (e) {
      e.preventDefault(); m.textContent = "확인하는 중입니다."; m.className = "msg";
      var v = id.value.trim(), email = v.indexOf("@") > 0 ? v : v + DOMAIN;
      auth.signInWithEmailAndPassword(email, pw.value).catch(function () { m.className = "msg bad"; m.textContent = "아이디 또는 비밀번호가 맞지 않습니다."; });
    } },
      h("h1", { text: "운영실 로그인" }),
      h("label", null, "아이디", id), h("label", null, "비밀번호", pw),
      h("button", { class: "btn pri", type: "submit" }, "로그인"), m);
    view.appendChild(f);
  }

  /* ── 홈 ── */
  function home() {
    page("세종 클라비어 음악학원", "재원 " + active().length + "명");
    function tile(name, desc, to, off) { return h("button", { class: "tile", type: "button", disabled: !!off, onclick: function () { go(to); } }, h("b", { text: name }), h("span", { text: desc })); }
    view.appendChild(h("div", { class: "cap", text: "매일" }));
    view.appendChild(h("div", { class: "tiles" },
      tile("시간표 현황", "요일·시간마다 아이 이름과 인원", "timetable"),
      tile("원생 명부", "재원생 " + active().length + "명 · 수정, 퇴원·휴원 처리", "roster"),
      tile("신규 등록", "등록이 확정된 아이 입력", "add")));
    view.appendChild(h("div", { class: "cap", text: "필요할 때" }));
    view.appendChild(h("div", { class: "tiles" },
      tile("통계 · 월말 점검", "등록·퇴원 추이, 경로, 주의 원생", "stats"),
      tile("퇴원 · 휴원생", "그만둔 아이, 쉬는 아이 기록", "gone"),
      tile("시간표 신청", surveyState().text + (survey && survey.round ? " · 접수 " + subs.length + "건" : ""), "survey"),
      tile("이달의 클라비어", "매달 상 받은 아이 기록 · " + awards.length + "건", "awards"),
      tile("현금출납부", "수강료 수입·지출 기록, 인쇄 · " + ledger.length + "줄", "ledger"),
      tile("공지사항", "홈페이지 공지 " + notices.length + "건 · 글쓰기, 고치기", "notices")));
    view.appendChild(h("div", { class: "cap", text: "처음 한 번" }));
    view.appendChild(h("div", { class: "tiles" }, tile("노션에서 가져오기", "원생 명부 CSV 파일을 올려 옮깁니다", "importer")));
  }

  /* ── 시간표 현황 ── */
  var ttView = "week";
  function timetable() {
    page("시간표 현황", "칸을 누르면 그 시간의 아이 목록과 정원을 봅니다.");
    var VIEWS = [["week", "주간 수업표"], ["day", "요일별 시간표"], ["cap", "정원 현황"], ["class", "반편성"]];
    function open(id) { return function () { route.back = "timetable"; go("slot", id); }; }
    function state(n, c) { return n >= c ? " full" : n === 0 ? " none" : ""; }
    view.appendChild(h("div", { class: "tabs", role: "tablist" }, VIEWS.map(function (v) {
      return h("button", { type: "button", role: "tab", "aria-selected": ttView === v[0] ? "true" : "false", class: ttView === v[0] ? "on" : "", text: v[1], onclick: function () { ttView = v[0]; timetable(); } });
    })));
    var legend = h("div", { class: "legend" }, h("span", null, h("i", { style: "background:var(--full)" }), "정원이 찬 칸"), h("span", null, h("i", { style: "background:var(--empty)" }), "비어 있는 칸"));
    if (ttView === "week") {
      view.appendChild(legend);
      var g = h("div", { class: "tt" }, h("div"));
      DAYS.forEach(function (d) { g.appendChild(h("div", { class: "h", text: d[1] })); });
      TIMES.forEach(function (t) {
        g.appendChild(h("div", { class: "t", text: t }));
        DAYS.forEach(function (d) {
          var id = slotId(d[0], t), kids = inSlot(id), c = cap(id);
          g.appendChild(h("button", { class: "cell" + state(kids.length, c), type: "button", onclick: open(id) },
            h("span", { class: "n", text: kids.length + " / " + c }), h("span", { class: "names", text: kids.map(function (s) { return s.name; }).join(", ") })));
        });
      });
      view.appendChild(h("div", { style: "overflow-x:auto" }, g));
    } else if (ttView === "day") {
      view.appendChild(legend);
      view.appendChild(h("div", { class: "board" }, DAYS.map(function (d) {
        var total = 0, cards = TIMES.map(function (t) {
          var id = slotId(d[0], t), kids = inSlot(id), c = cap(id); total += kids.length;
          return h("button", { class: "cell" + state(kids.length, c), type: "button", onclick: open(id) },
            h("span", { class: "n", text: d[1] + " " + t + "  ·  " + kids.length + " / " + c }), h("span", { class: "names", text: kids.map(function (s) { return s.name; }).join(", ") }));
        });
        return h("section", null, h("h2", null, d[1] + "요일 ", h("small", { text: "연 " + total + "명" })), cards);
      })));
    } else if (ttView === "cap") {
      var tb = h("tbody"), sumN = 0, sumC = 0;
      DAYS.forEach(function (d) { TIMES.forEach(function (t) {
        var id = slotId(d[0], t), n = inSlot(id).length, c = cap(id), sl = slots[id] || {}; sumN += n; sumC += c;
        tb.appendChild(h("tr", { tabindex: "0", onclick: open(id) }, h("td", { text: d[1] + " " + t }), h("td", { class: "num", text: n }), h("td", { class: "num", text: c }), h("td", { class: "num", text: c - n }),
          h("td", null, h("span", { class: "bar" + state(n, c) }, h("i", { style: "width:" + Math.min(100, c ? Math.round(n / c * 100) : 0) + "%" }))), h("td", { text: sl.memo || "" })));
      }); });
      view.appendChild(h("p", { class: "msg", text: "전체 " + sumN + "자리 사용 / 정원 " + sumC + "자리 (" + (sumC ? Math.round(sumN / sumC * 100) : 0) + "%)" }));
      view.appendChild(h("div", { class: "scroll" }, h("table", { class: "captable" }, h("thead", null, h("tr", null, ["반", "인원", "정원", "남은 자리", "채움", "메모"].map(function (x) { return h("th", { text: x }); }))), tb)));
    } else {
      var any = false;
      DAYS.forEach(function (d) {
        var cards = [];
        TIMES.forEach(function (t) {
          var id = slotId(d[0], t), kids = inSlot(id).sort(function (a, b) { return gradeOrder(a) - gradeOrder(b) || byName(a, b); }), c = cap(id); if (!kids.length) return;
          var st = {}; kids.forEach(function (s) { var k = stage(s) || "미정"; st[k] = (st[k] || 0) + 1; });
          cards.push(h("button", { class: "klass" + state(kids.length, c), type: "button", onclick: open(id) },
            h("b", { text: d[1] + " " + t }), h("span", { class: "n", text: kids.length + " / " + c + "  ·  " + Object.keys(st).map(function (k) { return k + " " + st[k]; }).join(", ") }),
            h("ul", null, kids.map(function (s) { return h("li", null, h("span", { text: s.name }), h("small", { text: [grade(s), s.book].filter(Boolean).join(" · ") })); }))));
        });
        if (cards.length) { any = true; view.appendChild(h("h2", { text: d[1] + "요일" })); view.appendChild(h("div", { class: "klasses" }, cards)); }
      });
      if (!any) view.appendChild(h("p", { class: "empty", text: "시간이 배정된 아이가 없습니다." }));
    }
  }
  function slotDetail(id) {
    route.back = "timetable";
    var kids = inSlot(id), s = slots[id] || {};
    page(slotName(id), kids.length + "명 / 정원 " + cap(id) + "명");
    var c = h("input", { type: "number", min: "0", max: "30", value: cap(id), id: "slot-cap" });
    var memo = h("input", { type: "text", value: s.memo || "", id: "slot-memo" });
    var m = h("span", { class: "msg" });
    view.appendChild(h("div", { class: "form" }, h("label", null, "정원", c), h("label", { class: "wide" }, "메모", memo),
      h("div", { class: "row wide" }, h("button", { class: "btn pri", type: "button", onclick: function () {
        db.collection("slots").doc(id).set({ capacity: Number(c.value) || 10, memo: memo.value.trim() }, { merge: true }).then(function () { m.className = "msg good"; m.textContent = "저장했습니다."; }, function () { m.className = "msg bad"; m.textContent = "저장하지 못했습니다."; });
      } }, "저장"), m)));
    view.appendChild(h("h2", { text: "이 시간의 아이" }));
    view.appendChild(kids.length ? table(kids, ["이름", "학년", "교재", "주 횟수"], function (x) { return [x.name, grade(x), x.book || "", x.weeklyCount || ""]; }, "slot") : h("p", { class: "empty", text: "이 시간에 오는 아이가 없습니다." }));
  }

  /* ── 표 ── */
  function table(list, heads, cells, back) {
    var tb = h("tbody");
    list.forEach(function (s) {
      var tr = h("tr", { tabindex: "0", onclick: function () { route.back = back || route.name; route.backArg = route.arg; go("student", s.id); } });
      cells(s).forEach(function (v) { tr.appendChild(v && v.nodeType ? h("td", null, v) : h("td", { class: typeof v === "number" ? "num" : "", text: typeof v === "number" ? won(v) : v == null ? "" : String(v) })); });
      tb.appendChild(tr);
    });
    return h("div", { class: "scroll" }, h("table", null, h("thead", null, h("tr", null, heads.map(function (x) { return h("th", { text: x }); }))), tb));
  }

  /* ── 검색 ── */
  var query = { roster: "", gone: "" };
  function hay(s) {
    return [s.name, s.school, grade(s), s.book, stage(s), s.guardian, s.guardianPhone, (s.guardianPhone || "").replace(/\D/g, ""), s.payer, s.source, s.memo, s.enrolledOn, s.leftOn,
      (s.watchReasons || []).join(" "), (s.leaveReasons || []).join(" "), sortSlots(s.slots || []).map(slotName).join(" "), s.watch ? "주의" : ""].join(" ").toLowerCase();
  }
  function match(s, q) { var t = hay(s); return q.toLowerCase().split(/\s+/).filter(Boolean).every(function (w) { return t.indexOf(w) >= 0; }); }
  function searchBox(key, hint, draw) {
    var inp = h("input", { type: "search", value: query[key], placeholder: hint, "aria-label": "검색", autocomplete: "off", oninput: function (e) { query[key] = e.target.value; x.hidden = !query[key]; draw(); } });
    var x = h("button", { type: "button", class: "clear", "aria-label": "검색어 지우기", text: "×", onclick: function () { query[key] = ""; inp.value = ""; x.hidden = true; draw(); inp.focus(); } });
    x.hidden = !query[key];
    var box = h("div", { class: "search" }, inp, x);
    box.insertAdjacentHTML("afterbegin", '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/></svg>');
    return box;
  }

  /* ── 원생 명부 ── */
  function roster() {
    page("원생 명부", "아이 이름을 누르면 수정하거나 퇴원·휴원 처리할 수 있습니다.");
    function sel(key, label, opts) {
      return h("label", null, label, h("select", { onchange: function (e) { filters[key] = e.target.value; draw(); } },
        [h("option", { value: "", text: "전체" })].concat(opts.map(function (o) { return h("option", { value: o, selected: filters[key] === o, text: o }); }))));
    }
    var out = h("div");
    function draw() {
      var q = query.roster.trim(), list = active().filter(function (s) {
        return (!filters.grade || grade(s) === filters.grade) && (!filters.school || s.school === filters.school) && (!filters.book || s.book === filters.book) && (!filters.watch || s.watch) && (!q || match(s, q));
      }).sort(function (a, b) { return gradeOrder(a) - gradeOrder(b) || byName(a, b); });
      out.innerHTML = "";
      out.appendChild(h("p", { class: "msg", text: (q ? "'" + q + "' 검색 결과 " : "") + list.length + "명" }));
      out.appendChild(list.length ? table(list, ["이름", "학교", "학년", "주 횟수", "교재", "단계", "월 수강료", "시간", "주의"], function (s) {
        var f = fee(s);
        return [s.name, s.school || "", grade(s), s.weeklyCount || "", s.book || "", stage(s), f == null ? "확인 필요" : f, sortSlots(s.slots).map(slotName).join(" · "), s.watch ? h("span", { class: "tag w", text: "주의" }) : ""];
      }) : h("p", { class: "empty", text: students.length ? "조건에 맞는 아이가 없습니다." : "아직 원생이 없습니다. 홈의 '노션에서 가져오기'나 '신규 등록'으로 시작합니다." }));
    }
    view.appendChild(searchBox("roster", "이름, 학교, 교재, 요일·시간, 메모로 검색", draw));
    view.appendChild(h("div", { class: "filters" }, sel("grade", "학년", GRADES), sel("school", "학교", SCHOOLS), sel("book", "교재", BOOKS), sel("watch", "주의", ["주의 원생만"])));
    view.appendChild(out); draw();
  }
  function gone() {
    page("퇴원 · 휴원생", "지우지 않고 기록으로 남깁니다.");
    var out = h("div");
    function draw() {
      var q = query.gone.trim();
      out.innerHTML = "";
      ["휴원", "퇴원"].forEach(function (st) {
        var list = students.filter(function (s) { return s.status === st && (!q || match(s, q)); }).sort(function (a, b) { return (b.leftOn || "").localeCompare(a.leftOn || "") || byName(a, b); });
        out.appendChild(h("h2", { text: st + "생 " + (q ? "검색 결과 " : "") + list.length + "명" }));
        out.appendChild(list.length ? table(list, ["이름", "학교", "학년", "주 횟수", "교재", "등록일", st === "퇴원" ? "퇴원일" : "", st === "퇴원" ? "퇴원 사유" : "", "재원 개월"], function (s) {
          return [s.name, s.school || "", grade(s), s.weeklyCount ? String(s.weeklyCount) : "", s.book || "", s.enrolledOn || "", s.leftOn || "", (s.leaveReasons || []).join(", "), months(s) == null ? "" : months(s) + "개월"];
        }, "gone") : h("p", { class: "empty", text: q ? "검색된 아이가 없습니다." : "없습니다." }));
      });
    }
    view.appendChild(searchBox("gone", "이름, 퇴원일(예: 2025-06), 퇴원 사유, 메모로 검색", draw));
    view.appendChild(out); draw();
  }

  /* ── 아이 한 명: 신규 등록 · 수정 ── */
  function studentForm(id) {
    var isNew = route.name === "add", s = isNew ? { status: "재원", gradeYear: schoolYear(), enrolledOn: today(), slots: [], consent: [] } : students.filter(function (x) { return x.id === id; })[0];
    if (!s) return go("roster");
    if (!isNew && !route.back) route.back = "roster";
    page(isNew ? "신규 등록" : s.name, isNew ? "등록이 확정된 아이만 입력합니다." : s.status + " · " + grade(s) + (months(s) != null ? " · 재원 " + months(s) + "개월" : ""));
    var picked = {}; (s.slots || []).forEach(function (x) { picked[x] = true; });
    function inp(type, v, extra) { var a = { type: type, value: v == null ? "" : v }; for (var k in (extra || {})) a[k] = extra[k]; return h("input", a); }
    function select(opts, v, blank) { return h("select", null, (blank ? [h("option", { value: "", text: blank })] : []).concat(opts.map(function (o) { return h("option", { value: o, selected: String(v) === String(o), text: String(o) }); }))); }
    function checks(opts, vals) { return h("div", { class: "checks" }, opts.map(function (o) { return h("label", null, h("input", { type: "checkbox", value: o, checked: (vals || []).indexOf(o) >= 0 }), o); })); }
    function read(box) { return [].slice.call(box.querySelectorAll("input:checked")).map(function (x) { return x.value; }); }
    var F = {
      name: inp("text", s.name), gradeInput: select(GRADES, isNew ? "" : grade(s), "고르기"), school: select(SCHOOLS, s.school, "고르기"),
      weeklyCount: select([1, 2, 3, 4, 5], s.weeklyCount, "고르기"), book: select(BOOKS, s.book, "고르기"), bookChangedOn: inp("date", s.bookChangedOn),
      enrolledOn: inp("date", s.enrolledOn), consent: checks(CONSENTS, s.consent), payer: inp("text", s.payer),
      source: select(SOURCES, s.source, "고르기"), guardian: inp("text", s.guardian), guardianPhone: inp("tel", s.guardianPhone), fee: inp("number", fee(s) || "", { min: "0", step: "1000" }),
      watch: h("input", { type: "checkbox", checked: !!s.watch }), watchReasons: checks(WATCH, s.watchReasons), memo: h("textarea", null, s.memo || "")
    };
    var lastRule = ruleFee(s);
    function refill() { var r = ruleFee({ book: F.book.value, weeklyCount: F.weeklyCount.value }); if (F.fee.value === "" || Number(F.fee.value) === lastRule) F.fee.value = r || ""; lastRule = r; }
    F.book.addEventListener("change", refill); F.weeklyCount.addEventListener("change", refill);
    F.book.addEventListener("change", function () { F.bookChangedOn.value = F.book.value === (s.book || "") ? (s.bookChangedOn || "") : F.book.value ? today() : ""; });
    var pickMsg = h("p", { class: "msg" });
    var grid = h("div", { class: "pick" });
    DAYS.forEach(function (d) {
      var col = h("div", null, h("div", { class: "d", text: d[1] }));
      TIMES.forEach(function (t) {
        var sid = slotId(d[0], t), n = inSlot(sid).filter(function (x) { return x.id !== s.id; }).length, left = cap(sid) - n;
        col.appendChild(h("button", { type: "button", class: left <= 0 ? "full" : "", "aria-pressed": picked[sid] ? "true" : "false", onclick: function (e) {
          if (picked[sid]) delete picked[sid]; else picked[sid] = true;
          e.currentTarget.setAttribute("aria-pressed", picked[sid] ? "true" : "false"); note();
        } }, t, h("small", { text: left > 0 ? "남은 " + left : "정원 참" })));
      });
      grid.appendChild(col);
    });
    function note() { var n = Object.keys(picked).length, w = Number(F.weeklyCount.value) || 0; pickMsg.className = "msg" + (w && n !== w ? " bad" : ""); pickMsg.textContent = "고른 시간 " + n + "개" + (w ? " / 주 " + w + "회" : ""); }
    F.weeklyCount.addEventListener("change", note); note();
    var m = h("p", { class: "msg" });
    function L(label, el, wide) { return h("label", { class: wide ? "wide" : "" }, label, el); }
    var form = h("form", { class: "form", onsubmit: save },
      L("아이 이름 (성까지)", F.name), L("지금 학년", F.gradeInput), L("학교", F.school), L("주 몇 회", F.weeklyCount), L("교재", F.book), isNew ? null : L("지금 교재를 시작한 날", F.bookChangedOn),
      h("div", { class: "wide" }, h("label", null, "수업 요일 · 시간"), grid, pickMsg),
      L("등록일 (첫 수업일)", F.enrolledOn), h("div", { class: "wide" }, h("label", null, "학부모 동의"), F.consent),
      L("결제하실 분", F.payer), L("알게 된 경로", F.source), L("보호자", F.guardian), L("보호자 연락처", F.guardianPhone),
      L("수강료 (원)", F.fee), h("label", null, "주의 원생", h("div", { class: "checks" }, h("label", null, F.watch, "주의해서 볼 아이"))),
      h("div", { class: "wide" }, h("label", null, "주의 사유"), F.watchReasons), L("메모", F.memo, true),
      h("div", { class: "row wide" }, h("button", { class: "btn pri", type: "submit" }, isNew ? "등록" : "저장"), m));
    view.appendChild(form);

    function save(e) {
      e.preventDefault();
      var name = F.name.value.trim(), w = Number(F.weeklyCount.value), sl = sortSlots(Object.keys(picked));
      var dup = students.filter(function (x) { return x.name === name && x.id !== s.id; });
      var bad = name.length < 2 ? "아이 이름을 성까지 적어 주세요." : !F.gradeInput.value ? "학년을 골라 주세요." : !w ? "주 횟수를 골라 주세요." :
        (s.status === "재원" && sl.length !== w) ? "고른 시간 수(" + sl.length + ")와 주 횟수(" + w + ")가 같아야 저장됩니다." : "";
      if (bad) { m.className = "msg bad"; m.textContent = bad; return; }
      if (dup.length && !form.dataset.dupOk) { form.dataset.dupOk = "1"; m.className = "msg bad"; m.textContent = "같은 이름의 원생이 이미 있습니다(" + dup[0].status + "). 형제나 동명이인이 맞으면 한 번 더 눌러 주세요."; return; }
      var data = { name: name, gradeInput: F.gradeInput.value, gradeYear: schoolYear(), school: F.school.value, weeklyCount: w, book: F.book.value, bookChangedOn: F.bookChangedOn.value || null,
        enrolledOn: F.enrolledOn.value || null, consent: read(F.consent), payer: F.payer.value.trim(), source: F.source.value, guardian: F.guardian.value.trim(),
        guardianPhone: F.guardianPhone.value.trim(), fee: Number(F.fee.value) > 0 && Number(F.fee.value) !== ruleFee({ book: F.book.value, weeklyCount: w }) ? Number(F.fee.value) : null, feeException: null, watch: F.watch.checked, watchReasons: read(F.watchReasons), memo: F.memo.value.trim(), slots: sl };
      if (isNew) data.bookChangedOn = data.book ? (data.enrolledOn || today()) : null;
      else if (s.book !== data.book && (F.bookChangedOn.value || null) === (s.bookChangedOn || null)) data.bookChangedOn = today();
      m.className = "msg"; m.textContent = "저장하는 중입니다.";
      var p = isNew ? db.collection("students").add(Object.assign(data, { status: "재원", createdAt: firebase.firestore.FieldValue.serverTimestamp() })) : db.collection("students").doc(s.id).update(data);
      p.then(function () { if (isNew) go("roster"); else { m.className = "msg good"; m.textContent = "저장했습니다."; } }, function () { m.className = "msg bad"; m.textContent = "저장하지 못했습니다. 연결을 확인해 주세요."; });
    }
    if (isNew) return;

    /* 상태 처리 */
    view.appendChild(h("h2", { text: "상태 바꾸기" }));
    var sm = h("p", { class: "msg" }), reasons = checks(LEAVE, s.leaveReasons);
    function setStatus(patch, text) { db.collection("students").doc(s.id).update(patch).then(function () { go("roster"); }, function () { sm.className = "msg bad"; sm.textContent = text + " 처리를 하지 못했습니다."; }); }
    var box = h("div", { class: "box" });
    if (s.status === "재원") {
      box.appendChild(h("label", null, "퇴원 사유 (여러 개 가능)")); box.appendChild(reasons);
      box.appendChild(h("div", { class: "row", style: "margin-top:12px" },
        h("button", { class: "btn danger", type: "button", onclick: function (e) {
          if (!e.currentTarget.dataset.sure) { e.currentTarget.dataset.sure = "1"; e.currentTarget.textContent = "한 번 더 누르면 퇴원 처리됩니다"; return; }
          setStatus({ status: "퇴원", leftOn: today(), leaveReasons: read(reasons), slots: [] }, "퇴원");
        } }, "퇴원 처리"),
        h("button", { class: "btn", type: "button", onclick: function () { setStatus({ status: "휴원", slots: [] }, "휴원"); } }, "휴원 처리"), sm));
      box.appendChild(h("p", { class: "msg", text: "퇴원 · 휴원 처리하면 시간표에서 자동으로 빠집니다. 기록은 지워지지 않습니다." }));
    } else {
      box.appendChild(h("div", { class: "row" }, h("button", { class: "btn pri", type: "button", onclick: function () { setStatus({ status: "재원", leftOn: null, leaveReasons: [] }, "재원"); } }, "재원으로 되돌리기"), sm));
      box.appendChild(h("p", { class: "msg", text: "되돌린 뒤 수업 시간을 다시 골라 저장해 주세요." }));
    }
    view.appendChild(box);
  }

  /* ── 통계 · 월말 점검 ── */
  function bars(title, pairs, unit) {
    var max = Math.max.apply(null, pairs.map(function (p) { return p[1]; }).concat([1]));
    return h("div", { class: "box", style: "margin-bottom:12px" }, h("h2", { style: "margin-top:0", text: title }),
      pairs.length ? pairs.map(function (p) {
        return h("div", { style: "display:grid;grid-template-columns:minmax(0,9.5em) minmax(0,1fr) 3.5em;gap:8px;align-items:center;padding:3px 0" },
          h("span", { style: "font-size:13px", text: p[0] }), h("span", { style: "display:block;height:14px;background:var(--alt)" }, h("span", { style: "display:block;height:14px;background:var(--ink);width:" + (p[1] / max * 100) + "%" })),
          h("span", { style: "font-size:13px;text-align:right;font-variant-numeric:tabular-nums", text: p[1] + (unit || "명") }));
      }) : h("p", { class: "msg", text: "자료가 없습니다." }));
  }
  function tally(list, get, order) {
    var m = {}; list.forEach(function (s) { var v = get(s); (Array.isArray(v) ? v : [v]).forEach(function (k) { if (k) m[k] = (m[k] || 0) + 1; }); });
    var keys = Object.keys(m);
    keys.sort(order ? function (a, b) { return order.indexOf(a) - order.indexOf(b); } : function (a, b) { return m[b] - m[a]; });
    return keys.map(function (k) { return [k, m[k]]; });
  }
  function stats() {
    page("통계 · 월말 점검", "모든 숫자는 원생 명부에서 자동으로 셉니다.");
    var act = active(), ym = today().slice(0, 7), left = students.filter(function (s) { return s.status === "퇴원"; });
    var newThis = students.filter(function (s) { return (s.enrolledOn || "").slice(0, 7) === ym; }).length;
    var leftThis = left.filter(function (s) { return (s.leftOn || "").slice(0, 7) === ym; });
    var feeSum = 0, feeUnknown = 0; act.forEach(function (s) { var f = fee(s); if (f == null) feeUnknown++; else feeSum += f; });
    var ms = act.map(months).filter(function (x) { return x != null; }), avg = ms.length ? Math.round(ms.reduce(function (a, b) { return a + b; }, 0) / ms.length) : null;
    var seats = DAYS.length * TIMES.length, used = 0, capSum = 0;
    DAYS.forEach(function (d) { TIMES.forEach(function (t) { var id = slotId(d[0], t); used += inSlot(id).length; capSum += cap(id); }); });
    function kv(n, label) { return h("div", null, h("b", { text: n }), h("span", { text: label })); }
    view.appendChild(h("div", { class: "box kv" }, kv(act.length + "명", "재원생"), kv(students.filter(function (s) { return s.status === "휴원"; }).length + "명", "휴원생"),
      kv(newThis + "명", "이번 달 신규"), kv(leftThis.length + "명", "이번 달 퇴원"), kv(avg == null ? "–" : avg + "개월", "평균 재원 기간"),
      kv(won(feeSum) + "원", "월 수강료 합계" + (feeUnknown ? " (확인 필요 " + feeUnknown + "명 제외)" : "")), kv(capSum ? Math.round(used / capSum * 100) + "%" : "–", "자리 채움 (" + used + " / " + capSum + ")"), kv(act.filter(function (s) { return s.watch; }).length + "명", "주의 원생")));
    var byMonth = {}; students.forEach(function (s) { var k = (s.enrolledOn || "").slice(0, 7); if (k) byMonth[k] = (byMonth[k] || 0) + 1; });
    var recent = Object.keys(byMonth).sort().slice(-12).map(function (k) { return [k, byMonth[k]]; });
    var leftMonth = {}; left.forEach(function (s) { var k = (s.leftOn || "").slice(0, 7); if (k) leftMonth[k] = (leftMonth[k] || 0) + 1; });
    view.appendChild(h("h2", { text: "등록과 퇴원" }));
    view.appendChild(bars("월별 등록 (최근 12개 달)", recent));
    view.appendChild(bars("월별 퇴원 (최근 12개 달)", Object.keys(leftMonth).sort().slice(-12).map(function (k) { return [k, leftMonth[k]]; })));
    view.appendChild(bars("알게 된 경로 (전체)", tally(students, function (s) { return s.source; })));
    view.appendChild(bars("퇴원 사유", tally(left, function (s) { return s.leaveReasons; })));
    view.appendChild(h("h2", { text: "지금 재원생" }));
    view.appendChild(bars("학년", tally(act, grade, GRADES)));
    view.appendChild(bars("교재", tally(act, function (s) { return s.book; }, BOOKS)));
    view.appendChild(bars("주 횟수", tally(act, function (s) { return s.weeklyCount ? "주 " + s.weeklyCount + "회" : ""; }, ["주 1회", "주 2회", "주 3회", "주 4회", "주 5회"])));
    view.appendChild(bars("학교", tally(act, function (s) { return s.school; })));
    view.appendChild(bars("요일별 등원 인원", DAYS.map(function (d) { var n = 0; TIMES.forEach(function (t) { n += inSlot(slotId(d[0], t)).length; }); return [d[1] + "요일", n]; })));
    view.appendChild(h("h2", { text: "주의 원생" }));
    view.appendChild(bars("주의 사유", tally(act.filter(function (s) { return s.watch; }), function (s) { return s.watchReasons; })));
    var w = act.filter(function (s) { return s.watch; }).sort(byName);
    if (w.length) view.appendChild(table(w, ["이름", "학년", "교재", "주의 사유"], function (s) { return [s.name, grade(s), s.book || "", (s.watchReasons || []).join(", ")]; }, "stats"));
    var stale = act.filter(function (s) { return s.bookChangedOn; }).sort(function (a, b) { return a.bookChangedOn.localeCompare(b.bookChangedOn); }).slice(0, 10);
    view.appendChild(h("h2", { text: "같은 교재를 오래 치는 아이 (10명)" }));
    view.appendChild(stale.length ? table(stale, ["이름", "학년", "교재", "교재 바꾼 날", "지난 주"], function (s) { return [s.name, grade(s), s.book || "", s.bookChangedOn, Math.floor((Date.now() - new Date(s.bookChangedOn)) / 6048e5) + "주"]; }, "stats") : h("p", { class: "empty", text: "교재 바꾼 날이 입력된 아이가 없습니다." }));
  }

  /* ── 노션 CSV 가져오기 ── */
  function parseCsv(text) {
    var rows = [], row = [], cur = "", q = false, i, c;
    text = text.replace(/^﻿/, "");
    for (i = 0; i < text.length; i++) {
      c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); cur = ""; if (row.length > 1 || row[0] !== "") rows.push(row); row = []; }
      else cur += c;
    }
    if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }
  function parseDate(v) {
    v = (v || "").trim(); if (!v) return null;
    var m = v.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    if (m) return m[1] + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[3]).slice(-2);
    var d = new Date(v); return isNaN(d) ? null : d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
  }
  function parseSlots(v) {
    var out = [], re = /([월화수목금])\s*(\d{1,2}):(\d{2})/g, m;
    while ((m = re.exec(v || ""))) { var d = DAYS.filter(function (x) { return x[1] === m[1]; })[0]; if (d) out.push(d[0] + "-" + ("0" + m[2]).slice(-2) + m[3]); }
    return sortSlots(out.filter(function (x, i) { return out.indexOf(x) === i; }));
  }
  function list(v) { return (v || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean); }
  function importer() {
    page("노션에서 가져오기", "노션 원생 명부를 CSV로 내보낸 파일을 올립니다. 파일은 이 브라우저에서만 읽고, 확인을 누르기 전에는 저장하지 않습니다.");
    view.appendChild(h("div", { class: "box" }, h("p", null, "노션에서 원생 명부를 연 뒤 오른쪽 위 ··· → 내보내기 → 형식 'Markdown 및 CSV' → 내보내기. 받은 압축 파일 안의 .csv 파일을 아래에서 고릅니다. 이름 끝이 _all인 파일이 있으면 그 파일을 씁니다."),
      h("input", { type: "file", accept: ".csv,text/csv", onchange: function (e) { var f = e.target.files[0]; if (!f) return; var r = new FileReader(); r.onload = function () { preview(String(r.result)); }; r.readAsText(f, "utf-8"); } })));
    var out = h("div"); view.appendChild(out);
    function preview(text) {
      var rows = parseCsv(text), head = (rows.shift() || []).map(function (x) { return x.trim(); });
      function col(r, name) { var i = head.indexOf(name); return i < 0 ? "" : (r[i] || "").trim(); }
      out.innerHTML = "";
      if (head.indexOf("이름") < 0) { out.appendChild(h("p", { class: "msg bad", text: "'이름' 칸이 없는 파일입니다. 원생 명부를 내보낸 CSV가 맞는지 확인해 주세요." })); return; }
      var data = rows.filter(function (r) { return col(r, "이름"); }).map(function (r) {
        var st = col(r, "상태") || "재원", fx = (col(r, "수강료") || col(r, "수강료 예외")).replace(/[^0-9]/g, "");
        return { name: col(r, "이름"), status: st, gradeInput: col(r, "입력 학년") || col(r, "학년"), gradeYear: schoolYear(), school: col(r, "학교"), weeklyCount: Number(col(r, "주 횟수").replace(/[^0-9]/g, "")) || null,
          book: col(r, "교재").replace(/\s/g, ""), bookChangedOn: parseDate(col(r, "교재 바꾼 날")), teacher: col(r, "담당"), enrolledOn: parseDate(col(r, "등록일")), fee: Number(fx) > 0 ? Number(fx) : null,
          payer: col(r, "결제하실 분"), guardian: col(r, "보호자"), guardianPhone: col(r, "보호자 연락처"), consent: list(col(r, "동의")), source: col(r, "알게 된 경로"), watch: /^(yes|true|예|체크)/i.test(col(r, "주의 원생")),
          watchReasons: list(col(r, "주의 사유")), leftOn: parseDate(col(r, "퇴원일")), leaveReasons: list(col(r, "퇴원 사유")), memo: col(r, "메모"), slots: st === "재원" ? parseSlots(col(r, "시간표")) : [] };
      });
      var act = data.filter(function (s) { return s.status === "재원"; }), mism = act.filter(function (s) { return s.slots.length !== s.weeklyCount; }), dup = data.filter(function (s) { return students.some(function (x) { return x.name === s.name; }); });
      out.appendChild(h("h2", { text: "가져올 내용 확인" }));
      out.appendChild(h("div", { class: "box kv" }, h("div", null, h("b", { text: data.length + "명" }), h("span", { text: "전체" })), h("div", null, h("b", { text: act.length + "명" }), h("span", { text: "재원" })),
        h("div", null, h("b", { text: mism.length + "명" }), h("span", { text: "시간 수와 주 횟수가 다른 아이" })), h("div", null, h("b", { text: dup.length + "명" }), h("span", { text: "이미 명부에 있는 이름 (건너뜀)" }))));
      if (head.indexOf("시간표") < 0) out.appendChild(h("p", { class: "msg bad", text: "'시간표' 칸이 없어 수업 시간은 가져오지 못합니다. 가져온 뒤 아이마다 시간을 골라 주세요." }));
      if (mism.length) out.appendChild(h("p", { class: "msg bad", text: "시간 수가 다른 아이: " + mism.map(function (s) { return s.name + "(" + s.slots.length + "/" + (s.weeklyCount || "?") + ")"; }).join(", ") }));
      out.appendChild(table(data.slice(0, 200), ["이름", "상태", "학년", "학교", "주 횟수", "교재", "등록일", "시간"], function (s) { return [s.name, s.status, s.gradeInput, s.school, s.weeklyCount || "", s.book, s.enrolledOn || "", s.slots.map(slotName).join(" · ")]; }, "importer"));
      var m = h("span", { class: "msg" });
      out.appendChild(h("div", { class: "row", style: "margin-top:14px" }, h("button", { class: "btn pri", type: "button", onclick: function (e) {
        var todo = data.filter(function (s) { return dup.indexOf(s) < 0; }), btn = e.currentTarget;
        if (!todo.length) { m.textContent = "새로 가져올 아이가 없습니다."; return; }
        btn.disabled = true; m.className = "msg"; m.textContent = "저장하는 중입니다.";
        var chunks = []; for (var i = 0; i < todo.length; i += 400) chunks.push(todo.slice(i, i + 400));
        chunks.reduce(function (p, part) { return p.then(function () { var b = db.batch(); part.forEach(function (s) { b.set(db.collection("students").doc(), Object.assign({ createdAt: firebase.firestore.FieldValue.serverTimestamp(), imported: true }, s)); }); return b.commit(); }); }, Promise.resolve())
          .then(function () { go("roster"); }, function () { btn.disabled = false; m.className = "msg bad"; m.textContent = "저장하지 못했습니다. 다시 눌러 주세요."; });
      } }, "이대로 명부에 저장"), m));
    }
  }

  /* ── 시간표 신청 ── */
  var NOTICE0 = "시간별 정원은 선착순으로 마감됩니다. (선생님 한 분당 5명)\n접수 순서대로 가배정되며, 정원이 찬 시간은 대기로 접수됩니다.\n요일마다 한 시간씩, 희망 횟수만큼 선택해 주세요.\n아이 이름은 성까지 정확히 입력해 주세요.\n마감 전까지 신청 내용을 수정할 수 있습니다. 시간을 바꾸면 접수 순서가 다시 매겨집니다.\n확정 시간표는 마감 후 개별 안내해 드립니다.\n문의: 문자 010-4488-4763";
  function tsMs(t) { return t && t.toMillis ? t.toMillis() : 0; }
  function kstInput(msv) { return msv ? new Date(msv + 9 * 36e5).toISOString().slice(0, 16) : ""; }
  function kstText(msv, sec) { return msv ? new Date(msv + 9 * 36e5).toISOString().slice(5, sec ? 19 : 16).replace("T", " ") : ""; }
  function fromKst(v) { return v ? firebase.firestore.Timestamp.fromDate(new Date(v + ":00+09:00")) : null; }
  function surveyState() {
    if (!survey || !survey.round) return { key: "none", text: "연 신청 없음" };
    var t = Date.now(), st = t < tsMs(survey.openAt) ? ["before", "열리기 전"] : t < tsMs(survey.closeAt) ? ["open", "접수 중"] : ["closed", "마감"];
    return { key: st[0], text: st[1] + (survey.visible ? "" : " (학부모 화면 숨김)") };
  }
  function svCap(id) { return survey && survey.caps && survey.caps[id] != null ? Number(survey.caps[id]) : (survey && Number(survey.cap)) || 10; }
  function watchRound() {
    var r = survey && survey.round; if (r === subsRound) return;
    subsUnsub.forEach(function (f) { f(); }); subsUnsub = []; subs = []; desk = {}; subsRound = r; if (!r) return;
    function again() { if (route.name === "survey" || route.name === "home") { var a = document.activeElement; if (!(a && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && view.contains(a))) render(); } }
    subsUnsub.push(db.collection("rounds/" + r + "/submissions").onSnapshot(function (snap) { subs = snap.docs.map(function (d) { var x = d.data(); x.id = d.id; return x; }); again(); }, function () {}));
    subsUnsub.push(db.collection("rounds/" + r + "/desk").onSnapshot(function (snap) { desk = {}; snap.forEach(function (d) { desk[d.id] = d.data(); }); again(); }, function () {}));
  }
  /* 접수 순서대로 칸마다 순번을 매깁니다. 정원 안이면 가배정, 넘으면 대기입니다. */
  function ranked() {
    var list = subs.slice().sort(function (a, b) { return (tsMs(a.at) || 9e15) - (tsMs(b.at) || 9e15); }), n = {}, bySlot = {};
    list.forEach(function (s, i) {
      s.no = i + 1; s.rank = {}; s.waits = 0;
      (s.slots || []).forEach(function (id) { n[id] = (n[id] || 0) + 1; s.rank[id] = n[id]; if (n[id] > svCap(id)) s.waits++; (bySlot[id] = bySlot[id] || []).push(s); });
      var m = active().filter(function (x) { return x.name === s.name.replace(/\s/g, ""); }), linkId = (desk[s.id] || {}).studentId, linked = linkId ? students.filter(function (x) { return x.id === linkId; })[0] : null;
      s.linked = linked || null; s.match = linked || (m.length === 1 ? m[0] : null);
      s.check = linked ? "" : m.length === 0 ? "명부에 없는 이름" : m.length > 1 ? "같은 이름 " + m.length + "명" : ""; s.who = s.match ? "재원생" : "명부에 없음";
    });
    return { list: list, n: n, bySlot: bySlot };
  }
  /* 이름이 한 글자만 다르거나, 성을 뺀 이름이 같으면 비슷한 이름으로 봅니다. */
  function alike(a, b) {
    a = (a || "").replace(/\s/g, ""); b = (b || "").replace(/\s/g, ""); if (!a || !b) return false;
    if (a.length === b.length) { var d = 0; for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; if (d <= 1) return true; }
    if (Math.abs(a.length - b.length) === 1) { var lo = a.length < b.length ? a : b, hi = a.length < b.length ? b : a; for (var j = 0; j < hi.length; j++) if (hi.slice(0, j) + hi.slice(j + 1) === lo) return true; }
    if (Math.min(a.length, b.length) >= 2 && (a.slice(-b.length) === b || b.slice(-a.length) === a)) return true;
    return a.length > 2 && b.length > 2 && a.slice(1) === b.slice(1);
  }
  function surveyView() {
    var st = surveyState(), R = ranked(), sv = survey || {};
    page("시간표 신청", "지금 상태: " + st.text + (sv.round ? " · 접수 " + subs.length + "건" : ""));
    var link = location.origin + "/schedule/";
    var F = { title: h("input", { type: "text", value: sv.title || "시간표 신청" }), notice: h("textarea", { rows: "6" }, sv.notice == null ? NOTICE0 : sv.notice),
      openAt: h("input", { type: "datetime-local", value: kstInput(tsMs(sv.openAt)) }), closeAt: h("input", { type: "datetime-local", value: kstInput(tsMs(sv.closeAt)) }),
      cap: h("input", { type: "number", min: "1", max: "30", value: sv.cap || 10 }), visible: h("input", { type: "checkbox", checked: !!sv.visible }) };
    var m = h("span", { class: "msg" });
    function fail() { m.className = "msg bad"; m.textContent = "저장하지 못했습니다."; }
    function data() {
      var caps = {}; Object.keys(slots).forEach(function (id) { var c = slots[id].capacity; if (c != null && Number(c) !== 10) caps[id] = Number(c); });
      return { title: F.title.value.trim() || "시간표 신청", notice: F.notice.value.trim(), openAt: fromKst(F.openAt.value), closeAt: fromKst(F.closeAt.value), cap: Number(F.cap.value) || 10, caps: caps, visible: F.visible.checked };
    }
    function save(newRound) {
      var d = data(); if (!d.openAt || !d.closeAt || tsMs(d.closeAt) <= tsMs(d.openAt)) { m.className = "msg bad"; m.textContent = "열리는 시각과 마감 시각을 넣어 주세요. 마감은 열림보다 뒤여야 합니다."; return; }
      var round = (!newRound && sv.round) || "r" + new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 16).replace(/\D/g, ""), p = Promise.resolve();
      if (round !== sv.round) p = db.doc("rounds/" + round + "/meta/counts").set({ c: {} });
      d.round = round;
      p.then(function () { return db.doc("survey/current").set(d); }).then(function () { m.className = "msg good"; m.textContent = newRound ? "새로고침했습니다. 받은 신청을 비우고 0부터 다시 받습니다." : "저장했습니다."; delete fresh.dataset.sure; fresh.textContent = "새로고침"; }, fail);
    }
    var fresh = h("button", { class: "btn danger", type: "button", onclick: function () { if (fresh.dataset.sure) save(true); else { fresh.dataset.sure = "1"; fresh.textContent = "한 번 더 누르면 받은 신청을 비우고 처음부터 다시 받습니다"; } } }, "새로고침");
    view.appendChild(h("h2", { text: "신청 설정" }));
    view.appendChild(h("div", { class: "form" }, h("label", { class: "wide" }, "신청 이름", F.title), h("label", { class: "wide" }, "학부모에게 보이는 안내문 (한 줄에 한 가지씩)", F.notice),
      h("div", { class: "wide row" }, h("button", { class: "btn", type: "button", onclick: function () { F.notice.value = NOTICE0; m.className = "msg"; m.textContent = "기본 안내문을 넣었습니다. '설정 저장'을 눌러야 학부모 화면에 반영됩니다."; } }, "기본 안내문으로 바꾸기")),
      h("label", null, "열리는 시각", F.openAt), h("label", null, "마감 시각", F.closeAt), h("label", null, "한 시간 정원 (기본)", F.cap),
      h("label", null, "학부모 화면", h("div", { class: "checks" }, h("label", null, F.visible, "링크를 열면 신청 화면이 보이게 하기"))),
      h("div", { class: "wide row" }, h("button", { class: "btn pri", type: "button", onclick: function () { save(!sv.round); } }, sv.round ? "설정 저장" : "신청 열기"), sv.round ? fresh : null,
        sv.round && st.key === "open" ? h("button", { class: "btn", type: "button", onclick: function () { db.doc("survey/current").update({ closeAt: firebase.firestore.Timestamp.now() }).then(function () { m.className = "msg good"; m.textContent = "마감했습니다."; }, fail); } }, "지금 마감") : null, m),
      h("p", { class: "wide msg", text: "시간표 현황에서 정원을 10명이 아니게 바꿔 둔 칸은 그 정원이 그대로 쓰입니다. 학부모에게는 아래 주소 하나만 보내면 됩니다." }),
      h("div", { class: "wide row" }, h("code", { text: link }), h("button", { class: "btn", type: "button", onclick: function (e) { var b = e.currentTarget; (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(function () { b.textContent = "복사했습니다"; }, function () { b.textContent = "주소를 길게 눌러 복사해 주세요"; }); } }, "주소 복사"),
        h("a", { class: "btn", href: link, target: "_blank", rel: "noopener" }, "학부모 화면 열어 보기"))));
    if (!sv.round) return;

    var waitN = R.list.filter(function (s) { return s.waits; }).length, notYet = active().filter(function (x) { return !R.list.some(function (s) { return s.match && s.match.id === x.id; }); }).sort(byName);
    view.appendChild(h("h2", { text: "접수 현황" }));
    view.appendChild(h("div", { class: "box kv" }, [[subs.length + "건", "접수"], [R.list.filter(function (s) { return s.match; }).length + "건", "명부에 있는 아이"], [R.list.filter(function (s) { return !s.match; }).length + "건", "명부에 없는 이름"], [waitN + "건", "대기가 낀 신청"], [notYet.length + "명", "아직 신청 안 한 재원생"]].map(function (x) { return h("div", null, h("b", { text: x[0] }), h("span", { text: x[1] })); })));
    var TABS = [["order", "접수 순서"], ["grid", "칸별 현황"], ["none", "미신청 재원생"]];
    view.appendChild(h("div", { class: "tabs", style: "margin-top:16px" }, TABS.map(function (v) { return h("button", { type: "button", class: svTab === v[0] ? "on" : "", text: v[1], onclick: function () { svTab = v[0]; surveyView(); } }); })));
    var m2 = h("span", { class: "msg" });
    if (svTab === "order") {
      var tb = h("tbody"), taken = {}; R.list.forEach(function (s) { if (s.match) taken[s.match.id] = s.id; });
      var linker = function (s) {
        var pool = active().filter(function (x) { return !taken[x.id] || taken[x.id] === s.id; }).sort(byName), near = pool.filter(function (x) { return alike(x.name, s.name); }), rest = pool.filter(function (x) { return near.indexOf(x) < 0; });
        function opt(x, pre) { return h("option", { value: x.id, selected: !!(s.linked && s.linked.id === x.id), text: pre + x.name + " (" + grade(x) + ")" }); }
        return h("select", { class: "link", "aria-label": "명부의 아이와 잇기", onchange: function (e) { db.doc("rounds/" + sv.round + "/desk/" + s.id).set({ studentId: e.target.value || null }, { merge: true }); } },
          [h("option", { value: "", text: s.linked ? "잇지 않음" : near.length ? "명부의 누구인가요? (비슷한 이름 " + near.length + "명)" : "명부의 누구인가요?" })].concat(near.map(function (x) { return opt(x, "비슷 · "); }), rest.map(function (x) { return opt(x, ""); })));
      };
      R.list.forEach(function (s) {
        var d = desk[s.id] || {}, sel = h("select", { "aria-label": "처리", onchange: function (e) { db.doc("rounds/" + sv.round + "/desk/" + s.id).set({ status: e.target.value }, { merge: true }); } }, ["접수", "배정 완료", "대기 명단", "보류"].map(function (o) { return h("option", { value: o, selected: (d.status || "접수") === o, text: o }); }));
        tb.appendChild(h("tr", null, h("td", { class: "num", text: s.no }), h("td", { text: kstText(tsMs(s.at), true) }), h("td", null, s.name, s.check ? h("span", { class: "tag w", style: "margin-left:6px", text: s.check }) : null, s.linked ? h("span", { class: "tag", style: "margin-left:6px", text: "명부: " + s.linked.name }) : null, s.check || s.linked ? linker(s) : null), h("td", { text: s.who }), h("td", { text: s.grade }), h("td", { class: "num", text: s.weekly }),
          h("td", null, (s.slots || []).map(function (id) { var w = s.rank[id] - svCap(id); return h("span", { class: "tag" + (w > 0 ? " w" : ""), style: "margin:0 4px 2px 0", text: slotName(id) + (w > 0 ? " 대기" + w : "") }); })),
          h("td", { text: s.phone || "" }), h("td", { text: s.memo || "" }), h("td", null, sel)));
      });
      view.appendChild(R.list.length ? h("div", { class: "scroll" }, h("table", { class: "plain" }, h("thead", null, h("tr", null, ["순번", "접수 시각", "이름", "명부", "학년", "주", "신청 시간", "연락처", "요청", "처리"].map(function (x) { return h("th", { text: x }); }))), tb)) : h("p", { class: "empty", text: "아직 들어온 신청이 없습니다." }));
    } else if (svTab === "grid") {
      var g = h("div", { class: "tt" }, h("div")); DAYS.forEach(function (d) { g.appendChild(h("div", { class: "h", text: d[1] })); });
      TIMES.forEach(function (t) { g.appendChild(h("div", { class: "t", text: t })); DAYS.forEach(function (d) {
        var id = slotId(d[0], t), c = svCap(id), list = R.bySlot[id] || [];
        g.appendChild(h("div", { class: "cell" + (list.length >= c ? " full" : list.length === 0 ? " none" : ""), style: "cursor:default" }, h("span", { class: "n", text: list.length + " / " + c }),
          h("span", { class: "names", text: list.slice(0, c).map(function (s) { return s.name; }).join(", ") }), list.length > c ? h("span", { class: "names", style: "display:block;color:var(--warn)", text: "대기: " + list.slice(c).map(function (s) { return s.name; }).join(", ") }) : null));
      }); });
      view.appendChild(h("div", { style: "overflow-x:auto" }, g));
    } else {
      view.appendChild(notYet.length ? table(notYet, ["이름", "학년", "지금 시간", "보호자 연락처"], function (s) { return [s.name, grade(s), sortSlots(s.slots).map(slotName).join(" · "), s.guardianPhone || ""]; }, "survey") : h("p", { class: "empty", text: "재원생이 모두 신청했습니다." }));
    }

    view.appendChild(h("h2", { text: "마감 뒤 정리" }));
    var out = h("div");
    view.appendChild(h("div", { class: "row" },
      h("button", { class: "btn", type: "button", onclick: function () { var b = db.batch(); R.list.forEach(function (s) { b.set(db.doc("rounds/" + sv.round + "/desk/" + s.id), { status: s.waits ? "대기 명단" : "배정 완료" }, { merge: true }); }); b.commit().then(function () { m2.className = "msg good"; m2.textContent = "가배정대로 처리 칸을 채웠습니다. 한 건씩 바꿀 수 있습니다."; }, function () { m2.className = "msg bad"; m2.textContent = "저장하지 못했습니다."; }); } }, "가배정대로 처리 표시"),
      h("button", { class: "btn", type: "button", onclick: preview }, "확정 결과를 시간표에 반영"),
      h("button", { class: "btn", type: "button", onclick: csv }, "CSV 내려받기"),
      h("button", { class: "btn", type: "button", onclick: function () { db.doc("rounds/" + sv.round + "/meta/counts").set({ c: R.n }).then(function () { m2.className = "msg good"; m2.textContent = "학부모 화면의 남은 자리를 실제 접수 건수로 다시 맞췄습니다."; }); } }, "남은 자리 다시 계산"), m2));
    view.appendChild(out);
    function csv() {
      var rows = [["순번", "접수 시각", "이름", "명부", "학년", "주 횟수", "신청 시간", "대기", "연락처", "요청", "처리"]].concat(R.list.map(function (s) {
        return [s.no, kstText(tsMs(s.at), true), s.name, s.who, s.grade, s.weekly, s.slots.map(slotName).join(" / "), s.slots.filter(function (id) { return s.rank[id] > svCap(id); }).map(function (id) { return slotName(id) + " 대기" + (s.rank[id] - svCap(id)); }).join(" / "), s.phone, s.memo, (desk[s.id] || {}).status || "접수"]; }));
      var text = "﻿" + rows.map(function (r) { return r.map(function (v) { return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"'; }).join(","); }).join("\r\n");
      var a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "text/csv" })), download: "시간표신청_" + sv.round + ".csv" }); document.body.appendChild(a); a.click(); a.remove();
    }
    function preview() {
      var done = R.list.filter(function (s) { return (desk[s.id] || {}).status === "배정 완료"; }), hit = done.filter(function (s) { return s.match; }), miss = done.filter(function (s) { return !s.match; });
      out.innerHTML = "";
      out.appendChild(h("h2", { text: "시간표에 반영할 내용" }));
      if (!done.length) { out.appendChild(h("p", { class: "empty", text: "처리가 '배정 완료'인 신청이 없습니다. 접수 순서 표에서 처리를 바꾸거나 '가배정대로 처리 표시'를 먼저 눌러 주세요." })); return; }
      out.appendChild(h("p", { class: "msg", text: "'배정 완료' " + done.length + "건 중 명부의 재원생과 이름이 맞는 " + hit.length + "명의 수업 시간과 주 횟수를 아래처럼 바꿉니다. 비어 있는 보호자 연락처도 함께 채웁니다." }));
      if (hit.length) out.appendChild(h("div", { class: "scroll" }, h("table", { class: "plain" }, h("thead", null, h("tr", null, ["이름", "지금", "바뀐 뒤"].map(function (x) { return h("th", { text: x }); }))), h("tbody", null, hit.map(function (s) {
        return h("tr", null, h("td", { text: s.match.name === s.name ? s.name : s.match.name + " (신청서에는 '" + s.name + "')" }), h("td", { text: sortSlots(s.match.slots).map(slotName).join(" · ") || "없음" }), h("td", { text: sortSlots(s.slots).map(slotName).join(" · ") })); })))));
      if (miss.length) out.appendChild(h("p", { class: "msg bad", text: "명부의 아이와 이어지지 않아 반영하지 않는 신청: " + miss.map(function (s) { return s.name; }).join(", ") + " — 재원생인데 이름이 다르게 적힌 경우는 접수 순서 표에서 명부의 아이와 이어 주시고, 새로 오는 아이는 '신규 등록'에서 직접 넣어 주세요." }));
      var m3 = h("span", { class: "msg" });
      if (hit.length) out.appendChild(h("div", { class: "row", style: "margin-top:12px" }, h("button", { class: "btn pri", type: "button", onclick: function (e) {
        var b = db.batch(), btn = e.currentTarget; btn.disabled = true;
        hit.forEach(function (s) { var patch = { slots: sortSlots(s.slots), weeklyCount: s.slots.length }; if (!s.match.guardianPhone && s.phone) patch.guardianPhone = s.phone; b.update(db.collection("students").doc(s.match.id), patch); });
        b.commit().then(function () { m3.className = "msg good"; m3.textContent = hit.length + "명의 시간표를 바꿨습니다. 시간표 현황에서 확인할 수 있습니다."; }, function () { btn.disabled = false; m3.className = "msg bad"; m3.textContent = "반영하지 못했습니다. 다시 눌러 주세요."; });
      } }, hit.length + "명 시간표 바꾸기"), m3));
    }
  }

  /* ── 공지사항 ── */
  var SEED = [
    { tag: "안내", title: "2027년 새 공간으로 단장합니다", date: "2026-12-24", when: "2026. 12. 24 – 2027. 1. 3", pinned: false, published: true,
      body: "실내를 새로 단장합니다. 아이들이 매일 머무는 공간이기에 벽 마감재까지 신중하게 골랐습니다. 자세한 내용은 시설소개에서 보실 수 있습니다.\n\n공사 기간: 2026년 12월 24일 – 2027년 1월 3일" },
    { tag: "상시", title: "학원에 오실 때 부탁드리는 열 가지", date: "2026-01-01", when: "", pinned: false, published: true,
      body: "1. 휴대폰은 가방에 넣어 둡니다.\n2. 수업 중에는 연락을 삼가 주세요.\n3. 간식은 학원 밖에서 먹습니다.\n4. 등원하면 손부터 씻습니다.\n5. 수업 시작 5분 전에 도착합니다.\n6. 데리러 오시면 복도에서 기다려 주세요.\n7. 결석과 지각은 미리 알려 주세요.\n8. 장난감과 귀중품은 집에 둡니다.\n9. 아플 때는 쉽니다.\n10. 연락처가 바뀌면 알려 주세요." }
  ];
  /* 사진을 가로세로 1280 안으로 줄이고, 한 장이 약 200KB를 넘지 않게 화질을 낮춥니다. */
  function shrink(file) {
    return new Promise(function (ok, no) {
      var url = URL.createObjectURL(file), im = new Image();
      im.onload = function () {
        var k = Math.min(1, 1280 / Math.max(im.naturalWidth, im.naturalHeight)), w = Math.max(1, Math.round(im.naturalWidth * k)), hh = Math.max(1, Math.round(im.naturalHeight * k));
        var c = document.createElement("canvas"); c.width = w; c.height = hh; var g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, w, hh); g.drawImage(im, 0, 0, w, hh); URL.revokeObjectURL(url);
        var q = 0.82, out = c.toDataURL("image/jpeg", q);
        while (out.length > 270000 && q > 0.4) { q -= 0.08; out = c.toDataURL("image/jpeg", q); }
        if (out.length > 270000) { var c2 = document.createElement("canvas"); c2.width = Math.round(w * 0.7); c2.height = Math.round(hh * 0.7); c2.getContext("2d").drawImage(c, 0, 0, c2.width, c2.height); out = c2.toDataURL("image/jpeg", 0.6); }
        out.length > 330000 ? no() : ok(out);
      };
      im.onerror = function () { URL.revokeObjectURL(url); no(); };
      im.src = url;
    });
  }
  function noticeList() {
    page("공지사항", "홈페이지 '공지' 자리에 나오는 글입니다. 글만 쓸 수 있고 사진은 넣지 않습니다.");
    view.appendChild(h("div", { class: "row", style: "margin-bottom:14px" }, h("button", { class: "btn pri", type: "button", onclick: function () { route.back = "notices"; go("notice"); } }, "새 글 쓰기"), h("a", { class: "btn", href: "/#notice", target: "_blank", rel: "noopener" }, "홈페이지에서 보기")));
    var list = notices.slice().sort(function (a, b) { return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.date || "").localeCompare(a.date || ""); });
    var missing = SEED.filter(function (n) { return !notices.some(function (x) { return x.title === n.title; }); });
    if (missing.length) {
      var sm = h("span", { class: "msg" });
      view.appendChild(h("div", { class: "box", style: "margin-bottom:14px" }, h("p", { text: "전에 홈페이지에 있던 공지를 버튼 한 번으로 넣을 수 있습니다. 넣은 뒤에는 자유롭게 고치거나 지울 수 있습니다." }),
        h("div", { class: "row" }, missing.map(function (n) { return h("button", { class: "btn", type: "button", onclick: function (e) { e.currentTarget.disabled = true; db.collection("notices").add(n).then(null, function () { sm.className = "msg bad"; sm.textContent = "넣지 못했습니다."; }); } }, "'" + n.title + "' 넣기"); }), sm)));
    }
    if (!list.length) { view.appendChild(h("p", { class: "empty", text: "아직 쓴 글이 없어 홈페이지 공지 자리가 비어 있습니다." })); return; }
    var tb = h("tbody"); list.forEach(function (n) { tb.appendChild(h("tr", { tabindex: "0", onclick: function () { route.back = "notices"; go("notice", n.id); } }, h("td", { text: n.date || "" }), h("td", { text: n.tag || "공지" }), h("td", null, n.title, n.photoCount ? h("span", { class: "tag", style: "margin-left:6px", text: "사진 " + n.photoCount }) : null, n.pinned ? h("span", { class: "tag", style: "margin-left:6px", text: "맨 위 고정" }) : null), h("td", { text: n.published ? "보임" : "숨김" }))); });
    view.appendChild(h("div", { class: "scroll" }, h("table", null, h("thead", null, h("tr", null, ["날짜", "구분", "제목", "홈페이지"].map(function (x) { return h("th", { text: x }); }))), tb)));
  }
  function noticeForm(id) {
    var n = id ? notices.filter(function (x) { return x.id === id; })[0] : { date: today(), published: true };
    if (!n) return go("notices");
    route.back = "notices"; page(id ? "공지 고치기" : "새 공지 쓰기", "저장하면 홈페이지에 바로 반영됩니다.");
    var F = { tag: h("select", null, ["공지", "안내", "상시", "중요"].map(function (o) { return h("option", { value: o, selected: (n.tag || "공지") === o, text: o }); })), when: h("input", { type: "text", value: n.when || "", maxlength: "40", placeholder: "예: 2026. 12. 24 – 2027. 1. 3" }),
      title: h("input", { type: "text", value: n.title || "", maxlength: "80" }), date: h("input", { type: "date", value: n.date || today() }), body: h("textarea", { rows: "10", maxlength: "4000" }, n.body || ""),
      published: h("input", { type: "checkbox", checked: n.published !== false }), pinned: h("input", { type: "checkbox", checked: !!n.pinned }) }, m = h("span", { class: "msg" });
    var photos = (n.photos || []).slice(), thumbs = h("div", { class: "thumbs" }), pm = h("span", { class: "msg" });
    var pick = h("input", { type: "file", accept: "image/*", multiple: true, onchange: function (e) {
      var files = [].slice.call(e.target.files, 0, 3 - photos.length); pm.className = "msg"; pm.textContent = files.length ? "사진을 줄이는 중입니다." : "";
      files.reduce(function (p, f) { return p.then(function () { return shrink(f).then(function (u) { photos.push(u); }, function () { pm.className = "msg bad"; pm.textContent = "읽지 못한 사진이 있습니다: " + f.name; }); }); }, Promise.resolve())
        .then(function () { if (pm.className === "msg") pm.textContent = ""; e.target.value = ""; drawPhotos(); });
    } });
    function drawPhotos() {
      thumbs.innerHTML = "";
      photos.forEach(function (u, i) { thumbs.appendChild(h("div", null, h("img", { src: u, alt: "사진 " + (i + 1) }), h("button", { type: "button", class: "btn", onclick: function () { photos.splice(i, 1); drawPhotos(); } }, "빼기"))); });
      pick.disabled = photos.length >= 3;
    }
    drawPhotos();
    var del = h("button", { class: "btn danger", type: "button", onclick: function () { if (!del.dataset.sure) { del.dataset.sure = "1"; del.textContent = "한 번 더 누르면 지워집니다"; return; } db.collection("notices").doc(id).delete().then(function () { go("notices"); }); } }, "글 지우기");
    view.appendChild(h("form", { class: "form", onsubmit: function (e) {
      e.preventDefault();
      var d = { tag: F.tag.value, when: F.when.value.trim(), title: F.title.value.trim(), date: F.date.value || today(), body: F.body.value.trim(), published: F.published.checked, pinned: F.pinned.checked, photos: photos, photoCount: photos.length, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
      if (!d.title || !d.body) { m.className = "msg bad"; m.textContent = "제목과 내용을 적어 주세요."; return; }
      (id ? db.collection("notices").doc(id).set(d) : db.collection("notices").add(d)).then(function () { go("notices"); }, function () { m.className = "msg bad"; m.textContent = "저장하지 못했습니다. 다시 눌러 주세요."; });
    } }, h("label", { class: "wide" }, "제목", F.title), h("label", null, "구분 (제목 앞에 붙는 말)", F.tag), h("label", null, "날짜 (최신 글이 위로)", F.date),
      h("label", null, "날짜 자리에 보일 글 (비우면 날짜, '상시'는 비움)", F.when),
      h("label", null, "보이기", h("div", { class: "checks" }, h("label", null, F.published, "홈페이지에 보이기"), h("label", null, F.pinned, "맨 위에 고정"))),
      h("label", { class: "wide" }, "내용 (줄을 바꾸면 그대로 줄이 바뀝니다)", F.body),
      h("div", { class: "wide" }, h("label", null, "사진 (넣을 때만, 최대 3장 · 올릴 때 자동으로 줄입니다)", pick), pm, thumbs,
        h("p", { class: "msg", text: "홈페이지에 누구나 보는 사진입니다. 아이 얼굴이 나오면 명부의 '사진·영상 사용', '얼굴 노출' 동의를 먼저 확인해 주세요." })),
      h("div", { class: "wide row" }, h("button", { class: "btn pri", type: "submit" }, "저장"), id ? del : null, m)));
  }

  /* ── 이달의 클라비어 ── */
  var AWARDS = ["에튀드상", "크레센도상"];
  function prevMonth(ym) { var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)) - 1; if (m < 1) { m = 12; y--; } return y + "-" + ("0" + m).slice(-2); }
  function awardList() {
    page("이달의 클라비어", "매달 상 받은 아이를 한 줄씩 적습니다. 같은 상은 두 달 연속 주지 않습니다.");
    view.appendChild(h("div", { class: "row", style: "margin-bottom:14px" }, h("button", { class: "btn pri", type: "button", onclick: function () { route.back = "awards"; go("award"); } }, "수상 기록 쓰기")));
    var list = awards.slice().sort(function (a, b) { return (b.month || "").localeCompare(a.month || "") || (a.award || "").localeCompare(b.award || "", "ko"); });
    if (!list.length) { view.appendChild(h("p", { class: "empty", text: "아직 적은 수상 기록이 없습니다." })); return; }
    var tb = h("tbody"); list.forEach(function (a) {
      var st = students.filter(function (x) { return x.id === a.studentId; })[0], noOk = a.wall && st && (st.consent || []).indexOf("외벽 이름 게시") < 0;
      tb.appendChild(h("tr", { tabindex: "0", onclick: function () { route.back = "awards"; go("award", a.id); } }, h("td", { text: a.month || "" }), h("td", { text: a.award || "" }), h("td", { text: a.studentName || "" }), h("td", { text: st ? grade(st) : "" }), h("td", { text: a.reason || "" }),
        h("td", null, a.wall ? "게시" : "", noOk ? h("span", { class: "tag w", style: "margin-left:6px", text: "동의 확인 필요" }) : null)));
    });
    view.appendChild(h("div", { class: "scroll" }, h("table", null, h("thead", null, h("tr", null, ["수상 월", "상", "원생", "학년", "선정 이유", "외벽 게시"].map(function (x) { return h("th", { text: x }); }))), tb)));
    var count = {}; awards.forEach(function (a) { if (a.studentName) count[a.studentName] = (count[a.studentName] || 0) + 1; });
    var top = Object.keys(count).sort(function (a, b) { return count[b] - count[a] || a.localeCompare(b, "ko"); });
    view.appendChild(h("h2", { text: "아이별 수상 횟수" }));
    view.appendChild(h("p", { class: "msg", text: top.map(function (k) { return k + " " + count[k] + "회"; }).join(" · ") }));
    var never = active().filter(function (s) { return !count[s.name]; }).sort(byName);
    view.appendChild(h("h2", { text: "아직 받지 않은 재원생 " + never.length + "명" }));
    view.appendChild(h("p", { class: "msg", text: never.map(function (s) { return s.name; }).join(" · ") || "모두 한 번 이상 받았습니다." }));
  }
  function awardForm(id) {
    var a = id ? awards.filter(function (x) { return x.id === id; })[0] : { month: today().slice(0, 7), wall: false };
    if (!a) return go("awards");
    route.back = "awards"; page(id ? "수상 기록 고치기" : "수상 기록 쓰기", "외벽에 이름을 걸기 전, 아이의 '외벽 이름 게시' 동의를 확인합니다.");
    var used = AWARDS.concat(awards.map(function (x) { return x.award; })).filter(function (x, i, arr) { return x && arr.indexOf(x) === i; });
    var kids = active().sort(byName);
    var F = { month: h("input", { type: "month", value: a.month || "" }), award: h("input", { type: "text", value: a.award || "", list: "award-names", maxlength: "20", placeholder: "예: 에튀드상" }),
      student: h("select", null, [h("option", { value: "", text: "고르기" })].concat(kids.map(function (s) { return h("option", { value: s.id, selected: a.studentId === s.id, text: s.name + " (" + grade(s) + ")" }); }))),
      reason: h("textarea", { rows: "3", maxlength: "300" }, a.reason || ""), wall: h("input", { type: "checkbox", checked: !!a.wall }) }, m = h("p", { class: "wide msg" }), warn = h("p", { class: "wide msg bad" });
    if (a.studentId && !kids.some(function (s) { return s.id === a.studentId; })) F.student.appendChild(h("option", { value: a.studentId, selected: true, text: (a.studentName || "") + " (재원생 아님)" }));
    function check() {
      var st = students.filter(function (x) { return x.id === F.student.value; })[0], w = [], mo = F.month.value, aw = F.award.value.trim();
      if (st && aw && mo && awards.some(function (x) { return x.id !== id && x.studentId === st.id && x.award === aw && (x.month === prevMonth(mo) || x.month === mo); })) w.push(st.name + " 아이는 지난달이나 이번 달에 이미 '" + aw + "'을 받았습니다. 같은 상은 두 달 연속 주지 않습니다.");
      if (st && F.wall.checked && (st.consent || []).indexOf("외벽 이름 게시") < 0) w.push(st.name + " 아이는 명부에 '외벽 이름 게시' 동의가 없습니다. 동의를 받은 뒤 게시해 주세요.");
      warn.textContent = w.join(" "); return st;
    }
    [F.month, F.award, F.student, F.wall].forEach(function (el) { el.addEventListener("change", check); });
    var del = h("button", { class: "btn danger", type: "button", onclick: function () { if (!del.dataset.sure) { del.dataset.sure = "1"; del.textContent = "한 번 더 누르면 지워집니다"; return; } db.collection("awards").doc(id).delete().then(function () { go("awards"); }); } }, "기록 지우기");
    view.appendChild(h("datalist", { id: "award-names" }, used.map(function (x) { return h("option", { value: x }); })));
    view.appendChild(h("form", { class: "form", onsubmit: function (e) {
      e.preventDefault(); var st = check();
      if (!F.month.value || !F.award.value.trim() || !F.student.value) { m.className = "wide msg bad"; m.textContent = "수상 월, 상, 원생을 넣어 주세요."; return; }
      var d = { month: F.month.value, award: F.award.value.trim(), studentId: F.student.value, studentName: st ? st.name : (a.studentName || ""), reason: F.reason.value.trim(), wall: F.wall.checked };
      (id ? db.collection("awards").doc(id).set(d) : db.collection("awards").add(d)).then(function () { go("awards"); }, function () { m.className = "wide msg bad"; m.textContent = "저장하지 못했습니다. 다시 눌러 주세요."; });
    } }, h("label", null, "수상 월", F.month), h("label", null, "상", F.award), h("label", null, "원생", F.student),
      h("label", null, "외벽 게시", h("div", { class: "checks" }, h("label", null, F.wall, "외벽에 이름 걸기"))), h("label", { class: "wide" }, "선정 이유", F.reason), warn,
      h("div", { class: "wide row" }, h("button", { class: "btn pri", type: "submit" }, "저장"), id ? del : null), m));
    check();
  }

  /* ── 현금출납부 ── */
  function ledgerView() {
    if (!lgMonth) lgMonth = today().slice(0, 7);
    page("현금출납부", "달마다 수입과 지출을 적고, 교육청 점검용으로 인쇄합니다.");
    var all = ledger.slice().sort(function (a, b) { return (a.date || "").localeCompare(b.date || "") || (a.seq || 0) - (b.seq || 0); });
    var rows = all.filter(function (e) { return (e.date || "").slice(0, 7) === lgMonth; }), bal = 0, inSum = 0, outSum = 0;
    if (lgCarry) all.forEach(function (e) { if ((e.date || "").slice(0, 7) < lgMonth) bal += (Number(e.income) || 0) - (Number(e.expense) || 0); });
    var carry = bal, out = h("div");
    var mon = h("input", { type: "month", value: lgMonth, "aria-label": "달", onchange: function (e) { if (e.target.value) { lgMonth = e.target.value; ledgerView(); } } });
    var cc = h("input", { type: "checkbox", checked: lgCarry, onchange: function (e) { lgCarry = e.target.checked; ledgerView(); } });
    view.appendChild(h("div", { class: "row noprint", style: "margin-bottom:14px" }, h("label", { style: "width:170px" }, "달", mon), h("label", { class: "inline" }, cc, "지난달까지 잔액 이어서 계산"),
      h("button", { class: "btn pri", type: "button", onclick: function () { route.back = "ledger"; go("entry"); } }, "한 줄 쓰기"),
      h("button", { class: "btn", type: "button", onclick: bulk }, "이 달 수강료 한꺼번에 넣기"),
      h("button", { class: "btn", type: "button", onclick: function () { window.print(); } }, "인쇄"),
      h("button", { class: "btn", type: "button", onclick: csv }, "CSV 내려받기")));
    view.appendChild(out);
    var tb = h("tbody");
    if (lgCarry) tb.appendChild(h("tr", { class: "carry" }, h("td", { text: "" }), h("td", { text: "전월 이월" }), h("td", { text: "" }), h("td", { text: "" }), h("td", { class: "num", text: won(carry) })));
    rows.forEach(function (e) {
      var i = Number(e.income) || 0, o = Number(e.expense) || 0; bal += i - o; inSum += i; outSum += o; e.bal = bal;
      tb.appendChild(h("tr", { tabindex: "0", onclick: function () { route.back = "ledger"; go("entry", e.id); } }, h("td", { text: e.date || "" }), h("td", { text: e.memo || "" }), h("td", { class: "num", text: i ? won(i) : "" }), h("td", { class: "num", text: o ? won(o) : "" }), h("td", { class: "num", text: won(bal) })));
    });
    var sheet = h("div", { class: "sheet" }, h("h2", { class: "sheet-title", text: Number(lgMonth.slice(0, 4)) + "년 " + Number(lgMonth.slice(5, 7)) + "월 현금출납부" }), h("p", { class: "sheet-sub", text: "세종 클라비어 음악학원" }));
    if (rows.length || lgCarry) sheet.appendChild(h("div", { class: "scroll" }, h("table", { class: "ledger" }, h("thead", null, h("tr", null, ["년월일", "적요", "수입금액", "지출금액", "차인잔액"].map(function (x) { return h("th", { text: x }); }))), tb,
      h("tfoot", null, h("tr", null, h("td", { text: "" }), h("td", { text: "합계 (" + rows.length + "건)" }), h("td", { class: "num", text: won(inSum) }), h("td", { class: "num", text: won(outSum) }), h("td", { class: "num", text: won(bal) }))))));
    else sheet.appendChild(h("p", { class: "empty", text: "이 달에 적은 내용이 없습니다. '이 달 수강료 한꺼번에 넣기'를 누르면 재원생 수강료가 한 번에 들어갑니다." }));
    view.appendChild(sheet);
    function csv() {
      var data = [["년월일", "적요", "수입금액", "지출금액", "차인잔액"]].concat(rows.map(function (e) { return [e.date, e.memo, e.income || "", e.expense || "", e.bal]; }));
      var text = "﻿" + data.map(function (r) { return r.map(function (v) { return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"'; }).join(","); }).join("\r\n");
      var a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "text/csv" })), download: "현금출납부_" + lgMonth + ".csv" }); document.body.appendChild(a); a.click(); a.remove();
    }
    function bulk() {
      var day = h("input", { type: "date", value: lgMonth + "-01", min: lgMonth + "-01", max: lgMonth + "-31" }), m = h("span", { class: "msg" });
      var have = {}; rows.forEach(function (e) { have[e.memo] = true; });
      var todo = active().filter(function (s) { return fee(s) && !have["수강료(" + s.name + ")"]; }).sort(byName), sum = todo.reduce(function (a, s) { return a + fee(s); }, 0);
      out.innerHTML = "";
      out.appendChild(h("div", { class: "box noprint", style: "margin-bottom:14px" }, h("p", { text: "재원생 " + todo.length + "명의 수강료 " + won(sum) + "원을 '수강료(이름)'으로 한 줄씩 넣습니다. 이 달에 이미 들어간 아이는 뺐습니다. 넣은 뒤 날짜와 금액은 줄을 눌러 고칠 수 있습니다." }),
        h("div", { class: "row" }, h("label", { style: "width:170px" }, "받은 날", day), h("button", { class: "btn pri", type: "button", disabled: !todo.length, onclick: function (e) {
          var btn = e.currentTarget, b = db.batch(), base = Date.now(); btn.disabled = true;
          todo.forEach(function (s, i) { b.set(db.collection("ledger").doc(), { date: day.value || lgMonth + "-01", memo: "수강료(" + s.name + ")", income: fee(s), expense: 0, seq: base + i }); });
          b.commit().then(function () { out.innerHTML = ""; }, function () { btn.disabled = false; m.className = "msg bad"; m.textContent = "넣지 못했습니다. 다시 눌러 주세요."; });
        } }, todo.length + "줄 넣기"), h("button", { class: "btn", type: "button", onclick: function () { out.innerHTML = ""; } }, "닫기"), m)));
    }
  }
  function entryForm(id) {
    var e = id ? ledger.filter(function (x) { return x.id === id; })[0] : { date: lgMonth === today().slice(0, 7) || !lgMonth ? today() : lgMonth + "-01" };
    if (!e) return go("ledger");
    route.back = "ledger"; page(id ? "출납 기록 고치기" : "출납 기록 쓰기", "수입이면 수입금액에, 지출이면 지출금액에 적습니다.");
    var F = { date: h("input", { type: "date", value: e.date || "" }), memo: h("input", { type: "text", value: e.memo || "", maxlength: "60", placeholder: "예: 수강료(홍길동), 교재 구입" }),
      income: h("input", { type: "number", min: "0", step: "1000", value: e.income || "" }), expense: h("input", { type: "number", min: "0", step: "1000", value: e.expense || "" }) }, m = h("span", { class: "msg" });
    var del = h("button", { class: "btn danger", type: "button", onclick: function () { if (!del.dataset.sure) { del.dataset.sure = "1"; del.textContent = "한 번 더 누르면 지워집니다"; return; } db.collection("ledger").doc(id).delete().then(function () { go("ledger"); }); } }, "이 줄 지우기");
    view.appendChild(h("form", { class: "form", onsubmit: function (ev) {
      ev.preventDefault();
      var d = { date: F.date.value, memo: F.memo.value.trim(), income: Number(F.income.value) || 0, expense: Number(F.expense.value) || 0, seq: e.seq || Date.now() };
      if (!d.date || !d.memo || (!d.income && !d.expense)) { m.className = "msg bad"; m.textContent = "날짜, 적요, 금액을 넣어 주세요."; return; }
      lgMonth = d.date.slice(0, 7);
      (id ? db.collection("ledger").doc(id).set(d) : db.collection("ledger").add(d)).then(function () { go("ledger"); }, function () { m.className = "msg bad"; m.textContent = "저장하지 못했습니다. 다시 눌러 주세요."; });
    } }, h("label", null, "년월일", F.date), h("label", null, "적요", F.memo), h("label", null, "수입금액 (원)", F.income), h("label", null, "지출금액 (원)", F.expense),
      h("div", { class: "wide row" }, h("button", { class: "btn pri", type: "submit" }, "저장"), id ? del : null, m)));
  }

  /* ── 시작 ── */
  function start(cfg) {
    firebase.initializeApp(cfg); db = firebase.firestore(); auth = firebase.auth();
    document.querySelector(".brand").addEventListener("click", function () { if (auth.currentUser) { route.back = null; go("home"); } });
    document.getElementById("logout").addEventListener("click", function () { auth.signOut(); });
    auth.onAuthStateChanged(function (u) {
      unsubs.forEach(function (f) { f(); }); unsubs = []; students = []; slots = {}; subsUnsub.forEach(function (f) { f(); }); subsUnsub = []; subsRound = null; survey = null; subs = []; notices = []; awards = []; ledger = [];
      document.getElementById("who").hidden = !u;
      if (!u) return login();
      document.getElementById("who-id").textContent = (u.email || "").replace(DOMAIN, "");
      view.innerHTML = ""; view.appendChild(h("p", { class: "wait", text: "명부를 불러오는 중입니다." }));
      var ready = 0;
      function denied() { auth.signOut().then(function () { login("이 계정은 운영실을 볼 권한이 없습니다."); }); }
      unsubs.push(db.collection("students").onSnapshot(function (snap) { students = snap.docs.map(function (d) { var x = d.data(); x.id = d.id; return x; }); if (++ready >= 2 || route.name !== "home" || ready) keep(); }, denied));
      unsubs.push(db.collection("slots").onSnapshot(function (snap) { slots = {}; snap.forEach(function (d) { slots[d.id] = d.data(); }); keep(); }, function () {}));
      unsubs.push(db.doc("survey/current").onSnapshot(function (d) { survey = d.exists ? d.data() : null; watchRound(); if (route.name === "survey" || route.name === "home") keep(); }, function () {}));
      unsubs.push(db.collection("notices").onSnapshot(function (snap) { notices = snap.docs.map(function (d) { var x = d.data(); x.id = d.id; return x; }); if (route.name === "notices" || route.name === "home") keep(); }, function () {}));
      unsubs.push(db.collection("awards").onSnapshot(function (snap) { awards = snap.docs.map(function (d) { var x = d.data(); x.id = d.id; return x; }); if (route.name === "awards" || route.name === "home") keep(); }, function () {}));
      unsubs.push(db.collection("ledger").onSnapshot(function (snap) { ledger = snap.docs.map(function (d) { var x = d.data(); x.id = d.id; return x; }); if (route.name === "ledger" || route.name === "home") keep(); }, function () {}));
      function keep() { var a = document.activeElement; if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && view.contains(a)) return; render(); }
    });
  }
  if (window.__KLAVIER_TEST_CONFIG__) start(window.__KLAVIER_TEST_CONFIG__);
  else fetch("/__/firebase/init.json").then(function (r) { return r.json(); }).then(start).catch(function () { view.innerHTML = ""; view.appendChild(h("p", { class: "empty", text: "운영실은 klavier-academy.web.app 주소에서만 열립니다." })); });
})();
