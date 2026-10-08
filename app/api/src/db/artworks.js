// 画作的读写 SQL（图像辨识题的来源作品）
// T3 用到它：图像辨识题的作者 / 年代来自博物馆，落一份 artworks 记录并把题目挂上去；
// 图片本身的下载与本地缓存是 M5（images/ 层）的事，那时回填 local_path。
import { getDb } from './index.js';

/** 已有的就复用，没有才插一条。返回 artworks.id */
export function ensureArtwork({
  title = null,
  artist = null,
  period = null,
  school = null,
  source_library = null,
  external_id = null,
  local_path = null
} = {}) {
  const db = getDb();

  const existing = external_id
    ? db
        .prepare('SELECT id FROM artworks WHERE source_library IS ? AND external_id = ?')
        .get(source_library, String(external_id))
    : db.prepare('SELECT id FROM artworks WHERE title IS ? AND artist IS ?').get(title, artist);
  if (existing) return existing.id;

  const info = db
    .prepare(`
      INSERT INTO artworks (title, artist, period, school, local_path, source_library, external_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(title, artist, period, school, local_path, source_library, external_id != null ? String(external_id) : null);

  return Number(info.lastInsertRowid);
}

export function getArtworkById(id) {
  return getDb().prepare('SELECT * FROM artworks WHERE id = ?').get(id) ?? null;
}

export function countArtworks() {
  return getDb().prepare('SELECT count(*) AS c FROM artworks').get().c;
}

/** 回填本地缓存文件名（M5：图片下载到 data/images/ 后写这里） */
export function setArtworkLocalPath(id, localPath) {
  getDb().prepare('UPDATE artworks SET local_path = ? WHERE id = ?').run(localPath, Number(id));
}

/** 全部画作 id：回填脚本要把每件画的图都补下来 */
export function listArtworkIds() {
  return getDb().prepare('SELECT id FROM artworks ORDER BY id').all().map((row) => row.id);
}

/**
 * 已经用过的外部作品 id。
 * 出题取画时拿它排除，免得同一幅画反复出现在图像辨识题里。
 */
export function getUsedExternalIds() {
  return getDb()
    .prepare('SELECT external_id FROM artworks WHERE external_id IS NOT NULL')
    .all()
    .map((row) => String(row.external_id));
}