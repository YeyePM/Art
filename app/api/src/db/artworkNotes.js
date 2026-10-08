// 画库的读写 SQL（看画时随手写的一句话）
// 依据：specs/02-数据模型.md；"未写可跳过，但标记为未写"（docs/03 MVP 验收）
import { getDb } from './index.js';

/** 每写一次插一条（保留历史），空内容记为空写 */
export function insertArtworkNote({ artworkId, noteDate, content = null, isEmpty = false } = {}) {
  const info = getDb()
    .prepare(`
      INSERT INTO artwork_notes (artwork_id, note_date, content, is_empty)
      VALUES (?, ?, ?, ?)
    `)
    .run(Number(artworkId), noteDate, content ?? null, isEmpty ? 1 : 0);

  return Number(info.lastInsertRowid);
}

/** 某件画最新写的那一句；没写过返回 null */
export function getLatestNoteForArtwork(artworkId) {
  const row = getDb()
    .prepare('SELECT * FROM artwork_notes WHERE artwork_id = ? ORDER BY id DESC LIMIT 1')
    .get(Number(artworkId));
  if (!row) return null;
  return {
    id: row.id,
    artworkId: row.artwork_id,
    noteDate: row.note_date,
    content: row.content,
    isEmpty: row.is_empty === 1
  };
}