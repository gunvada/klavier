/* 클라비어 시간표 신청 — 학부모 화면
   읽는 것: survey/current (회차 안내 · 열림/마감 시각), rounds/{회차}/meta/counts (칸별 신청 수, 이름 없음)
   쓰는 것: rounds/{회차}/submissions/{열쇠} (내 신청 한 건). 다른 아이의 이름·명단은 어디에도 나오지 않습니다.
   열림 · 마감 · 접수 순서는 서버 시각으로 판정합니다(firestore.rules). */
(function () {
  "use strict";
  var DAYS = [["mon", "월"], ["tue", "화"], ["wed", "수"], ["thu", "목"], ["fri", "금"]];
  var TIMES = []; for (var hh = 13; hh <= 19; hh++) { TIMES.push(hh + ":00"); if (hh < 19) TIMES.push(hh + ":30"); }
  var GRADES = ["6세", "7세", "초1", "초2", "초3", "초4", "초5", "초6", "중1", "중2", "중3", "고1", "고2", "고3", "성인"];
  var KIND = "재원생"; /* 구분 없이 모두 같은 순서로 받습니다. 저장 규칙이 이 칸을 요구해 고정값만 넣고 화면에는 쓰지 않습니다. */
  var view = document.getElementById("view"), db, S = null, counts = {}, mine = null, editing = false, lookup = false, offset = 0, phase = "", unsubCounts = null, repaint = null;
  var form = blank();

  function blank() { return { name: "", kind: "", grade: "", weekly: 0, picks: {}, phone: "", memo: "", agree: false, day: "mon" }; }
  function h(tag, attrs) {
    var el = document.createElement(tag), k, i, c;
    for (k in (attrs || {})) {
      if (k === "class") el.className = attrs[k]; else if (k === "text") el.textContent = attrs[k];
      else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] === true) el.setAttribute(k, ""); else if (attrs[k] !== false && attrs[k] != null) el.setAttribute(k, attrs[k]);
    }
    for (i = 2; i < arguments.length; i++) { c = arguments[i]; if (c == null || c === false) continue; (Array.isArray(c) ? c : [c]).forEach(function (x) { if (x != null && x !== false) el.appendChild(typeof x === "string" ? document.createTextNode(x) : x); }); }
    return el;
  }
  function now() { return Date.now() + offset; }
  function ms(t) { return t && t.toMillis ? t.toMillis() : 0; }
  function slotId(d, t) { return d + "-" + ("0" + t.replace(":", "")).slice(-4); }
  function slotName(id) { var p = id.split("-"), d = DAYS.filter(function (x) { return x[0] === p[0]; })[0]; return (d ? d[1] : p[0]) + " " + p[1].slice(0, 2) + ":" + p[1].slice(2); }
  function order(id) { var p = id.split("-"); return DAYS.map(function (x) { return x[0]; }).indexOf(p[0]) * 10000 + Number(p[1]); }
  function cap(id) { return (S.caps && S.caps[id] != null) ? Number(S.caps[id]) : (Number(S.cap) || 10); }
  function kst(t, withSec) {
    var d = new Date(t + 9 * 36e5), w = "일월화수목금토"[d.getUTCDay()], hr = d.getUTCHours(), mi = d.getUTCMinutes();
    return (d.getUTCMonth() + 1) + "월 " + d.getUTCDate() + "일(" + w + ") " + (hr < 12 ? "오전 " : "오후 ") + (hr % 12 || 12) + "시" + (mi ? " " + mi + "분" : "") + (withSec ? " " + d.getUTCSeconds() + "초" : "");
  }
  function left(t) { var s = Math.max(0, Math.floor(t / 1000)), d = Math.floor(s / 86400), hr = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + "일 " : "") + (d || hr ? hr + "시간 " : "") + m + "분 " + (s % 60) + "초"; }
  function key(name, phone) {
    var text = S.round + "|" + name.replace(/\s/g, "") + "|" + phone.replace(/\D/g, "");
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then(function (b) { return [].map.call(new Uint8Array(b), function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""); });
  }
  function sub(k) { return db.collection("rounds/" + S.round + "/submissions").doc(k); }
  function remember(k) { try { localStorage.setItem("klavier-survey-" + S.round, k); } catch (e) {} }
  function recalled() { try { return localStorage.getItem("klavier-survey-" + S.round); } catch (e) { return null; } }

  /* ── 상태 ── */
  function where() { if (!S || !S.visible || !S.round) return "none"; var t = now(); return t < ms(S.openAt) ? "before" : t < ms(S.closeAt) ? "open" : "closed"; }
  function tick() {
    var p = where();
    if (p !== phase) { phase = p; render(); }
    var c = document.getElementById("countdown"); if (c) c.textContent = left(ms(S.openAt) - now());
    var e = document.getElementById("closing"); if (e) e.textContent = "마감까지 " + left(ms(S.closeAt) - now());
  }

  /* ── 화면 ── */
  function head(stateText) {
    view.innerHTML = ""; repaint = null;
    view.appendChild(h("h1", { text: ((S && S.title) || "시간표 신청").replace("시간표 조사", "시간표 신청") }));
    view.appendChild(h("p", { class: "state", text: stateText }));
    if (S && S.notice) view.appendChild(h("div", { class: "notice" }, h("p", { class: "notice-h", text: "신청 안내" }), h("ul", null, S.notice.split(/\n+/).map(function (x) { return x.replace(/^[\s·•\-*]+/, "").trim(); }).filter(Boolean).map(function (x) { return h("li", { text: x }); }))));
  }
  function render() {
    if (phase === "none") { view.innerHTML = ""; view.appendChild(h("h1", { text: "시간표 신청" })); view.appendChild(h("div", { class: "card" }, h("p", { text: "지금은 시간표 신청 기간이 아닙니다." }), h("p", { class: "small", text: "신청이 시작되면 학원에서 따로 알려 드립니다." }))); return; }
    if (phase === "before") {
      head("아직 열리지 않았습니다");
      view.appendChild(h("div", { class: "card" }, h("p", { class: "cap", text: kst(ms(S.openAt)) + "에 열립니다. 이 화면을 그대로 두시면 시간이 되었을 때 저절로 열립니다." }), h("p", { class: "count", id: "countdown", text: left(ms(S.openAt) - now()) })));
      view.appendChild(h("h2", { text: "미리 보는 시간" })); slotPicker(view, true); return;
    }
    if (phase === "closed") {
      head("접수가 마감되었습니다");
      view.appendChild(h("div", { class: "card" }, h("p", { text: "신청해 주셔서 감사합니다. 원장이 접수 순서대로 확인한 뒤 확정 결과를 따로 안내해 드립니다." })));
      if (mine) mineCard(false); else finder(); return;
    }
    head("접수 중 · " + kst(ms(S.closeAt)) + " 마감");
    view.appendChild(h("p", { class: "small", id: "closing", text: "" }));
    if (mine && !editing) { mineCard(true); return; }
    if (lookup) { finder(); return; }
    formView();
  }

  function slotPicker(box, readonly) {
    var tabs = h("div", { class: "days", role: "tablist" }), list = h("div", { class: "times" });
    function paint() {
      tabs.innerHTML = ""; list.innerHTML = "";
      DAYS.forEach(function (d) {
        tabs.appendChild(h("button", { type: "button", role: "tab", "aria-selected": form.day === d[0] ? "true" : "false", onclick: function () { form.day = d[0]; paint(); } }, h("span", { text: d[1] }), h("small", { text: form.picks[d[0]] || (readonly ? "" : "–") })));
      });
      TIMES.forEach(function (t) {
        var id = slotId(form.day, t), n = Number(counts[id]) || 0, c = cap(id), mineHere = mine && editing && (mine.slots || []).indexOf(id) >= 0;
        if (mineHere) n -= 1;
        var txt = c <= 0 ? "받지 않음" : n >= c ? "마감 · 대기 " + (n - c + 1) + "번" : "";  // 학부모 화면에는 남은 자리 수를 보이지 않습니다
        list.appendChild(h("button", { type: "button", class: n >= c ? "full" : "", disabled: readonly || c <= 0, "aria-pressed": form.picks[form.day] === t ? "true" : "false",
          onclick: function () { if (form.picks[form.day] === t) delete form.picks[form.day]; else form.picks[form.day] = t; paint(); if (box.onpick) box.onpick(); } }, h("b", { text: t }), h("small", { text: txt })));
      });
    }
    box.appendChild(tabs); box.appendChild(list); paint(); repaint = paint;
  }

  function formView() {
    var f = h("form", { novalidate: true, onsubmit: submit }), m = h("p", { class: "msg", role: "status" }), pickMsg = h("p", { class: "msg" });
    function field(label, el) { return h("label", null, label, el); }
    function seg(label, opts, cur, set, show) {
      var box = h("div", { class: "seg", role: "group", "aria-label": label });
      opts.forEach(function (o) { box.appendChild(h("button", { type: "button", "aria-pressed": String(cur() === o), onclick: function () { set(o); [].forEach.call(box.children, function (b, i) { b.setAttribute("aria-pressed", String(opts[i] === o)); }); note(); } }, show ? show(o) : String(o))); });
      return h("div", null, h("p", { class: "cap", text: label }), box);
    }
    function note() { var n = Object.keys(form.picks).length; pickMsg.className = "msg" + (form.weekly && n !== form.weekly ? " bad" : form.weekly ? " good" : ""); pickMsg.textContent = "고른 요일 " + n + "개 / 주 " + (form.weekly || "?") + "회" + (form.weekly && n !== form.weekly ? " — 횟수와 같게 골라 주세요." : ""); }
    var name = h("input", { type: "text", value: form.name, autocomplete: "off", maxlength: "20", placeholder: "예: 홍길동", oninput: function (e) { form.name = e.target.value; } });
    var grade = h("select", { onchange: function (e) { form.grade = e.target.value; } }, [h("option", { value: "", text: "고르기" })].concat(GRADES.map(function (g) { return h("option", { value: g, selected: form.grade === g, text: g }); })));
    var phone = h("input", { type: "tel", value: form.phone, inputmode: "numeric", autocomplete: "tel", maxlength: "20", placeholder: "010-0000-0000", oninput: function (e) { form.phone = e.target.value; } });
    var memo = h("textarea", { maxlength: "300", oninput: function (e) { form.memo = e.target.value; } }, form.memo);
    var agree = h("input", { type: "checkbox", checked: form.agree, onchange: function (e) { form.agree = e.target.checked; } });
    if (editing) { name.readOnly = true; phone.readOnly = true; }
    f.appendChild(h("h2", { text: editing ? "신청 내용 고치기" : "신청하기" }));
    if (editing) f.appendChild(h("p", { class: "msg bad", text: "요일이나 시간을 바꾸면 접수 순서가 지금 고치는 시각으로 다시 매겨집니다. 요청 사항만 고치면 순서는 그대로입니다." }));
    f.appendChild(field("아이 이름 (성까지)", name));
    f.appendChild(field("학년", grade));
    f.appendChild(seg("희망 횟수", [1, 2, 3, 4, 5], function () { return form.weekly; }, function (v) { form.weekly = v; }, function (o) { return "주 " + o + "회"; }));
    var pick = h("div"); pick.onpick = note;
    pick.appendChild(h("p", { class: "cap", text: "요일별 시간 — 오실 수 있는 요일만, 요일마다 하나씩 골라 주세요." }));
    slotPicker(pick, false); f.appendChild(pick); f.appendChild(pickMsg); note();
    f.appendChild(field("보호자 연락처", phone));
    f.appendChild(field("요청 사항 (선택)", memo));
    f.appendChild(h("label", { class: "agree" }, agree, h("span", null, "개인정보 수집 · 이용에 동의합니다. (필수)", h("small", { text: "아이 이름 · 학년 · 보호자 연락처를 시간표 배정과 안내에만 쓰고, 배정이 끝난 뒤 지웁니다." }))));
    var btn = h("button", { class: "btn pri", type: "submit" }, editing ? "고친 내용으로 다시 접수" : "신청하기");
    f.appendChild(m); f.appendChild(btn);
    if (editing) f.appendChild(h("button", { class: "btn", type: "button", onclick: function () { editing = false; render(); } }, "고치지 않고 돌아가기"));
    else f.appendChild(h("button", { class: "btn", type: "button", onclick: function () { lookup = true; render(); } }, "이미 신청했습니다 · 내 신청 확인"));
    view.appendChild(f);

    function submit(e) {
      e.preventDefault();
      var nm = form.name.trim(), ph = form.phone.replace(/\D/g, ""), slots = Object.keys(form.picks).map(function (d) { return slotId(d, form.picks[d]); }).sort(function (a, b) { return order(a) - order(b); });
      function bad(t) { m.className = "msg bad"; m.textContent = t; }
      if (nm.length < 2) return bad("아이 이름을 성까지 적어 주세요.");
      if (!form.grade) return bad("학년을 골라 주세요.");
      if (!form.weekly) return bad("희망 횟수를 골라 주세요.");
      if (slots.length !== form.weekly) return bad("고른 요일 수(" + slots.length + ")와 희망 횟수(주 " + form.weekly + "회)가 같아야 합니다.");
      if (ph.length < 9) return bad("보호자 연락처를 적어 주세요.");
      if (!form.agree) return bad("개인정보 수집 · 이용에 동의해 주세요.");
      btn.disabled = true; m.className = "msg"; m.textContent = "접수하는 중입니다. 화면을 닫지 말아 주세요.";
      var base = { name: nm, kind: KIND, grade: form.grade, weekly: form.weekly, slots: slots, phone: form.phone.trim(), memo: form.memo.trim(), agree: true };
      key(nm, ph).then(function (k) {
        var ref = sub(k), cref = db.doc("rounds/" + S.round + "/meta/counts");
        return (editing ? Promise.resolve(null) : ref.get()).then(function (pre) {
          if (pre && pre.exists) { mine = pre.data(); mine.id = k; remember(k); editing = false; render(); view.insertBefore(h("p", { class: "msg bad", text: "같은 이름과 연락처로 이미 접수된 신청이 있습니다. 바꾸시려면 아래 '신청 내용 고치기'를 눌러 주세요." }), view.children[3] || null); return null; }
          return db.runTransaction(function (tx) {
            return tx.get(cref).then(function (cs) { return tx.get(ref).then(function (ss) {
              var c = Object.assign({}, (cs.exists && cs.data().c) || {}), old = ss.exists ? ss.data() : null, same = old && old.slots.join() === slots.join(), pos = {};
              if (same) { tx.update(ref, { kind: base.kind, grade: base.grade, memo: base.memo }); return Object.assign({}, old, { kind: base.kind, grade: base.grade, memo: base.memo }); }
              if (old) old.slots.forEach(function (x) { c[x] = Math.max(0, (Number(c[x]) || 0) - 1); });
              slots.forEach(function (x) { c[x] = (Number(c[x]) || 0) + 1; pos[x] = c[x]; });
              tx.set(ref, Object.assign({ at: firebase.firestore.FieldValue.serverTimestamp(), pos: pos }, base));
              tx.update(cref, { c: c });
              return Object.assign({ pos: pos, at: null }, base);
            }); });
          }).then(function (saved) { mine = saved; mine.id = k; mine.justNow = now(); remember(k); editing = false; form = blank(); render(); window.scrollTo(0, 0); });
        });
      }).catch(function (err) {
        btn.disabled = false;
        bad(err && err.code === "permission-denied" ? (where() === "open" ? "접수하지 못했습니다. 적은 내용을 다시 확인해 주세요." : "지금은 접수 시간이 아닙니다.") : "접수하지 못했습니다. 인터넷 연결을 확인하고 다시 눌러 주세요. 적은 내용은 그대로 있습니다.");
      });
    }
  }

  function mineCard(canEdit) {
    var t = ms(mine.at) || mine.justNow, list = h("ul", { class: "mine" });
    (mine.slots || []).forEach(function (id) {
      var p = (mine.pos || {})[id], c = cap(id), wait = p > c;
      list.appendChild(h("li", null, h("b", { text: slotName(id) }), h("span", { class: wait ? "w" : "k", text: p ? (wait ? "대기 " + (p - c) + "번" : "가배정 · " + p + "번째") : "접수" })));
    });
    view.appendChild(h("div", { class: "card" }, h("h2", { style: "margin-top:0", text: "접수되었습니다" }),
      h("dl", null, h("dt", { text: "아이" }), h("dd", { text: mine.name + " · " + mine.grade }), h("dt", { text: "횟수" }), h("dd", { text: "주 " + mine.weekly + "회" }), h("dt", { text: "접수 시각" }), h("dd", { text: t ? kst(t, true) : "" }),
        mine.memo ? h("dt", { text: "요청" }) : null, mine.memo ? h("dd", { text: mine.memo }) : null), list,
      h("p", { class: "small", style: "margin:12px 0 0", text: "순번은 접수하신 때를 기준으로 한 것입니다. 지금 누르신 것으로 확정되지는 않으며, 원장이 접수 순서대로 확인한 뒤 확정 결과를 따로 안내해 드립니다." })));
    if (canEdit) {
      view.appendChild(h("button", { class: "btn", type: "button", onclick: function () {
        form = { name: mine.name, kind: mine.kind, grade: mine.grade, weekly: mine.weekly, picks: {}, phone: mine.phone, memo: mine.memo || "", agree: true, day: "mon" };
        mine.slots.forEach(function (id) { var p = id.split("-"); form.picks[p[0]] = Number(p[1].slice(0, 2)) + ":" + p[1].slice(2); });
        editing = true; render(); } }, "신청 내용 고치기"));
      view.appendChild(h("button", { class: "btn", type: "button", onclick: function () { mine = null; editing = false; form = blank(); render(); } }, "다른 아이(형제) 신청하기"));
    }
  }

  function finder() {
    var name = h("input", { type: "text", autocomplete: "off", maxlength: "20" }), phone = h("input", { type: "tel", inputmode: "numeric", maxlength: "20" }), m = h("p", { class: "msg" });
    view.appendChild(h("form", { class: "card", onsubmit: function (e) {
      e.preventDefault(); m.className = "msg"; m.textContent = "찾는 중입니다.";
      key(name.value.trim(), phone.value).then(function (k) { return sub(k).get().then(function (d) {
        if (!d.exists) { m.className = "msg bad"; m.textContent = "이 이름과 연락처로 접수된 신청을 찾지 못했습니다. 신청하실 때 적은 그대로 넣어 주세요."; return; }
        mine = d.data(); mine.id = k; remember(k); lookup = false; render();
      }); }).catch(function () { m.className = "msg bad"; m.textContent = "확인하지 못했습니다. 잠시 뒤 다시 눌러 주세요."; });
    } }, h("h2", { style: "margin-top:0", text: "내 신청 확인" }), h("label", null, "아이 이름 (성까지)", name), h("label", null, "신청 때 적은 보호자 연락처", phone), m, h("button", { class: "btn pri", type: "submit" }, "확인"),
      phase === "open" ? h("button", { class: "btn", type: "button", onclick: function () { lookup = false; render(); } }, "처음 신청합니다") : null));
  }

  /* ── 시작 ── */
  function start(cfg) {
    firebase.initializeApp(cfg); db = firebase.firestore();
    db.doc("survey/current").onSnapshot(function (d) {
      var prev = S && S.round; S = d.exists ? d.data() : null;
      if (S && S.round && S.round !== prev) {
        if (unsubCounts) unsubCounts(); counts = {}; mine = null; editing = false;
        unsubCounts = db.doc("rounds/" + S.round + "/meta/counts").onSnapshot(function (c) { counts = (c.exists && c.data().c) || {}; if (repaint) repaint(); }, function () {});
        var k = recalled(); if (k) sub(k).get().then(function (m) { if (m.exists && !mine) { mine = m.data(); mine.id = k; if (!editing) render(); } }, function () {});
      }
      phase = where(); if (!(phase === "open" && view.querySelector("form") && !lookup)) render();
    }, function () { view.innerHTML = ""; view.appendChild(h("p", { class: "wait", text: "불러오지 못했습니다. 인터넷 연결을 확인하고 새로 고쳐 주세요." })); });
    setInterval(tick, 1000);
  }
  if (window.__KLAVIER_TEST_CONFIG__) start(window.__KLAVIER_TEST_CONFIG__);
  else fetch("/__/firebase/init.json", { cache: "no-store" }).then(function (r) { var d = Date.parse(r.headers.get("date")); if (d) offset = d - Date.now(); return r.json(); }).then(start)
    .catch(function () { view.innerHTML = ""; view.appendChild(h("p", { class: "wait", text: "이 화면은 klavier-academy.web.app 주소에서만 열립니다." })); });
})();
