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

  var db, auth, students = [], slots = {}, unsubs = [], route = { name: "home" }, filters = {};
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
    var r = { home: home, timetable: timetable, slot: slotDetail, roster: roster, student: studentForm, add: studentForm, gone: gone, stats: stats, importer: importer }[route.name] || home;
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
      tile("시간표 조사", "2단계에서 열립니다", "home", true)));
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
        out.appendChild(list.length ? table(list, ["이름", "학년", "교재", "등록일", st === "퇴원" ? "퇴원일" : "", st === "퇴원" ? "퇴원 사유" : "", "재원 개월"], function (s) {
          return [s.name, grade(s), s.book || "", s.enrolledOn || "", s.leftOn || "", (s.leaveReasons || []).join(", "), months(s) == null ? "" : months(s) + "개월"];
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

  /* ── 시작 ── */
  function start(cfg) {
    firebase.initializeApp(cfg); db = firebase.firestore(); auth = firebase.auth();
    document.querySelector(".brand").addEventListener("click", function () { if (auth.currentUser) { route.back = null; go("home"); } });
    document.getElementById("logout").addEventListener("click", function () { auth.signOut(); });
    auth.onAuthStateChanged(function (u) {
      unsubs.forEach(function (f) { f(); }); unsubs = []; students = []; slots = {};
      document.getElementById("who").hidden = !u;
      if (!u) return login();
      document.getElementById("who-id").textContent = (u.email || "").replace(DOMAIN, "");
      view.innerHTML = ""; view.appendChild(h("p", { class: "wait", text: "명부를 불러오는 중입니다." }));
      var ready = 0;
      function denied() { auth.signOut().then(function () { login("이 계정은 운영실을 볼 권한이 없습니다."); }); }
      unsubs.push(db.collection("students").onSnapshot(function (snap) { students = snap.docs.map(function (d) { var x = d.data(); x.id = d.id; return x; }); if (++ready >= 2 || route.name !== "home" || ready) keep(); }, denied));
      unsubs.push(db.collection("slots").onSnapshot(function (snap) { slots = {}; snap.forEach(function (d) { slots[d.id] = d.data(); }); keep(); }, function () {}));
      function keep() { var a = document.activeElement; if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && view.contains(a)) return; render(); }
    });
  }
  if (window.__KLAVIER_TEST_CONFIG__) start(window.__KLAVIER_TEST_CONFIG__);
  else fetch("/__/firebase/init.json").then(function (r) { return r.json(); }).then(start).catch(function () { view.innerHTML = ""; view.appendChild(h("p", { class: "empty", text: "운영실은 klavier-academy.web.app 주소에서만 열립니다." })); });
})();
