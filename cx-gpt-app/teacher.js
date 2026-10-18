(function () {
  'use strict';

  // 불러온 기록은 이 변수(메모리)에만 있고 어디에도 저장하지 않습니다.
  let records = [];          // { data, fileNames: [], fp, conflict }
  let duplicateFiles = 0;
  let failedFiles = [];      // { name, reason }
  let selectedKey = null;

  const MAX_FILE_BYTES = 2 * 1024 * 1024;
  const STEP_LABELS = {
    start: '활동 시작',
    essay_done: '1단계 완료 · 입론문 입력',
    criterion_done: '2단계 완료 · 검토 관점 선택',
    problem_done: '3단계 완료 · 문제점 작성',
    question_confirmed: '4단계 · 질문 확정',
    prompt_copied: '요청문 복사',
    feedback_saved: '5단계 · ChatGPT 답변 저장',
    reflection_done: '6단계 · 성찰 완료',
    file_downloaded: '기록 파일 내려받음'
  };

  const $ = function (id) { return document.getElementById(id); };
  const str = function (v) { return v === null || v === undefined ? '' : String(v); };

  function el(tag, opts, children) {
    const node = document.createElement(tag);
    if (opts) {
      if (opts.className) node.className = opts.className;
      if (opts.text !== undefined) node.textContent = opts.text;
      if (opts.attrs) Object.keys(opts.attrs).forEach(function (k) { node.setAttribute(k, opts.attrs[k]); });
    }
    (children || []).forEach(function (c) {
      if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  // ===== 시간 =====
  function fmtTime(ts) {
    const t = str(ts);
    return t ? t.slice(0, 10) + ' ' + t.slice(11, 19) : '-';
  }
  function toMs(ts) {
    const t = Date.parse(str(ts));
    return isNaN(t) ? null : t;
  }
  function fmtDur(ms) {
    if (ms === null || ms < 0) return '';
    const sec = Math.round(ms / 1000);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), r = sec % 60;
    if (h) return h + '시간 ' + m + '분';
    if (m) return m + '분 ' + r + '초';
    return r + '초';
  }

  // ===== 파일 검사 =====
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  function validate(d) {
    if (!isObj(d)) return '활동 기록 형식이 아닙니다.';
    if (d.app !== 'cx-question') return '이 앱의 활동 기록 파일이 아닙니다.';
    if (d.format_version !== 1) return '지원하지 않는 파일 형식 버전입니다.';
    if (typeof d.activity_id !== 'string' || !d.activity_id) return '활동 ID가 없습니다.';
    if (d.status !== 'completed' && d.status !== 'in_progress') return '활동 상태 값이 올바르지 않습니다.';
    if (!isObj(d.student) || !str(d.student.number).trim() || !str(d.student.name).trim()) return '학번 또는 이름이 없습니다.';
    if (!Array.isArray(d.steps)) return '활동 단계 기록이 없습니다.';
    const parts = ['essay', 'criterion', 'problem', 'question', 'chatgpt', 'reflection'];
    for (let i = 0; i < parts.length; i++) {
      if (!isObj(d[parts[i]])) return '필요한 항목(' + parts[i] + ')이 없습니다.';
    }
    return '';
  }

  // 같은 활동을 여러 번 내려받으면 file_downloaded 단계만 다르므로 비교할 때 제외
  function fingerprint(d) {
    const copy = JSON.parse(JSON.stringify(d));
    copy.steps = copy.steps.filter(function (x) { return !(x && x.step === 'file_downloaded'); });
    return JSON.stringify(copy);
  }

  function readFile(file) {
    return new Promise(function (resolve) {
      if (!/\.json$/i.test(file.name)) { resolve({ error: '.json 파일이 아닙니다.' }); return; }
      if (file.size > MAX_FILE_BYTES) { resolve({ error: '파일이 너무 큽니다(2MB 초과).' }); return; }
      const reader = new FileReader();
      reader.onload = function () {
        let data;
        try { data = JSON.parse(String(reader.result).replace(/^﻿/, '')); } catch (e) {
          resolve({ error: 'JSON 형식이 올바르지 않습니다.' }); return;
        }
        const reason = validate(data);
        resolve(reason ? { error: reason } : { data: data });
      };
      reader.onerror = function () { resolve({ error: '파일을 읽지 못했습니다.' }); };
      reader.readAsText(file, 'utf-8');
    });
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    let added = 0, dupNow = 0;
    const failedNow = [];
    for (const file of files) {
      const res = await readFile(file);
      if (res.error) { failedNow.push({ name: file.name, reason: res.error }); continue; }
      const d = res.data;
      const fp = fingerprint(d);
      const same = records.filter(function (r) { return r.data.activity_id === d.activity_id; });
      const exact = same.filter(function (r) { return r.fp === fp; })[0];
      if (exact) {
        exact.fileNames.push(file.name);
        dupNow++;
        continue;
      }
      const rec = { data: d, fileNames: [file.name], fp: fp, conflict: same.length > 0 };
      same.forEach(function (r) { r.conflict = true; });
      records.push(rec);
      added++;
    }
    duplicateFiles += dupNow;
    failedFiles = failedFiles.concat(failedNow);
    renderReport(added, dupNow, failedNow);
    $('dashView').hidden = records.length === 0;
    render();
  }

  function renderReport(added, dupNow, failedNow) {
    const box = $('loadReport');
    box.replaceChildren();
    const parts = ['새 기록 ' + added + '개를 불러왔어요.'];
    if (dupNow) parts.push('중복 파일 ' + dupNow + '개는 한 번만 표시해요.');
    const conflicts = new Set(records.filter(function (r) { return r.conflict; }).map(function (r) { return r.data.activity_id; })).size;
    if (conflicts) parts.push('내용이 다른 중복 기록 ' + conflicts + '건이 있어요(목록에 표시).');
    const wrap = el('div', null, [el('p', { text: parts.join(' ') })]);
    if (failedFiles.length) {
      const ul = el('ul');
      failedFiles.forEach(function (f) { ul.appendChild(el('li', { text: f.name + ' — ' + f.reason })); });
      wrap.appendChild(el('p', { text: '읽지 못한 파일 ' + failedFiles.length + '개:' }));
      wrap.appendChild(ul);
    }
    box.className = 'notice load-report' + (failedNow.length ? ' notice-warn' : '');
    box.appendChild(wrap);
    box.hidden = false;
  }

  // ===== 필터 =====
  function keyOf(d) { return str(d.student.number).trim() + '|' + str(d.student.name).trim(); }

  function filtered() {
    const f = {
      number: $('fNumber').value.trim(), name: $('fName').value.trim(),
      category: $('fCategory').value, type: $('fType').value, status: $('fStatus').value,
      from: $('fFrom').value, to: $('fTo').value
    };
    return records.filter(function (r) {
      const d = r.data;
      if (f.number && str(d.student.number).indexOf(f.number) === -1) return false;
      if (f.name && str(d.student.name).indexOf(f.name) === -1) return false;
      if (f.category && str(d.criterion.category) !== f.category) return false;
      if (f.type && str(d.question.type) !== f.type) return false;
      if (f.status && d.status !== f.status) return false;
      const day = str(d.started_at).slice(0, 10);   // 한국 시간(+09:00) 기준 날짜
      if (f.from && day < f.from) return false;
      if (f.to && day > f.to) return false;
      return true;
    });
  }

  // ===== 렌더링 =====
  function render() {
    const list = filtered();
    $('metaText').textContent = '불러온 활동 ' + records.length + '건 · 표시 중 ' + list.length + '건';
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
    const students = new Set(list.map(function (r) { return keyOf(r.data); }));
    const done = list.filter(function (r) { return r.data.status === 'completed'; }).length;
    box.appendChild(el('div', { className: 'card stat' }, [
      el('h3', { text: '현황' }),
      el('p', null, [el('span', { className: 'big', text: String(students.size) }), ' 명 · 활동 ' + list.length + '건']),
      el('p', { className: 'muted', text: '완료 ' + done + '건 · 진행 중 ' + (list.length - done) + '건' })
    ]));
    const withCriterion = list.filter(function (r) { return r.data.criterion.category; });
    const cat = el('div', { className: 'card stat' }, [el('h3', { text: '검토 관점별 선택 수' })]);
    ['타당성', '공정성', '신뢰성'].forEach(function (c) {
      cat.appendChild(barRow(c, withCriterion.filter(function (r) { return r.data.criterion.category === c; }).length, withCriterion.length));
    });
    box.appendChild(cat);
    const withType = list.filter(function (r) { return r.data.question.type; });
    const typ = el('div', { className: 'card stat' }, [el('h3', { text: '질문 유형별 비율' })]);
    ['확인 질문', '검증 질문'].forEach(function (t) {
      typ.appendChild(barRow(t, withType.filter(function (r) { return r.data.question.type === t; }).length, withType.length));
    });
    box.appendChild(typ);
  }

  function statusBadge(status) {
    return status === 'completed'
      ? el('span', { className: 'status status-done', text: '완료' })
      : el('span', { className: 'status status-progress', text: '진행 중' });
  }

  function lastTime(d) {
    const times = d.steps.map(function (x) { return x && x.at; }).concat([d.finished_at, d.started_at])
      .filter(function (t) { return toMs(t) !== null; }).sort(function (a, b) { return toMs(a) - toMs(b); });
    return times[times.length - 1] || '';
  }

  function renderStudents(list) {
    const groups = {};
    list.forEach(function (r) {
      const k = keyOf(r.data);
      if (!groups[k]) groups[k] = { key: k, number: str(r.data.student.number), name: str(r.data.student.name), recs: [] };
      groups[k].recs.push(r);
    });
    const arr = Object.keys(groups).map(function (k) { return groups[k]; })
      .sort(function (a, b) { return a.number.localeCompare(b.number, 'ko', { numeric: true }) || a.name.localeCompare(b.name, 'ko'); });
    $('studentCount').textContent = arr.length + '명';
    const box = $('studentList');
    box.replaceChildren();
    if (!arr.length) { box.appendChild(el('p', { className: 'empty', text: '조건에 맞는 기록이 없습니다.' })); return; }
    arr.forEach(function (g) {
      const last = g.recs.map(function (r) { return lastTime(r.data); }).sort().pop();
      const anyDone = g.recs.some(function (r) { return r.data.status === 'completed'; });
      const anyConflict = g.recs.some(function (r) { return r.conflict; });
      const btn = el('button', { className: 'student-item' + (g.key === selectedKey ? ' active' : ''), attrs: { type: 'button' } }, [
        el('div', { className: 'top' }, [
          el('span', { text: g.number + ' ' + g.name }),
          el('span', null, [anyConflict ? el('span', { className: 'status status-conflict', text: '중복 확인' }) : null, ' ', statusBadge(anyDone ? 'completed' : 'in_progress')])
        ]),
        el('div', { className: 'sub', text: '활동 ' + g.recs.length + '건 · 최근 ' + fmtTime(last) })
      ]);
      btn.addEventListener('click', function () { selectedKey = g.key; render(); });
      box.appendChild(btn);
    });
  }

  function sec(title, content) { return el('div', { className: 'sec' }, [el('h4', { text: title }), content]); }
  function box(text, extra) { return el('div', { className: 'box' + (extra ? ' ' + extra : ''), text: str(text) || '-' }); }

  function timeline(d) {
    const ol = el('ol', { className: 'timeline' });
    const steps = d.steps.filter(function (x) { return isObj(x); });
    if (!steps.length) { ol.appendChild(el('li', { text: '기록된 단계가 없습니다.' })); return ol; }
    const startMs = toMs(d.started_at) !== null ? toMs(d.started_at) : toMs(steps[0].at);
    let prevMs = null;
    steps.forEach(function (x) {
      const ms = toMs(x.at);
      const li = el('li', null, [el('strong', { text: STEP_LABELS[x.step] || str(x.step) }), ' ', el('span', { className: 'muted', text: fmtTime(x.at) })]);
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
    const mine = list.filter(function (r) { return keyOf(r.data) === selectedKey; })
      .sort(function (a, b) { return str(b.data.started_at).localeCompare(str(a.data.started_at)); });
    if (!selectedKey || !mine.length) {
      $('detailTitle').textContent = '학생을 선택하세요';
      detail.appendChild(el('p', { className: 'empty', text: '왼쪽 목록에서 학생을 선택하면 활동 과정이 표시됩니다.' }));
      return;
    }
    $('detailTitle').textContent = str(mine[0].data.student.number) + ' ' + str(mine[0].data.student.name) + ' · 활동 ' + mine.length + '건';

    mine.forEach(function (r, idx) {
      const d = r.data;
      const summary = el('summary', null, [
        el('strong', { text: fmtTime(d.started_at) }),
        statusBadge(d.status),
        r.conflict ? el('span', { className: 'status status-conflict', text: '내용이 다른 중복 기록' }) : null,
        d.criterion.category ? el('span', { className: 'badge badge-' + str(d.criterion.category), text: str(d.criterion.category) }) : null,
        d.question.type ? el('span', { className: 'badge badge-type', text: str(d.question.type) }) : null,
        d.essay.topic ? el('span', { className: 'muted', text: str(d.essay.topic) }) : null
      ]);
      const body = el('div', { className: 'session-body' });
      if (r.conflict) {
        body.appendChild(el('p', { className: 'flag', text: '같은 활동 ID인데 내용이 다른 파일이 있어요. 진행 중에 내려받은 파일과 완료 후 내려받은 파일이거나, 파일이 수정되었을 수 있어요.' }));
      }
      body.appendChild(sec('단계별 타임라인', timeline(d)));
      body.appendChild(sec('논제 · 상대 측 입장', box((str(d.essay.topic) || '(입력하지 않음)') + ' · ' + (str(d.essay.opponent_stance) || '모름'))));
      body.appendChild(sec('상대 측 입론문', box(d.essay.text, 'scroll')));
      body.appendChild(sec('선택한 검토 관점', box(d.criterion.question ? str(d.criterion.category) + ' — ' + str(d.criterion.question) : '')));
      if (d.problem.quoted_part) body.appendChild(sec('옮겨 적은 부분', box(d.problem.quoted_part)));
      body.appendChild(sec('문제점에 대한 생각', box(d.problem.thought)));
      body.appendChild(sec('질문 유형 · 학생 질문', box(d.question.text ? '[' + str(d.question.type) + '] ' + str(d.question.text) : '')));
      const promptBox = el('details', { className: 'box' }, [el('summary', { text: '요청문 펼쳐 보기' }), el('div', { text: str(d.chatgpt.prompt) || '-' })]);
      body.appendChild(sec('학생이 ChatGPT에 보낸 요청문', promptBox));
      const fmt = d.chatgpt.response ? (d.chatgpt.format_ok ? '' : ' (요청한 형식과 다름)') : '';
      body.appendChild(sec('붙여 넣은 ChatGPT 답변' + fmt + (d.chatgpt.pasted_at ? ' · ' + fmtTime(d.chatgpt.pasted_at) : ''), box(d.chatgpt.response, 'scroll')));
      body.appendChild(sec('최종 질문 · 성찰', box(
        '최종 질문: ' + (str(d.reflection.final_question) || '(작성하지 않음)') + '\n알게 된 점: ' + (str(d.reflection.learned) || '(작성하지 않음)'))));
      body.appendChild(el('p', { className: 'muted', text: '파일: ' + r.fileNames.join(', ') + ' · 활동 ID: ' + d.activity_id }));
      const det = el('details', { className: 'session' }, [summary, body]);
      if (idx === 0) det.open = true;
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
    const list = filtered().sort(function (a, b) {
      return str(a.data.student.number).localeCompare(str(b.data.student.number), 'ko', { numeric: true }) ||
        str(a.data.started_at).localeCompare(str(b.data.started_at));
    });
    const header = ['학번', '이름', '상태', '활동 시작', '활동 완료', '총 소요 시간', '논제', '상대 측 입장', '상대 측 입론문',
      '검토 관점', '검토 질문', '옮겨 적은 부분', '문제점', '질문 유형', '학생 질문', 'ChatGPT 답변', '답변 형식 일치',
      '최종 질문', '알게 된 점', '중복 확인 필요', '파일 이름', '활동 ID'];
    const rows = list.map(function (r) {
      const d = r.data;
      const total = (toMs(d.started_at) !== null && toMs(d.finished_at) !== null) ? fmtDur(toMs(d.finished_at) - toMs(d.started_at)) : '';
      return [d.student.number, d.student.name, d.status === 'completed' ? '완료' : '진행 중', fmtTime(d.started_at), d.finished_at ? fmtTime(d.finished_at) : '', total,
        d.essay.topic, d.essay.opponent_stance, d.essay.text, d.criterion.category, d.criterion.question,
        d.problem.quoted_part, d.problem.thought, d.question.type, d.question.text, d.chatgpt.response,
        d.chatgpt.response ? (d.chatgpt.format_ok ? '예' : '아니요') : '',
        d.reflection.final_question, d.reflection.learned, r.conflict ? '예' : '', r.fileNames.join(', '), d.activity_id];
    });
    const csv = '﻿' + [header].concat(rows).map(function (row) { return row.map(csvCell).join(','); }).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    const now = new Date();
    const pad = function (n) { return String(n).padStart(2, '0'); };
    a.href = URL.createObjectURL(blob);
    a.download = '반대신문_활동기록_' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }

  // ===== 연결 =====
  function init() {
    const input = $('fileInput');
    input.addEventListener('change', function () { addFiles(input.files).then(function () { input.value = ''; }); });
    const dz = $('dropzone');
    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('over'); });
    });
    dz.addEventListener('drop', function (e) { addFiles(e.dataTransfer && e.dataTransfer.files); });
    // 영역 밖에 떨어뜨려 파일이 브라우저에서 열리는 일을 방지
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });

    $('btnCsv').addEventListener('click', downloadCsv);
    ['fNumber', 'fName'].forEach(function (id) { $(id).addEventListener('input', render); });
    ['fCategory', 'fType', 'fStatus', 'fFrom', 'fTo'].forEach(function (id) { $(id).addEventListener('change', render); });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
