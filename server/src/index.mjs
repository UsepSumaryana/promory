import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';
import { openDb, audit, recordRetrievals } from './db.mjs';
import { authenticate, seedFromEnv } from './auth.mjs';
import { handleAdminApi } from './admin-api.mjs';
import { buildRecall, buildBrief } from './recall.mjs';
import { buildOrientation, buildRelevant, buildSubagentBrief, promptToFtsQuery } from './retrieve.mjs';
import { resolveRepo } from './identity.mjs';
import { mergeTargets, promoteMergedBranch } from './promote.mjs';

/**
 * Entri yang sudah disuntikkan ke tiap sesi, supaya prompt berikutnya tidak
 * mengirim ulang hal yang sama. Disimpan di memori proses, bukan database:
 * isinya tidak berharga setelah sesi berakhir, dan menyimpannya justru
 * menambah data perilaku pengguna yang tidak perlu diarsipkan.
 *
 * Dibatasi supaya server yang hidup berminggu-minggu tidak menumpuk sesi mati.
 *
 * Himpunan `sent` juga menjadi warisan untuk subagent: SubagentStart hook
 * membaca entri yang sudah diterima agent induk dari sini.
 */
const SESSION_CAP = 500;
const sessions = new Map();
function sessionState(key) {
  const st = sessions.get(key) ?? { sent: new Set(), prompts: 0, lastPrompt: null };
  sessions.delete(key);
  sessions.set(key, st); // set ulang = pindah ke akhir, jadi LRU
  while (sessions.size > SESSION_CAP) sessions.delete(sessions.keys().next().value);
  return st;
}

/**
 * Kapan pengingat menyimpan temuan ikut disertakan.
 *
 * Penulisan memory sengaja TIDAK dipaksa lewat hook Stop — keputusan pengguna,
 * supaya sesi tidak pernah terganggu. Konsekuensinya dorongan harus cukup kuat
 * untuk tidak terlewat, tapi tidak boleh muncul di setiap prompt: pengingat yang
 * selalu ada berubah jadi wallpaper yang diabaikan model, sekaligus biaya token
 * yang terbuang di setiap pesan.
 *
 * Jadi muncul setelah sesi cukup dalam untuk punya temuan (prompt ke-3 ke atas),
 * lalu berkala — bukan terus-menerus.
 */
function shouldNudge(prompts) {
  return prompts >= 3 && prompts % 3 === 0;
}

const PORT = Number(process.env.PM_PORT ?? 8787);
const HOST = process.env.PM_HOST ?? '127.0.0.1';
const DB_PATH = process.env.PM_DB ?? './data/memory.db';

const db = openDb(DB_PATH);

// PM_TOKENS hanya menyemai pengguna pertama; setelah tabel users terisi,
// database yang jadi sumber kebenaran dan env var itu diabaikan.
const seed = seedFromEnv(db, process.env.PM_TOKENS);
if (seed.seeded) console.log(`${seed.seeded} pengguna disemai dari PM_TOKENS (yang pertama jadi admin).`);
if (!db.prepare('SELECT COUNT(*) AS n FROM users').get().n)
  console.error('Belum ada pengguna — semua permintaan akan ditolak. Buat admin: node src/admin.mjs add <nama> --admin');

const UI_HTML = readFileSync(fileURLToPath(new URL('./ui.html', import.meta.url)), 'utf8');
const als = new AsyncLocalStorage();
const author = () => als.getStore()?.author ?? 'unknown';
const now = () => new Date().toISOString();
const text = (s) => ({ content: [{ type: 'text', text: s }] });

/**
 * Memory bersama tersimpan permanen dan terbaca seluruh tim, jadi kredensial
 * yang lolos ke sini tidak bisa "dihapus begitu saja" dari ingatan orang.
 * Penjaga ini menolak di titik tulis, bukan membersihkan diam-diam — agent
 * harus tahu tulisannya ditolak supaya bisa menulis ulang tanpa rahasianya.
 */
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*\S{6,}/i,
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/,
  /\b[a-z]+:\/\/[^\s:@/]+:[^\s@/]{4,}@/, // connection string dengan kata sandi inline
];

function assertNoSecret(...parts) {
  const blob = parts.filter(Boolean).join('\n');
  for (const re of SECRET_PATTERNS) {
    if (re.test(blob)) {
      throw new Error(
        'Ditolak: teks mengandung sesuatu yang menyerupai kredensial. ' +
          'Tulis ulang dengan menyebut nama variabel atau lokasinya saja, bukan nilainya.',
      );
    }
  }
}

// Semua tool MCP menerima `root_commit` opsional. Model mengambilnya dari
// pm-context.sh bersama slug; server memakainya untuk menyatukan slug yang
// berbeda ke repo yang sama. Tanpa argumen itu perilakunya seperti sebelumnya.
const rr = (repo, root) => resolveRepo(db, { slug: repo, rootCommit: root }).repo;
const ROOT_ARG = z
  .string()
  .optional()
  .describe('repo_root_commit dari pm-context.sh — identitas repo yang stabil di semua clone. Sertakan bila tersedia.');

function buildServer() {
  const server = new McpServer({ name: 'project-memory', version: '1.0.0' });

  server.registerTool(
    'memory_recall',
    {
      description:
        'Ambil memory untuk sebuah repo dan branch, termasuk memory bersama, memory branch induk yang diwarisi, dan ADR yang berstatus accepted. Panggil ini di awal tugas sebelum mengeksplorasi codebase.',
      inputSchema: z.object({
        repo: z.string().describe('Slug repo, dari pm-context.sh (repo_slug)'),
        branch: z.string().describe('Nama branch yang sedang dikerjakan'),
        inherit_from: z
          .array(z.string())
          .optional()
          .describe('Branch induk dan branch yang di-merge masuk, memory-nya ikut diwarisi'),
        include_adr: z.boolean().optional().describe('Sertakan ADR (default true)'),
        root_commit: ROOT_ARG,
      }),
    },
    async ({ repo, branch, inherit_from = [], include_adr = true, root_commit }) =>
      text(buildRecall(db, { repo: rr(repo, root_commit), branch, inheritFrom: inherit_from, includeAdr: include_adr }).text),
  );

  server.registerTool(
    'memory_write',
    {
      description:
        'Simpan satu temuan. Judul yang sama pada repo+scope+branch yang sama akan MEMPERBARUI entri lama, bukan menambah duplikat. Jangan simpan hal yang gampang di-grep dari kode, dan jangan pernah menyimpan kredensial.',
      inputSchema: z.object({
        repo: z.string(),
        scope: z.enum(['shared', 'branch']).describe("'shared' bila benar di semua branch"),
        branch: z.string().optional().describe("Wajib bila scope='branch'"),
        type: z.enum(['architecture', 'bispro', 'convention', 'gotcha', 'decision', 'env', 'process', 'people', 'reference']),
        title: z.string().describe('Judul ringkas — ini kunci dedup, buat deskriptif dan stabil'),
        body: z.string().describe('Fakta, 1-4 kalimat, sebut path file konkret'),
        why: z.string().optional().describe('Kenapa penting: apa yang jadi lebih cepat atau lebih aman'),
        confidence: z.enum(['confirmed', 'likely']).optional(),
        root_commit: ROOT_ARG,
      }),
    },
    async ({ repo: repoArg, scope, branch, type, title, body, why, confidence = 'confirmed', root_commit }) => {
      const repo = rr(repoArg, root_commit);
      if (scope === 'branch' && !branch) throw new Error("scope='branch' membutuhkan argumen branch.");
      assertNoSecret(title, body, why);
      const b = scope === 'branch' ? branch : null;
      const existing = db
        .prepare("SELECT id FROM entries WHERE repo=? AND scope=? AND IFNULL(branch,'')=IFNULL(?,'') AND title=?")
        .get(repo, scope, b, title);
      if (existing) {
        db.prepare('UPDATE entries SET type=?, body=?, why=?, confidence=?, author=?, updated_at=? WHERE id=?')
          .run(type, body, why ?? null, confidence, author(), now(), existing.id);
        audit(db, author(), 'update-entry', repo, title);
        return text(`Diperbarui entri lama #${existing.id}: "${title}".`);
      }
      const info = db
        .prepare(
          'INSERT INTO entries (repo,scope,branch,type,title,body,why,confidence,author,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(repo, scope, b, type, title, body, why ?? null, confidence, author(), now(), now());
      audit(db, author(), 'create-entry', repo, title);
      return text(`Tersimpan sebagai #${info.lastInsertRowid}: "${title}" (${scope}${b ? `/${b}` : ''}).`);
    },
  );

  server.registerTool(
    'memory_search',
    {
      description:
        'Cari entri memory pada sebuah repo. Diperingkat relevansi (BM25) lewat indeks full-text, bukan pencocokan substring — jadi frasa bebas seperti "koneksi database putus sendiri" bisa dipakai langsung.',
      inputSchema: z.object({ repo: z.string(), query: z.string(), limit: z.number().optional(), root_commit: ROOT_ARG }),
    },
    async ({ repo: repoArg, query, limit = 20, root_commit }) => {
      const repo = rr(repoArg, root_commit);
      const fts = promptToFtsQuery(query, { maxTerms: 16 });
      let rows = [];
      if (fts) {
        try {
          rows = db
            .prepare(
              `SELECT e.id,e.scope,e.branch,e.type,e.title,e.confidence,e.author
                 FROM entries_fts JOIN entries e ON e.id = entries_fts.rowid
                WHERE entries_fts MATCH ? AND e.repo = ?
                ORDER BY bm25(entries_fts) LIMIT ?`,
            )
            .all(fts, repo, limit);
        } catch {
          rows = [];
        }
      }
      // Jatuh ke LIKE kalau seluruh kata query tersaring habis sebagai stopword
      // atau terlalu pendek — mis. pencarian satu kata "CTK" atau "env".
      if (!rows.length) {
        const like = `%${query}%`;
        rows = db
          .prepare(
            `SELECT id,scope,branch,type,title,confidence,author FROM entries
              WHERE repo=? AND (title LIKE ? OR body LIKE ?) ORDER BY updated_at DESC LIMIT ?`,
          )
          .all(repo, like, like, limit);
      }
      if (!rows.length) return text(`Tidak ada entri yang cocok dengan '${query}'.`);
      return text(
        rows
          .map((r) => `#${r.id} [${r.scope}${r.branch ? `/${r.branch}` : ''} | ${r.type} | ${r.confidence} | ${r.author}] ${r.title}`)
          .join('\n'),
      );
    },
  );

  server.registerTool(
    'memory_delete',
    {
      description:
        'Hapus entri yang ternyata salah. Pakai ini alih-alih membiarkan dua fakta bertentangan hidup berdampingan.',
      inputSchema: z.object({ id: z.number(), reason: z.string().describe('Kenapa dihapus — tercatat di audit') }),
    },
    async ({ id, reason }) => {
      const row = db.prepare('SELECT repo,title FROM entries WHERE id=?').get(id);
      if (!row) return text(`Entri #${id} tidak ditemukan.`);
      db.prepare('DELETE FROM entries WHERE id=?').run(id);
      audit(db, author(), 'delete-entry', row.repo, `${row.title} — ${reason}`);
      return text(`Entri #${id} ("${row.title}") dihapus. Alasan tercatat di audit.`);
    },
  );

  server.registerTool(
    'adr_write',
    {
      description:
        'Catat keputusan arsitektur yang mengikat dan belum terdokumentasi di repo. Hanya untuk keputusan yang punya pilihan nyata antar opsi, mengikat pekerjaan berikutnya, dan mahal dibalik. Nomor diberikan otomatis.',
      inputSchema: z.object({
        repo: z.string(),
        title: z.string(),
        context: z.string().describe('Situasi dan tekanan yang memaksa memilih'),
        decision: z.string().describe('Apa yang dipilih, sebut komponen atau path konkret'),
        alternatives: z.string().optional().describe('Opsi yang ditolak dan kenapa'),
        consequences: z.string().optional().describe('Yang jadi lebih mudah, dan yang harus dibayar'),
        status: z.enum(['proposed', 'accepted', 'deprecated']).optional(),
        scope: z.enum(['architecture', 'bispro', 'process', 'tooling']).optional(),
        branch: z.string().optional().describe('Branch asal keputusan'),
        supersedes: z.number().optional().describe('Nomor ADR yang digantikan — ADR lama TIDAK dihapus'),
        root_commit: ROOT_ARG,
      }),
    },
    async ({ repo: repoArg, title, context, decision, alternatives, consequences, status = 'accepted', scope, branch, supersedes, root_commit }) => {
      const repo = rr(repoArg, root_commit);
      assertNoSecret(title, context, decision, alternatives, consequences);
      const max = db.prepare('SELECT MAX(number) AS n FROM adrs WHERE repo=?').get(repo);
      const number = (max?.n ?? 0) + 1;
      const info = db
        .prepare(
          'INSERT INTO adrs (repo,number,title,status,scope,branch,context,decision,alternatives,consequences,supersedes,author,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(repo, number, title, status, scope ?? null, branch ?? null, context, decision, alternatives ?? null, consequences ?? null, supersedes ?? null, author(), now(), now());
      let note = '';
      if (supersedes) {
        const old = db.prepare('SELECT id FROM adrs WHERE repo=? AND number=?').get(repo, supersedes);
        if (old) {
          db.prepare("UPDATE adrs SET status=?, superseded_by=?, updated_at=? WHERE id=?")
            .run(`superseded-by:ADR-${String(number).padStart(4, '0')}`, number, now(), old.id);
          note = ` ADR-${String(supersedes).padStart(4, '0')} ditandai superseded, tidak dihapus.`;
        } else {
          note = ` Peringatan: ADR-${supersedes} tidak ditemukan, relasi supersede tidak dipasang.`;
        }
      }
      audit(db, author(), 'create-adr', repo, `ADR-${number} ${title}`);
      return text(`Tersimpan ADR-${String(number).padStart(4, '0')} (#${info.lastInsertRowid}).${note}`);
    },
  );

  server.registerTool(
    'adr_list',
    {
      description: 'Daftar ADR sebuah repo, opsional disaring berdasarkan status.',
      inputSchema: z.object({ repo: z.string(), status: z.string().optional(), root_commit: ROOT_ARG }),
    },
    async ({ repo: repoArg, status, root_commit }) => {
      const repo = rr(repoArg, root_commit);
      const rows = status
        ? db.prepare('SELECT * FROM adrs WHERE repo=? AND status LIKE ? ORDER BY number').all(repo, `${status}%`)
        : db.prepare('SELECT * FROM adrs WHERE repo=? ORDER BY number').all(repo);
      if (!rows.length) return text('Belum ada ADR untuk repo ini.');
      return text(
        rows
          .map((a) => `ADR-${String(a.number).padStart(4, '0')} [${a.status}] ${a.title} — ${a.decision.slice(0, 120)}`)
          .join('\n'),
      );
    },
  );

  server.registerTool(
    'lineage_put',
    {
      description:
        'Simpan lineage branch hasil pm-context.sh setelah dikoreksi. Menimpa catatan lineage sebelumnya untuk branch itu. Bila contained_by membuktikan branch ini sudah ter-merge ke branch lain, entri scope=branch miliknya otomatis dipromosikan menjadi shared supaya tidak hilang saat branch dihapus; setel promote:false untuk melewatinya.',
      inputSchema: z.object({
        repo: z.string(),
        branch: z.string(),
        parent_branch: z.string().optional(),
        fork_point: z.string().optional(),
        merged_in: z.array(z.string()).optional(),
        contained_by: z.array(z.string()).optional(),
        note: z.string().optional().describe('Alasan koreksi bila tebakan script diubah'),
        promote: z
          .boolean()
          .optional()
          .describe(
            'Default true. Setel false hanya bila entri branch ini memang harus tetap terbatas di branch-nya.',
          ),
        root_commit: ROOT_ARG,
      }),
    },
    async ({ repo: repoArg, branch, parent_branch, fork_point, merged_in, contained_by, note, promote, root_commit }) => {
      const repo = rr(repoArg, root_commit);
      db.prepare(
        `INSERT INTO lineage (repo,branch,parent_branch,fork_point,merged_in,contained_by,note,author,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(repo,branch) DO UPDATE SET
           parent_branch=excluded.parent_branch, fork_point=excluded.fork_point,
           merged_in=excluded.merged_in, contained_by=excluded.contained_by,
           note=excluded.note, author=excluded.author, updated_at=excluded.updated_at`,
      ).run(repo, branch, parent_branch ?? null, fork_point ?? null, (merged_in ?? []).join('; ') || null, (contained_by ?? []).join('; ') || null, note ?? null, author(), now());
      audit(db, author(), 'put-lineage', repo, branch);

      // Entri branch yang pekerjaannya sudah ter-merge dipromosikan di sini,
      // dan bukan di tempat lain, karena inilah satu-satunya titik di mana
      // `contained_by` sampai ke server. Tanpa ini, perhitungan 1,1 detik di
      // pm-context.sh hanya berakhir sebagai teks yang dibaca sekali.
      const lines = [`Lineage '${branch}' tersimpan (induk: ${parent_branch ?? '?'}).`];
      const targets = promote === false ? [] : mergeTargets(branch, contained_by ?? []);
      if (targets.length) {
        const { promoted, conflicts } = promoteMergedBranch(db, { repo, branch, into: targets[0] });
        if (promoted.length) {
          audit(db, author(), 'promote-branch', repo, `${branch} -> shared: ${promoted.join('; ')}`);
          lines.push(
            `Branch ini sudah termuat di ${targets.join(', ')}, jadi ${promoted.length} entri ` +
              `scope=branch dipromosikan menjadi shared supaya tidak hilang saat branch dihapus: ` +
              promoted.map((t) => `"${t}"`).join(', ') + '.',
          );
        }
        if (conflicts.length) {
          // Tabrakan judul TIDAK ditimpa otomatis; lihat promote.mjs. Yang bisa
          // dilakukan di sini hanya memastikan manusia mengetahuinya.
          lines.push(
            `${conflicts.length} entri tidak dipromosikan karena sudah ada entri shared berjudul sama — ` +
              `perlu diselaraskan manual: ` + conflicts.map((t) => `"${t}"`).join(', ') + '.',
          );
        }
      }
      return text(lines.join(' '));
    },
  );

  return server;
}

const handler = createMcpHandler(() => buildServer(), {
  onerror: (err) => console.error('[mcp]', err?.message ?? err),
});
const mcpNode = toNodeHandler(handler);

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, entries: db.prepare('SELECT COUNT(*) AS n FROM entries').get().n }));
    return;
  }

  // Halaman GUI disajikan tanpa autentikasi: isinya hanya kerangka kosong, dan
  // setiap data yang ditampilkannya diambil lewat /api yang menuntut token admin.
  // Menaruh token di URL demi "mengamankan" halaman ini justru akan membocorkannya
  // ke log akses dan riwayat browser.
  if (url.pathname === '/ui' || url.pathname === '/ui/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY' });
    res.end(UI_HTML);
    return;
  }

  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const user = authenticate(db, token);
  if (!user) {
    res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
    res.end(JSON.stringify({ error: 'token tidak dikenal atau sudah dinonaktifkan' }));
    return;
  }

  // Entri paling relevan dengan prompt pengguna, untuk UserPromptSubmit hook.
  //
  // Badan permintaan adalah stdin hook APA ADANYA. Hook cukup meneruskannya
  // tanpa mengurai: mengurai JSON di shell POSIX tanpa jq itu rapuh, sementara
  // di sini sudah ada parser yang benar.
  if (url.pathname === '/relevant' && req.method === 'POST') {
    let payload = {};
    try {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 256 * 1024) break;
        chunks.push(c);
      }
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('');
      return;
    }

    const repo = resolveRepo(db, {
      slug: url.searchParams.get('repo'),
      rootCommit: url.searchParams.get('root'),
    }).repo;
    const branch = url.searchParams.get('branch');
    const sessionKey = `${user.id}:${payload.session_id ?? 'tanpa-sesi'}`;
    if (!repo || !branch || !payload.prompt) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('');
      return;
    }

    const inheritFrom = (url.searchParams.get('inherit') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const budget = Math.max(500, Math.min(12000, Number(url.searchParams.get('budget')) || 3000));

    const st = sessionState(sessionKey);
    // Pengingat dihitung per PROMPT, bukan per permintaan. prompt-memory.sh
    // mengirim satu permintaan untuk setiap repo yang aktif, sampai tiga, dan
    // versi yang menaikkan hitungan di setiap permintaan membuat pengingat
    // muncul di dua dari tiga prompt pada dua repo aktif, dan di SETIAP prompt
    // pada tiga repo — persis wallpaper yang ingin dihindari shouldNudge().
    //
    // prompt_id (Claude Code >= 2.1.196) sama untuk semua permintaan dari satu
    // prompt. Klien lama tidak mengirimnya, jadi teks prompt jadi gantinya —
    // di-hash supaya prompt panjang tidak menginap di memori proses. Dua prompt
    // identik berturut-turut lalu terhitung satu, harga yang wajar.
    const promptKey = payload.prompt_id ?? createHash('sha1').update(String(payload.prompt)).digest('hex');
    const firstOfPrompt = promptKey !== st.lastPrompt;
    if (firstOfPrompt) {
      st.prompts += 1;
      st.lastPrompt = promptKey;
    }

    // Rute ini dipanggil pada SETIAP prompt setiap anggota tim, dan hook-nya
    // gagal tanpa suara. Jadi bug apa pun di dalam retrieval tidak boleh
    // menjatuhkan proses: sekali crash, seluruh tim kehilangan memory sampai
    // ada yang menyadarinya. Pernah terjadi — satu variabel yang belum
    // dideklarasikan membunuh server pada panggilan pertama.
    let ids = [];
    let body = '';
    try {
      const r = buildRelevant(db, {
        repo,
        branch,
        inheritFrom,
        prompt: payload.prompt,
        exclude: st.sent,
        budget,
        // Hanya permintaan pertama dari sebuah prompt yang boleh membawanya,
        // supaya pengingat tidak tercetak sekali per repo.
        nudge: firstOfPrompt && shouldNudge(st.prompts),
      });
      ids = r.ids;
      body = r.text;
    } catch (err) {
      console.error('[relevant]', err?.stack ?? err);
    }
    for (const id of ids) st.sent.add(id);
    // Dicatat di sini, bukan di dalam buildRelevant: yang layak dihitung sebagai
    // "dipakai" adalah entri yang benar-benar dikirim ke hook, bukan yang lolos
    // pemeringkatan lalu terpotong anggaran.
    recordRetrievals(db, ids);

    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-pm-count': String(ids.length) });
    res.end(body);
    return;
  }

  // Dipanggil SessionStart hook setelah compaction atau /clear. Entri yang sudah
  // disuntikkan ikut terringkas dan praktis hilang dari konteks, tapi masih
  // tercatat "sudah dikirim" di sini — tanpa reset, tidak satu pun dikirim
  // ulang selama sisa sesi. Hanya `sent` yang dikosongkan; hitungan prompt
  // untuk pengingat tetap berjalan, karena sesinya sendiri tidak berakhir.
  if (url.pathname === '/session/reset' && req.method === 'POST') {
    sessions.get(`${user.id}:${url.searchParams.get('session') || 'tanpa-sesi'}`)?.sent.clear();
    res.writeHead(204);
    res.end();
    return;
  }

  // Briefing teks polos untuk SessionStart hook. Terbuka untuk semua token yang
  // sah (bukan hanya admin) karena inilah jalur recall utama tiap anggota:
  // hook memanggilnya sendiri dan mencetak hasilnya, tanpa perlu model memanggil
  // Agent tool — yang di sebagian harness memang dilarang tanpa permintaan user.
  if (url.pathname === '/brief' && req.method === 'GET') {
    const repo = resolveRepo(db, {
      slug: url.searchParams.get('repo'),
      rootCommit: url.searchParams.get('root'),
    }).repo;
    const branch = url.searchParams.get('branch');
    if (!repo || !branch) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('parameter repo dan branch wajib');
      return;
    }
    const inheritFrom = (url.searchParams.get('inherit') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // mode=full hanya untuk diagnosa manual; hook selalu memakai indeks padat,
    // karena stdout hook yang besar dipotong harness dan isinya hilang separuh.
    const budget = Math.max(1000, Math.min(20000, Number(url.searchParams.get('budget')) || 6000));
    const mode = url.searchParams.get('mode') ?? 'orientation';
    // orientation (default): peta ringkas, ukurannya tetap kecil berapa pun isi
    //   memory — dipakai SessionStart, karena relevansi belum bisa dihitung.
    // subagent: orientasi + entri yang sudah diterima agent induk di sesi
    //   `session` — dipakai SubagentStart hook.
    // budget: briefing lengkap dipotong anggaran, cocok untuk memory kecil.
    // full: tanpa batas, hanya untuk diagnosa manual.
    //
    // Dibungkus try seperti /relevant: SubagentStart berjalan untuk setiap
    // subagent setiap anggota tim, dan bug di sini tidak boleh menjatuhkan
    // proses — handler ini async, jadi galat yang lolos menjadi unhandled
    // rejection yang mematikan server.
    let result = { empty: true, text: '' };
    try {
      result =
        mode === 'full'
          ? buildRecall(db, { repo, branch, inheritFrom })
          : mode === 'budget'
            ? buildBrief(db, { repo, branch, inheritFrom, budget })
            : mode === 'subagent'
              ? buildSubagentBrief(db, {
                  repo,
                  branch,
                  inheritFrom,
                  budget,
                  sentIds: sessions.get(`${user.id}:${url.searchParams.get('session') || 'tanpa-sesi'}`)?.sent ?? [],
                })
              : buildOrientation(db, { repo, branch, inheritFrom });
    } catch (err) {
      console.error('[brief]', err?.stack ?? err);
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-pm-empty': String(result.empty) });
    res.end(result.text);
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    if (user.role !== 'admin') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'butuh peran admin' }));
      return;
    }
    try {
      await handleAdminApi(db, req, res, user, url);
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Nama penulis dibawa lewat AsyncLocalStorage agar setiap tool handler bisa
  // mencatat author tanpa harus meneruskannya sebagai argumen tool — argumen
  // tool diisi model, dan identitas tidak boleh berasal dari sana.
  als.run({ author: user.name }, () => mcpNode(req, res));
});

httpServer.listen(PORT, HOST, () => {
  const users = db.prepare("SELECT COUNT(*) AS n FROM users WHERE disabled_at IS NULL").get().n;
  console.log(`project-memory mendengarkan di http://${HOST}:${PORT}  db=${DB_PATH}  pengguna aktif=${users}`);
  console.log(`GUI admin: http://${HOST}:${PORT}/ui`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    httpServer.close();
    handler.close().finally(() => {
      db.close();
      process.exit(0);
    });
  });
}
