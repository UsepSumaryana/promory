/**
 * Smoke test end-to-end lewat HTTP, bukan lewat pemanggilan fungsi langsung —
 * yang perlu dibuktikan adalah jalur yang benar-benar dipakai Claude Code:
 * auth bearer, handshake MCP, lalu tool call.
 */
const URL_ = process.env.PM_URL ?? 'http://127.0.0.1:8787';
const TOKEN = process.env.PM_TOKEN ?? 'tok_test';

let sessionId = null;
let failed = 0;

async function rpc(method, params) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${TOKEN}`,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(`${URL_}/`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params }),
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const raw = await res.text();
  if (!res.ok) return { httpStatus: res.status, raw };
  // Transport boleh menjawab sebagai SSE; ambil payload JSON dari baris data:.
  const line = raw.includes('data:') ? raw.split('\n').find((l) => l.startsWith('data:'))?.slice(5) : raw;
  try {
    return JSON.parse(line);
  } catch {
    return { raw };
  }
}

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}

const unauth = await fetch(`${URL_}/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
check('tanpa token ditolak 401', unauth.status === 401, `status ${unauth.status}`);

const init = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'smoke', version: '1.0.0' },
});
check('initialize', !!init.result, JSON.stringify(init.error ?? init.result?.serverInfo ?? init.raw ?? '').slice(0, 160));

await fetch(`${URL_}/`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${TOKEN}`,
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  },
  body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
});

const tools = await rpc('tools/list', {});
const names = (tools.result?.tools ?? []).map((t) => t.name).sort();
check('tools/list memuat 7 tool', names.length === 7, names.join(', '));

const call = (name, args) => rpc('tools/call', { name, arguments: args });
const out = (r) => r.result?.content?.[0]?.text ?? JSON.stringify(r.error ?? r).slice(0, 200);

const w1 = await call('memory_write', {
  repo: 'demo-repo',
  scope: 'shared',
  type: 'gotcha',
  title: 'Judul uji',
  body: 'Isi uji menyebut src/contoh.ts',
  why: 'supaya tidak ditelusuri ulang',
});
check('memory_write membuat entri', out(w1).includes('Tersimpan'), out(w1));

const w2 = await call('memory_write', {
  repo: 'demo-repo',
  scope: 'shared',
  type: 'gotcha',
  title: 'Judul uji',
  body: 'Isi uji yang diperbarui',
});
check('judul sama memperbarui, bukan menduplikasi', out(w2).includes('Diperbarui'), out(w2));

const secret = await call('memory_write', {
  repo: 'demo-repo',
  scope: 'shared',
  type: 'env',
  title: 'Kredensial',
  body: 'password = hunter2supersecret',
});
check('kredensial ditolak', out(secret).toLowerCase().includes('ditolak'), out(secret));

const a1 = await call('adr_write', {
  repo: 'demo-repo',
  title: 'Keputusan pertama',
  context: 'konteks',
  decision: 'keputusan',
  alternatives: 'opsi lain ditolak',
});
check('adr_write memberi nomor ADR-0001', out(a1).includes('ADR-0001'), out(a1));

const a2 = await call('adr_write', {
  repo: 'demo-repo',
  title: 'Keputusan pengganti',
  context: 'konteks baru',
  decision: 'keputusan baru',
  supersedes: 1,
});
check('supersede menandai ADR lama', out(a2).includes('superseded'), out(a2));

const list = await call('adr_list', { repo: 'demo-repo' });
check('ADR lama tetap ada setelah disupersede', out(list).includes('ADR-0001'), out(list).replace(/\n/g, ' | '));

await call('lineage_put', {
  repo: 'demo-repo',
  branch: 'fitur-x',
  parent_branch: 'main',
  fork_point: 'abc1234',
  merged_in: ['main @ 2026-08-27'],
  note: 'dikoreksi dari tebakan script',
});

await call('memory_write', {
  repo: 'demo-repo',
  scope: 'branch',
  branch: 'induk',
  type: 'bispro',
  title: 'Fakta induk',
  body: 'diwarisi ke branch anak',
});

const recall = await call('memory_recall', { repo: 'demo-repo', branch: 'fitur-x', inherit_from: ['induk'] });
const r = out(recall);
check('recall memuat memory bersama', r.includes('Judul uji'));
check('recall mewarisi memory branch induk', r.includes('Fakta induk'));
check('recall memuat ADR', r.includes('ADR-0002'));
check('recall memuat lineage', r.includes('fork: abc1234'));
check('recall mencatat author dari token', r.includes('uji-otomatis'), r.slice(0, 120));

const empty = await call('memory_recall', { repo: 'repo-kosong', branch: 'main' });
check('repo tanpa memory menyuruh jangan mengarang', out(empty).includes('Jangan mengarang'), out(empty));

const search = await call('memory_search', { repo: 'demo-repo', query: 'Isi uji yang diperbarui' });
check('memory_search menemukan lewat isi', out(search).includes('Judul uji'), out(search));


/* ---------- admin API + kontrol akses ---------- */
const adminFetch = (path, opts = {}) =>
  fetch(`${URL_}${path}`, {
    ...opts,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(opts.headers || {}) },
  });

const me = await (await adminFetch('/api/me')).json();
check('GET /api/me mengenali admin', me.role === 'admin', JSON.stringify(me));

const ui = await fetch(`${URL_}/ui`);
const uiBody = await ui.text();
check('/ui disajikan tanpa token', ui.ok && uiBody.includes('project-memory'), `status ${ui.status}`);

const repos = await (await adminFetch('/api/repos')).json();
check('GET /api/repos memuat demo-repo', repos.some((r) => r.repo === 'demo-repo'), JSON.stringify(repos));

const entries = await (await adminFetch('/api/entries?repo=demo-repo')).json();
check('GET /api/entries mengembalikan entri', entries.length > 0, `${entries.length} entri`);

const target = entries.find((e) => e.title === 'Judul uji');
const patched = await (await adminFetch(`/api/entries/${target.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ body: 'Disunting lewat GUI' }),
})).json();
check('PATCH entri menyimpan perubahan', patched.body === 'Disunting lewat GUI', patched.body);
check('suntingan dicatat atas nama kurator', patched.author.includes('kurasi'), patched.author);

const newUser = await (await adminFetch('/api/users', {
  method: 'POST',
  body: JSON.stringify({ name: 'anggota-uji', role: 'member' }),
})).json();
check('POST /api/users mengembalikan token sekali', typeof newUser.token === 'string' && newUser.token.startsWith('pm_'));

const memberProbe = await fetch(`${URL_}/api/users`, { headers: { authorization: `Bearer ${newUser.token}` } });
check('member ditolak dari /api (403)', memberProbe.status === 403, `status ${memberProbe.status}`);

const users = await (await adminFetch('/api/users')).json();
const adminRow = users.find((u) => u.role === 'admin');
const lastAdmin = await adminFetch(`/api/users/${adminRow.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ disabled: true }),
});
check('menonaktifkan admin terakhir ditolak (409)', lastAdmin.status === 409, `status ${lastAdmin.status}`);

const memberRow = users.find((u) => u.name === 'anggota-uji');
const disabled = await adminFetch(`/api/users/${memberRow.id}`, { method: 'PATCH', body: JSON.stringify({ disabled: true }) });
check('menonaktifkan member diizinkan', disabled.ok, `status ${disabled.status}`);

const revoked = await fetch(`${URL_}/api/me`, { headers: { authorization: `Bearer ${newUser.token}` } });
check('token yang dinonaktifkan langsung ditolak (401)', revoked.status === 401, `status ${revoked.status}`);

/* ---------- umur entri, promosi branch, statistik pemakaian ---------- */

// Umur entri harus sampai ke briefing. Tanpa ini, entri berumur setengah tahun
// tampak setara dengan yang ditulis kemarin, padahal teks suntikannya menyuruh
// model memakai memory alih-alih membaca kode.
const briefAge = await fetch(`${URL_}/brief?repo=demo-repo&branch=fitur-x&mode=budget&budget=6000`, {
  headers: { authorization: `Bearer ${TOKEN}` },
});
const briefAgeBody = await briefAge.text();
check('briefing mencantumkan umur entri', /diperbarui (hari ini|kemarin|\d+ (hari|bulan|tahun) lalu|lebih dari setahun lalu)/.test(briefAgeBody), briefAgeBody.slice(0, 120));

// Promosi entri branch yang sudah ter-merge. Dibuat entri baru khusus supaya
// tidak bergantung pada sisa keadaan dari pemeriksaan sebelumnya.
await call('memory_write', {
  repo: 'demo-repo',
  scope: 'branch',
  branch: 'cabang-selesai',
  type: 'gotcha',
  title: 'Temuan di cabang yang sudah merged',
  body: 'Fakta yang lahir saat mengerjakan fitur di cabang ini.',
  why: 'Kalau tidak dipromosikan, hilang begitu cabangnya dihapus.',
});

// origin/<branch> BUKAN bukti merge — itu hanya ref pelacak remote dari branch
// yang sama. Kalau filter ini rusak, setiap branch yang pernah di-push akan
// langsung dipromosikan.
const noPromote = await call('lineage_put', {
  repo: 'demo-repo',
  branch: 'cabang-selesai',
  parent_branch: 'induk',
  contained_by: ['origin/cabang-selesai'],
});
check('origin/<branch> tidak memicu promosi', !out(noPromote).includes('dipromosikan'), out(noPromote));

const promoted = await call('lineage_put', {
  repo: 'demo-repo',
  branch: 'cabang-selesai',
  parent_branch: 'induk',
  contained_by: ['origin/cabang-selesai', 'induk'],
});
check('branch yang termuat di induk mempromosikan entrinya', out(promoted).includes('dipromosikan'), out(promoted));

const afterPromote = await (await adminFetch('/api/entries?repo=demo-repo')).json();
const movedEntry = afterPromote.find((e) => e.title === 'Temuan di cabang yang sudah merged');
check('entri yang dipromosikan jadi shared tanpa branch', movedEntry?.scope === 'shared' && !movedEntry?.branch, JSON.stringify({ scope: movedEntry?.scope, branch: movedEntry?.branch }));

// Statistik pemakaian. /relevant dipanggil dua kali dengan sesi berbeda: server
// menyaring entri yang sudah dikirim PER SESI, jadi dua sesi berbeda harus
// menghasilkan dua hit untuk entri yang sama.
const relevantCall = (session, prompt) =>
  fetch(`${URL_}/relevant?repo=demo-repo&branch=fitur-x&budget=3000`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: session, prompt }),
  }).then((r) => r.text());

await relevantCall('smoke-a', 'ceritakan soal Judul uji dan isinya');
await relevantCall('smoke-b', 'ceritakan soal Judul uji dan isinya');

const usage = await (await adminFetch('/api/usage?repo=demo-repo')).json();
check('GET /api/usage meringkas pemakaian', typeof usage.total === 'number' && Array.isArray(usage.rows), JSON.stringify({ total: usage.total, never: usage.never, hits: usage.hits }));
const usedRow = usage.rows.find((r) => r.hits > 0);
check('penyuntikan tercatat sebagai hit', !!usedRow && !!usedRow.last_at, JSON.stringify(usedRow ?? null));
check('entri yang belum pernah tertarik tetap terdaftar', usage.rows.some((r) => r.hits === 0), `never=${usage.never}`);

/* ---------- pengingat per prompt, reset setelah compaction, briefing subagent ---------- */

const REMINDER = 'Sesi ini sudah berjalan beberapa putaran';
const relevantAs = (session, prompt, promptId) =>
  fetch(`${URL_}/relevant?repo=demo-repo&branch=fitur-x&budget=3000`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: session, prompt, prompt_id: promptId }),
  }).then((r) => r.text());

// prompt-memory.sh mengirim satu permintaan per repo aktif, dengan prompt_id
// yang sama. Tiga permintaan itu harus terhitung SATU prompt — dulu terhitung
// tiga, dan pengingat muncul di setiap prompt.
const nudged = [];
for (let p = 1; p <= 6; p++) {
  for (let repo = 1; repo <= 3; repo++) {
    if ((await relevantAs('smoke-nudge', 'zzqx wqyv', `prompt-${p}`)).includes(REMINDER)) nudged.push(`${p}.${repo}`);
  }
}
check('pengingat sekali per prompt walau tiga repo aktif', nudged.join(',') === '3.1,6.1', nudged.join(',') || '(tidak pernah)');

// Prompt tanpa kata yang bisa dicari tetap membawa pengingat bila gilirannya.
let shortPrompt = '';
for (let p = 1; p <= 3; p++) shortPrompt = await relevantAs('smoke-pendek', 'ok', `pendek-${p}`);
check('pengingat tetap muncul untuk prompt tanpa kata kunci', shortPrompt.includes(REMINDER), shortPrompt.slice(0, 80) || '(kosong)');

// Setelah compaction, SessionStart hook mereset sesi supaya entri yang ikut
// terringkas boleh disuntikkan lagi.
const ask = 'ceritakan soal Judul uji dan isinya';
const firstSend = await relevantAs('smoke-compact', ask, 'c-1');
const resend = await relevantAs('smoke-compact', ask, 'c-2');
check('entri tidak diulang dalam satu sesi', firstSend.includes('### Judul uji') && !resend.includes('### Judul uji'), resend.slice(0, 80) || '(kosong)');
const reset = await fetch(`${URL_}/session/reset?session=smoke-compact`, {
  method: 'POST',
  headers: { authorization: `Bearer ${TOKEN}` },
});
const afterReset = await relevantAs('smoke-compact', ask, 'c-3');
check('reset sesi membuka pengiriman ulang', reset.ok && afterReset.includes('### Judul uji'), `status ${reset.status}`);

// Subagent mewarisi entri yang sudah diterima agent induknya, plus orientasi.
const subagentBrief = (session) =>
  fetch(`${URL_}/brief?repo=demo-repo&branch=fitur-x&mode=subagent&budget=4000&session=${session}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  }).then((r) => r.text());
const inherited = await subagentBrief('smoke-compact');
check(
  'briefing subagent memuat entri yang sudah diterima induk',
  inherited.includes('### Judul uji') && inherited.includes('Memory tim untuk repo ini') && inherited.includes('Subagent tidak menerima'),
  inherited.slice(0, 120),
);
const fresh = await subagentBrief('sesi-tanpa-riwayat');
check('briefing subagent tanpa riwayat induk berisi orientasi saja', fresh.includes('Memory tim untuk repo ini') && !fresh.includes('### Judul uji'), fresh.slice(0, 120));

const audit = await (await adminFetch('/api/audit?limit=10')).json();
check('audit mencatat pembuatan pengguna', audit.some((a) => a.action === 'create-user'), audit.map((a) => a.action).join(','));

console.log(failed ? `\n${failed} pemeriksaan GAGAL` : '\nSemua pemeriksaan lulus');
process.exit(failed ? 1 : 0);
