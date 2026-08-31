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

console.log(failed ? `\n${failed} pemeriksaan GAGAL` : '\nSemua pemeriksaan lulus');
process.exit(failed ? 1 : 0);
