(function () {
  'use strict';

  const API_URL = (window.APP_CONFIG && window.APP_CONFIG.API_URL || '').trim();
  const PW_KEY = 'cxgs-teacher-pw';
  const REFRESH_MS = 30000;
  const EVENT_LABELS = {
    start: '활동 시작',
    essay_done: '1단계 완료 · 입론문 입력',
    criterion_done: '2단계 완료 · 검토 관점 선택',
    problem_done: '3단계 완료 · 문제점 작성',
    question_confirmed: '4단계 · 질문 확정',
    prompt_copied: '요청문 복사',
    feedback_saved: '5단계 · ChatGPT 답변 저장'
  };
  const STATUS = {
    done: ['완료', 'status-done'],
    waiting: ['피드백 대기', 'status-waiting'],
    writing: ['작성 중', 'status-progress']
  };

  let activities = [];
  let lastRaw = '';
  let selectedKey = null;
  const openIds = new Set();
  let timer = null;
  let loading = false;

  const $ = function (id) { return document.getElementById(id); };
  const str = function (v) { return v === null || v === undefined ? '' : String(v); };

  function el(tag, opts, children) {
    const node = document.createElement(tag);
    if (opts) {
      if (opts.className) node.className = opts.className;
      if (opts.text !== undefined) node.textContent = opts.text;
      if (opts.attrs) Object.keys(opts.attrs).forEach(function (k) { node.setAttribute(k, opts.attrs[k]); });
    }
    (children || []).forEach(function (c) { if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return node;
  }

  function pwGet() { try { return sessionStorage.getItem(PW_KEY) || ''; } catch (e) { return ''; } }
  function pwSet(v) { try { sessionStorage.setItem(PW_KEY, v); } catch (e) { /* 무시 */ } }
  function pwClear() { try { sessionStorage.removeItem(PW_KEY); } catch (e) { /* 무시 */ } }

  // ===== 시간 =====
  function fmtTime(ts) { const t = str(ts); return t ? t.slice(0, 10) + ' ' + t.slice(11, 19) : '-'; }
  function toMs(ts) { const t = Date.parse(str(ts)); return isNaN(t) ? null : t; }
  function fmtDur(ms) {
    if (ms === null || ms < 0) return '';
    const sec = Math.round(ms / 1000);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), r = sec % 60;
    if (h) return h + '시간 ' + m + '분';
    if (m) return m + '분 ' + r + '초';
    return r + '초';
  }
  // 학생이 실제로 행동한 시각(학생 기기 기준)을 우선 사용하고, 없으면 서버 저장 시각 사용
  function whenOf(row) { return toMs(row.client_time) !== null ? row.client_time : row.timestamp; }

  // ===== 불러오기 =====
  async function load(password) {
    if (!API_URL) throw new Error('config.js에 API_URL이 설정되지 않았습니다.');
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'teacherData', password: password }),
        redirect: 'follow'
      });
    } catch (e) { throw new Error('서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.'); }
    let data;
    try { data = await res.json(); } catch (e) { throw new Error('서버 응답을 읽지 못했습니다.'); }
    if (!data.ok) throw new Error(data.error || '데이터를 불러오지 못했습니다.');
    return data.data;
  }

  function build(d) {
    const map = {};
    function get(id) {
      if (!map[id]) map[id] = { id: id, number: '', name: '', events: [], submission: null, feedback: null };
      return map[id];
    }
    function who(a, r) { if (!a.number) a.number = str(r.student_number); if (!a.name) a.name = str(r.student_name); }
    (d.events || []).forEach(function (r) { const a = get(r.activity_id); a.events.push(r); who(a, r); });
    (d.submissions || []).forEach(function (r) { const a = get(r.activity_id); if (!a.submission) a.submission = r; who(a, r); });
    (d.feedback || []).forEach(function (r) { const a = get(r.activity_id); if (!a.feedback) a.feedback = r; who(a, r); });
    return Object.keys(map).filter(Boolean).map(function (id) {
      const a = map[id];
      a.events.sort(function (x, y) { return (toMs(whenOf(x)) || 0) - (toMs(whenOf(y)) || 0); });
      const times = a.events.map(whenOf);
      if (a.submission) times.push(whenOf(a.submission));
      if (a.feedback) times.push(whenOf(a.feedback));
      const valid = times.filter(function (t) { return toMs(t) !== null; }).sort(function (x, y) { return toMs(x) - toMs(y); });
      a.first = valid[0] || '';
      a.last = valid[valid.length - 1] || '';
      a.status = a.feedback ? 'done' : (a.submission ? 'waiting' : 'writing');
      a.key = a.number + '|' + a.name;
      return a;
    });
  }

  // ===== 필터 =====
  function filtered() {
    const f = {
      number: $('fNumber').value.trim(), name: $('fName').value.trim(),
      category: $('fCategory').value, type: $('fType').value, status: $('fStatus').value,
      from: $('fFrom').value, to: $('fTo').value
    };
    return activities.filter(function (a) {
      if (f.number && a.number.indexOf(f.number) === -1) return false;
      if (f.name && a.name.indexOf(f.name) === -1) return false;
      if (f.category && (!a.submission || a.submission.criterion_category !== f.category)) return false;
      if (f.type && (!a.submission || a.submission.question_type !== f.type)) return false;
      if (f.status && a.status !== f.status) return false;
      const day = a.first.slice(0, 10);   // 한국 시간(+09:00) 기준 날짜
      if (f.from && day < f.from) return false;
      if (f.to && day > f.to) return false;
      return true;
    });
  }

  // ===== 렌더링 =====
  function render() {
    const list = filtered();
    renderStats(list);
    renderStudents(list);
    renderDetail(list);
  }

  function barRow(label, n, total) {
    const pct = total ? Math.round((n / total) * 100) : 0;
    const bar = el('div', { className: 'bar' }, [el('span')]);
    bar.firstChild.style.width = pct + '%';
    return el('div', { className: 'bar-row' }, [el('span', { text: label }), bar, el('span', { className: 'bar-num', text: n + '건 (' + pct + '%)' })]);
  }

  function renderStats(list) {
    const box = $('stats');
    box.replaceChildren();
    const students = new Set(list.map(function (a) { return a.key; }));
    const count = function (st) { return list.filter(function (a) { return a.status === st; }).length; };
    box.appendChild(el('div', { className: 'card stat' }, [
      el('h3', { text: '현황' }),
      el('p', null, [el('span', { className: 'big', text: String(students.size) }), ' 명 · 활동 ' + list.length + '건']),
      el('p', { className: 'muted', text: '완료 ' + count('done') + ' · 피드백 대기 ' + count('waiting') + ' · 작성 중 ' + count('writing') })
    ]));
    const subs = list.filter(function (a) { return a.submission; });
    const cat = el('div', { className: 'card stat' }, [el('h3', { text: '검토 관점별 선택 수' })]);
    ['타당성', '공정성', '신뢰성'].forEach(function (c) {
      cat.appendChild(barRow(c, subs.filter(function (a) { return a.submission.criterion_category === c; }).length, subs.length));
    });
    box.appendChild(cat);
    const typ = el('div', { className: 'card stat' }, [el('h3', { text: '질문 유형별 비율' })]);
    ['확인 질문', '검증 질문'].forEach(function (t) {
      typ.appendChild(barRow(t, subs.filter(function (a) { return a.submission.question_type === t; }).length, subs.length));
    });
    box.appendChild(typ);
  }

  function statusBadge(st) { return el('span', { className: 'status ' + STATUS[st][1], text: STATUS[st][0] }); }

  function renderStudents(list) {
    const groups = {};
    list.forEach(function (a) {
      if (!groups[a.key]) groups[a.key] = { key: a.key, number: a.number, name: a.name, items: [] };
      groups[a.key].items.push(a);
    });
    const arr = Object.keys(groups).map(function (k) { return groups[k]; })
      .sort(function (x, y) { return x.number.localeCompare(y.number, 'ko', { numeric: true }) || x.name.localeCompare(y.name, 'ko'); });
    $('studentCount').textContent = arr.length + '명';
    const box = $('studentList');
    box.replaceChildren();
    if (!arr.length) { box.appendChild(el('p', { className: 'empty', text: activities.length ? '조건에 맞는 기록이 없습니다.' : '아직 학생 활동 기록이 없습니다.' })); return; }
    arr.forEach(function (g) {
      const last = g.items.map(function (a) { return a.last; }).sort().pop();
      const best = g.items.some(function (a) { return a.status === 'done'; }) ? 'done'
        : (g.items.some(function (a) { return a.status === 'waiting'; }) ? 'waiting' : 'writing');
      const btn = el('button', { className: 'student-item' + (g.key === selectedKey ? ' active' : ''), attrs: { type: 'button' } }, [
        el('div', { className: 'top' }, [el('span', { text: g.number + ' ' + g.name }), statusBadge(best)]),
        el('div', { className: 'sub', text: '활동 ' + g.items.length + '건 · 최근 ' + fmtTime(last) })
      ]);
      btn.addEventListener('click', function () { selectedKey = g.key; render(); });
      box.appendChild(btn);
    });
  }

  function sec(title, content) { return el('div', { className: 'sec' }, [el('h4', { text: title }), content]); }
  function box(text, extra) { return el('div', { className: 'box' + (extra ? ' ' + extra : ''), text: str(text) || '-' }); }

  function timeline(a) {
    const ol = el('ol', { className: 'timeline' });
    if (!a.events.length) { ol.appendChild(el('li', { text: '기록된 단계가 없습니다.' })); return ol; }
    const startMs = toMs(whenOf(a.events[0]));
    let prevMs = null;
    a.events.forEach(function (e) {
      const t = whenOf(e);
      const ms = toMs(t);
      const li = el('li', null, [el('strong', { text: EVENT_LABELS[e.event] || str(e.event) }), ' ', el('span', { className: 'muted', text: fmtTime(t) })]);
      const parts = [];
      if (prevMs !== null && ms !== null) parts.push('이전 단계에서 ' + fmtDur(ms - prevMs));
      if (prevMs !== null && startMs !== null && ms !== null) parts.push('시작부터 ' + fmtDur(ms - startMs));
      if (parts.length) li.appendChild(el('div', { className: 'dur', text: parts.join(' · ') }));
      ol.appendChild(li);
      if (ms !== null) prevMs = ms;
    });
    return ol;
  }

  function renderDetail(list) {
    const detail = $('detail');
    detail.replaceChildren();
    const mine = list.filter(function (a) { return a.key === selectedKey; })
      .sort(function (x, y) { return y.first.localeCompare(x.first); });
    if (!selectedKey || !mine.length) {
      $('detailTitle').textContent = '학생을 선택하세요';
      detail.appendChild(el('p', { className: 'empty', text: '왼쪽 목록에서 학생을 선택하면 활동 과정이 표시됩니다.' }));
      return;
    }
    $('detailTitle').textContent = mine[0].number + ' ' + mine[0].name + ' · 활동 ' + mine.length + '건';
    mine.forEach(function (a, idx) {
      const sub = a.submission;
      const summary = el('summary', null, [
        el('strong', { text: fmtTime(a.first) }),
        statusBadge(a.status),
        sub ? el('span', { className: 'badge badge-' + sub.criterion_category, text: sub.criterion_category }) : null,
        sub ? el('span', { className: 'badge badge-type', text: sub.question_type }) : null,
        sub && sub.topic ? el('span', { className: 'muted', text: sub.topic }) : null
      ]);
      const body = el('div', { className: 'session-body' });
      body.appendChild(sec('단계별 타임라인', timeline(a)));
      if (sub) {
        body.appendChild(sec('논제 · 상대 측 입장', box((sub.topic || '(입력하지 않음)') + ' · ' + (sub.opponent_stance || '모름'))));
        body.appendChild(sec('상대 측 입론문', box(sub.opponent_essay, 'scroll')));
        body.appendChild(sec('선택한 검토 관점', box(sub.criterion_category + ' — ' + sub.criterion_question)));
        if (sub.quoted_part) body.appendChild(sec('옮겨 적은 부분', box(sub.quoted_part)));
        body.appendChild(sec('문제점에 대한 생각', box(sub.problem_thought)));
        body.appendChild(sec('질문 유형 · 학생 질문', box('[' + sub.question_type + '] ' + sub.student_question)));
        body.appendChild(sec('학생이 ChatGPT에 보낸 요청문',
          el('details', { className: 'box' }, [el('summary', { text: '요청문 펼쳐 보기' }), el('div', { text: sub.chatgpt_prompt || '-' })])));
      } else {
        body.appendChild(sec('입력 내용', box('아직 4단계(질문 확정)까지 진행하지 않아 입력 내용이 없습니다. 위 타임라인에서 진행 단계를 확인하세요.')));
      }
      if (a.feedback) {
        const fmt = a.feedback.format_ok === 'true' ? '' : ' (요청한 형식과 다름)';
        body.appendChild(sec('붙여 넣은 ChatGPT 답변' + fmt + ' · ' + fmtTime(whenOf(a.feedback)), box(a.feedback.chatgpt_response, 'scroll')));
      } else if (sub) {
        body.appendChild(sec('ChatGPT 답변', box('아직 저장하지 않았습니다.')));
      }
      body.appendChild(el('p', { className: 'muted', text: '활동 ID: ' + a.id }));
      const det = el('details', { className: 'session' }, [summary, body]);
      det.dataset.id = a.id;
      det.open = openIds.has(a.id) || (openIds.size === 0 && idx === 0);
      det.addEventListener('toggle', function () { if (det.open) openIds.add(a.id); else openIds.delete(a.id); });
      detail.appendChild(det);
    });
  }

  // ===== CSV =====
  function csvCell(v) {
    let t = str(v);
    if (/^[=+\-@]/.test(t)) t = "'" + t;   // 엑셀 수식 실행 방지
    return '"' + t.replace(/"/g, '""') + '"';
  }

  function downloadCsv() {
    const list = filtered().sort(function (x, y) { return x.number.localeCompare(y.number, 'ko', { numeric: true }) || x.first.localeCompare(y.first); });
    const header = ['학번', '이름', '상태', '활동 시작', '마지막 기록', '총 소요 시간', '논제', '상대 측 입장', '상대 측 입론문',
      '검토 관점', '검토 질문', '옮겨 적은 부분', '문제점', '질문 유형', '학생 질문', 'ChatGPT 답변', '답변 형식 일치', '활동 ID'];
    const rows = list.map(function (a) {
      const s = a.submission || {};
      const fb = a.feedback || {};
      const total = (toMs(a.first) !== null && toMs(a.last) !== null) ? fmtDur(toMs(a.last) - toMs(a.first)) : '';
      return [a.number, a.name, STATUS[a.status][0], fmtTime(a.first), fmtTime(a.last), total, s.topic, s.opponent_stance, s.opponent_essay,
        s.criterion_category, s.criterion_question, s.quoted_part, s.problem_thought, s.question_type, s.student_question,
        fb.chatgpt_response, a.feedback ? (fb.format_ok === 'true' ? '예' : '아니요') : '', a.id];
    });
    const csv = '﻿' + [header].concat(rows).map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    const d = new Date();
    const pad = function (n) { return String(n).padStart(2, '0'); };
    link.href = URL.createObjectURL(blob);
    link.download = '반대신문_활동기록_' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.csv';
    document.body.appendChild(link);
    link.click();
    setTimeout(function () { URL.revokeObjectURL(link.href); link.remove(); }, 1500);
  }

  // ===== 새로고침 =====
  async function refresh(manual) {
    const pw = pwGet();
    if (!pw || loading) return;
    loading = true;
    const b = $('btnRefresh');
    if (manual) { b.disabled = true; b.textContent = '불러오는 중…'; }
    try {
      const data = await load(pw);
      const raw = JSON.stringify(data);
      if (raw !== lastRaw) {   // 바뀐 내용이 있을 때만 다시 그림 (펼친 항목·스크롤 유지)
        lastRaw = raw;
        activities = build(data);
        render();
      }
      $('metaText').textContent = '마지막 확인 ' + new Date().toLocaleTimeString('ko-KR') + ' · 전체 활동 ' + activities.length + '건';
    } catch (e) {
      $('metaText').textContent = '불러오기 실패: ' + e.message + ' (잠시 후 다시 시도해요)';
      if (/비밀번호/.test(e.message)) logout();
    } finally {
      loading = false;
      if (manual) { b.disabled = false; b.textContent = '지금 새로고침'; }
    }
  }

  function schedule() {
    clearInterval(timer);
    if ($('autoRefresh').checked) timer = setInterval(function () { if (!document.hidden) refresh(false); }, REFRESH_MS);
  }

  async function login(password, silent) {
    const btn = $('btnLogin');
    btn.disabled = true; btn.textContent = '불러오는 중…';
    $('loginError').textContent = '';
    try {
      const data = await load(password);
      pwSet(password);
      lastRaw = JSON.stringify(data);
      activities = build(data);
      $('loginView').hidden = true;
      $('dashView').hidden = false;
      $('metaText').textContent = '마지막 확인 ' + new Date().toLocaleTimeString('ko-KR') + ' · 전체 활동 ' + activities.length + '건';
      render();
      schedule();
    } catch (e) {
      if (!silent) $('loginError').textContent = e.message;
      pwClear();
      $('loginView').hidden = false;
      $('dashView').hidden = true;
    } finally {
      btn.disabled = false; btn.textContent = '열람하기';
    }
  }

  function logout() {
    pwClear();
    clearInterval(timer);
    activities = []; lastRaw = ''; selectedKey = null; openIds.clear();
    $('password').value = '';
    $('dashView').hidden = true;
    $('loginView').hidden = false;
  }

  function init() {
    if (!API_URL) $('configNotice').hidden = false;
    $('loginForm').addEventListener('submit', function (e) {
      e.preventDefault();
      const pw = $('password').value;
      if (pw) login(pw, false);
    });
    $('btnRefresh').addEventListener('click', function () { refresh(true); });
    $('autoRefresh').addEventListener('change', schedule);
    $('btnCsv').addEventListener('click', downloadCsv);
    $('btnLogout').addEventListener('click', logout);
    ['fNumber', 'fName'].forEach(function (id) { $(id).addEventListener('input', render); });
    ['fCategory', 'fType', 'fStatus', 'fFrom', 'fTo'].forEach(function (id) { $(id).addEventListener('change', render); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden && !$('dashView').hidden) refresh(false); });
    const saved = pwGet();
    if (saved) login(saved, true);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
