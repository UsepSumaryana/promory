/**
 * Umur entri, dan penandaan entri yang cukup tua untuk pantas dicurigai.
 *
 * Kolom `updated_at` sudah ada sejak awal, tapi tidak pernah sampai ke model:
 * blok yang disuntikkan hanya memuat tipe, confidence, dan branch. Padahal teks
 * suntikannya sendiri menyuruh model "pakai ini alih-alih mengeksplorasi
 * codebase dari nol". Akibatnya entri arsitektur berumur setengah tahun — yang
 * mungkin sudah tidak akurat — diperlakukan setara dengan yang ditulis kemarin,
 * dan tidak ada apa pun dalam konteks yang memberi alasan untuk memeriksanya.
 *
 * Umur adalah sinyal termurah yang tersedia: nol biaya query, beberapa byte per
 * entri, dan cukup untuk mengubah "percaya" menjadi "percaya tapi verifikasi"
 * pada entri yang memang sudah lama.
 */

// Ambang "pantas dicurigai". 120 hari dipilih bukan karena fakta jadi salah
// pada hari ke-120, tapi karena itu kira-kira satu kuartal — rentang di mana
// refactor, perpindahan modul, dan pergantian konvensi biasanya sudah terjadi
// setidaknya sekali. Bisa disetel lewat PM_STALE_DAYS.
const STALE_DAYS = (() => {
  const raw = Number(process.env.PM_STALE_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120;
})();

export function ageDays(iso, now = Date.now()) {
  const t = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(t)) return null;
  return Math.floor((now - t) / 86400000);
}

/**
 * Label umur yang pendek dan enak dibaca. Sengaja kasar: presisi hari untuk
 * entri berumur setahun tidak menambah apa pun selain byte.
 */
export function ageLabel(iso, now = Date.now()) {
  const d = ageDays(iso, now);
  if (d === null) return null;
  if (d <= 0) return 'hari ini';
  if (d === 1) return 'kemarin';
  if (d < 30) return `${d} hari lalu`;
  if (d < 365) {
    const m = Math.round(d / 30);
    return `${m} bulan lalu`;
  }
  const y = Math.floor(d / 365);
  return y === 1 ? 'lebih dari setahun lalu' : `${y} tahun lalu`;
}

export function isStale(iso, now = Date.now()) {
  const d = ageDays(iso, now);
  return d !== null && d >= STALE_DAYS;
}

/**
 * Penanda yang ikut ke dalam header blok entri, misalnya
 * `_architecture, diperbarui 5 bulan lalu, PERIKSA ULANG_`.
 *
 * Peringatannya hanya muncul pada entri yang benar-benar tua. Peringatan yang
 * menempel di semua entri akan diabaikan model — sama seperti pengingat yang
 * muncul di setiap prompt berubah jadi wallpaper.
 */
export function ageFlags(iso, now = Date.now()) {
  const label = ageLabel(iso, now);
  if (!label) return [];
  return isStale(iso, now)
    ? [`diperbarui ${label}`, 'PERIKSA ULANG sebelum dipakai']
    : [`diperbarui ${label}`];
}

export { STALE_DAYS };
