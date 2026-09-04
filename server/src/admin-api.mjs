import { audit } from './db.mjs';
import { createUser, rotateToken } from './auth.mjs';

/**
 * REST kecil untuk GUI. Sengaja terpisah dari MCP: MCP adalah antarmuka untuk
 * agent, dan memaksakan browser bicara JSON-RPC lewat handshake sesi hanya
 * menambah bagian yang bisa rusak tanpa menambah kemampuan apa pun.
 *
 * Semua rute di sini menuntut role admin — pengecekan ada di index.mjs sebelum
 * fungsi ini dipanggil.
 */
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 512 * 1024) throw new Error('Body terlalu besar');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function handleAdminApi(db, req, res, user, url) {
  const p = url.pathname;
  const q = url.searchParams;
  const m = req.method;

  if (p === '/api/me' && m === 'GET') return json(res, 200, user);

  if (p === '/api/repos' && m === 'GET') {
    return json(
      res,
      200,
      db
        .prepare(
          `SELECT repo,
                  COUNT(*) AS entries,
                  SUM(CASE WHEN scope='shared' THEN 1 ELSE 0 END) AS shared,
                  MAX(updated_at) AS updated_at
             FROM entries GROUP BY repo ORDER BY repo`,
        )
        .all(),
    );
  }

  if (p === '/api/entries' && m === 'GET') {
    const repo = q.get('repo');
    if (!repo) return json(res, 400, { error: 'parameter repo wajib' });
    const search = q.get('q');
    const rows = search
      ? db
          .prepare(
            'SELECT * FROM entries WHERE repo=? AND (title LIKE ? OR body LIKE ? OR IFNULL(why,\'\') LIKE ?) ORDER BY scope, branch, title',
          )
          .all(repo, `%${search}%`, `%${search}%`, `%${search}%`)
      : db.prepare('SELECT * FROM entries WHERE repo=? ORDER BY scope, branch, title').all(repo);
    return json(res, 200, rows);
  }

  const entryMatch = p.match(/^\/api\/entries\/(\d+)$/);
  if (entryMatch) {
    const id = Number(entryMatch[1]);
    const row = db.prepare('SELECT * FROM entries WHERE id=?').get(id);
    if (!row) return json(res, 404, { error: 'entri tidak ada' });

    if (m === 'PATCH') {
      const b = await readJson(req);
      const next = {
        title: b.title ?? row.title,
        body: b.body ?? row.body,
        why: b.why ?? row.why,
        type: b.type ?? row.type,
        confidence: b.confidence ?? row.confidence,
        // pinned = entri yang selalu ikut di briefing awal sesi. Pada memory
        // berskala ribuan entri, briefing hanya memuat peta + yang di-pin, jadi
        // inilah satu-satunya cara menjamin sebuah fakta tidak terlewat.
        pinned: b.pinned === undefined ? row.pinned : b.pinned ? 1 : 0,
      };
      try {
        db.prepare('UPDATE entries SET title=?, body=?, why=?, type=?, confidence=?, pinned=?, updated_at=? WHERE id=?')
          .run(next.title, next.body, next.why, next.type, next.confidence, next.pinned, new Date().toISOString(), id);
      } catch (err) {
        // Judul unik per repo+scope+branch; bentrok berarti sudah ada entri lain
        // dengan judul itu, dan menggabungkannya adalah keputusan manusia.
        return json(res, 409, { error: `Judul bentrok dengan entri lain: ${err.message}` });
      }
      // Suntingan manusia dicatat atas nama penyuntingnya, bukan penulis asli,
      // supaya kolom author tetap berarti "siapa yang bertanggung jawab terakhir".
      db.prepare('UPDATE entries SET author=? WHERE id=?').run(`${user.name} (kurasi)`, id);
      audit(db, user.name, 'edit-entry', row.repo, `#${id} ${next.title}`);
      return json(res, 200, db.prepare('SELECT * FROM entries WHERE id=?').get(id));
    }

    if (m === 'DELETE') {
      const reason = q.get('reason') ?? '(tanpa alasan)';
      db.prepare('DELETE FROM entries WHERE id=?').run(id);
      audit(db, user.name, 'delete-entry', row.repo, `#${id} ${row.title} — ${reason}`);
      return json(res, 200, { ok: true });
    }
  }

  if (p === '/api/adrs' && m === 'GET') {
    const repo = q.get('repo');
    if (!repo) return json(res, 400, { error: 'parameter repo wajib' });
    return json(res, 200, db.prepare('SELECT * FROM adrs WHERE repo=? ORDER BY number').all(repo));
  }

  const adrMatch = p.match(/^\/api\/adrs\/(\d+)$/);
  if (adrMatch && m === 'PATCH') {
    const id = Number(adrMatch[1]);
    const row = db.prepare('SELECT * FROM adrs WHERE id=?').get(id);
    if (!row) return json(res, 404, { error: 'ADR tidak ada' });
    const b = await readJson(req);
    db.prepare(
      'UPDATE adrs SET title=?, status=?, context=?, decision=?, alternatives=?, consequences=?, updated_at=? WHERE id=?',
    ).run(
      b.title ?? row.title,
      b.status ?? row.status,
      b.context ?? row.context,
      b.decision ?? row.decision,
      b.alternatives ?? row.alternatives,
      b.consequences ?? row.consequences,
      new Date().toISOString(),
      id,
    );
    audit(db, user.name, 'edit-adr', row.repo, `ADR-${row.number}`);
    return json(res, 200, db.prepare('SELECT * FROM adrs WHERE id=?').get(id));
  }

  if (p === '/api/lineage' && m === 'GET') {
    const repo = q.get('repo');
    return json(res, 200, db.prepare('SELECT * FROM lineage WHERE repo=? ORDER BY branch').all(repo));
  }

  // Ringkasan pemakaian: entri mana yang benar-benar sampai ke konteks orang.
  //
  // Satu query untuk semuanya, dengan LEFT JOIN — entri yang belum pernah
  // tertarik TIDAK punya baris di retrieval_stats, dan justru entri itulah yang
  // paling ingin dilihat. INNER JOIN akan menyembunyikannya, yang berarti panel
  // ini kehilangan separuh gunanya.
  if (p === '/api/usage' && m === 'GET') {
    const repo = q.get('repo');
    if (!repo) return json(res, 400, { error: 'parameter repo wajib' });
    const rows = db
      .prepare(
        `SELECT e.id, e.title, e.type, e.scope, e.branch, e.pinned, e.updated_at,
                IFNULL(s.hits, 0) AS hits, s.last_at
           FROM entries e
           LEFT JOIN retrieval_stats s ON s.entry_id = e.id
          WHERE e.repo = ?
          ORDER BY hits DESC, e.updated_at DESC`,
      )
      .all(repo);
    const never = rows.filter((r) => r.hits === 0).length;
    return json(res, 200, {
      total: rows.length,
      never,
      used: rows.length - never,
      hits: rows.reduce((a, r) => a + r.hits, 0),
      rows,
    });
  }

  if (p === '/api/audit' && m === 'GET') {
    return json(
      res,
      200,
      db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(Number(q.get('limit') ?? 100)),
    );
  }

  if (p === '/api/users' && m === 'GET') {
    return json(
      res,
      200,
      db.prepare('SELECT id,name,role,created_at,disabled_at,last_seen_at FROM users ORDER BY id').all(),
    );
  }

  if (p === '/api/users' && m === 'POST') {
    const b = await readJson(req);
    if (!b.name?.trim()) return json(res, 400, { error: 'nama wajib' });
    const role = b.role === 'admin' ? 'admin' : 'member';
    try {
      const token = createUser(db, b.name.trim(), role, user.name);
      // Token dikembalikan sekali ini saja — server hanya menyimpan hash-nya.
      return json(res, 201, { token, name: b.name.trim(), role });
    } catch (err) {
      return json(res, 409, { error: `Gagal membuat pengguna: ${err.message}` });
    }
  }

  const userMatch = p.match(/^\/api\/users\/(\d+)(\/rotate)?$/);
  if (userMatch) {
    const id = Number(userMatch[1]);
    const target = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!target) return json(res, 404, { error: 'pengguna tidak ada' });

    if (userMatch[2] === '/rotate' && m === 'POST') {
      return json(res, 200, { token: rotateToken(db, id, user.name), name: target.name });
    }

    if (m === 'PATCH') {
      const b = await readJson(req);
      // Menonaktifkan atau menurunkan admin terakhir akan mengunci semua orang
      // keluar dari GUI; pemulihannya hanya lewat shell VPS. Tolak di sini.
      const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled_at IS NULL").get().n;
      const losingLastAdmin =
        target.role === 'admin' && !target.disabled_at && admins <= 1 && (b.disabled === true || b.role === 'member');
      if (losingLastAdmin)
        return json(res, 409, {
          error: 'Ini admin aktif terakhir. Buat admin lain dulu, atau pakai CLI di VPS.',
        });

      if (b.role) db.prepare('UPDATE users SET role=? WHERE id=?').run(b.role === 'admin' ? 'admin' : 'member', id);
      if (b.disabled !== undefined)
        db.prepare('UPDATE users SET disabled_at=? WHERE id=?').run(b.disabled ? new Date().toISOString() : null, id);
      audit(db, user.name, 'edit-user', null, `${target.name}: ${JSON.stringify(b)}`);
      return json(res, 200, db.prepare('SELECT id,name,role,disabled_at FROM users WHERE id=?').get(id));
    }
  }

  return json(res, 404, { error: 'rute tidak dikenal' });
}
