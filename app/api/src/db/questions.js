// 题目的读写 SQL（SQL 只写在 db/）
import crypto from 'node:crypto';
import { getDb } from './index.js';
import { ensureTagId, setQuestionTags } from './tags.js';

/**
 * 内容指纹：题干 + 核心标签 的组合哈希，用于去重。
 * 归一化后再算，避免空格 / 全半角差异造成"假不重复"。
 */
export function makeFingerprint(stem, tags = []) {
  const norm = (text) => String(text ?? '').replace(/\s+/g, '').trim();
  const payload = `${norm(stem)}::${[...tags].map(norm).sort().join(',')}`;
  return crypto.createHash('sha1').update(payload).digest('hex');
}

/**
 * 批量写入题目（含标签关联）。指纹重复的题会被跳过，不报错。
 * @param {Array<object>} items
 * @returns {{inserted: number[], skipped: number}}
 */
export function insertQuestions(items) {
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO questions (type, stem, options, answer, explanation, difficulty, fingerprint, source, image_path, artwork_id)
    VALUES (@type, @stem, @options, @answer, @explanation, @difficulty, @fingerprint, @source, @image_path, @artwork_id)
  `);

  const run = db.transaction((rows) => {
    const inserted = [];
    let skipped = 0;
    for (const item of rows) {
      const tags = item.tags ?? [];
      const fingerprint = item.fingerprint ?? makeFingerprint(item.stem, tags);
      try {
        const info = insert.run({
          type: item.type,
          stem: item.stem,
          options: item.options ? JSON.stringify(item.options) : null,
          answer: item.answer,
          explanation: item.explanation ?? '',
          difficulty: item.difficulty ?? '进阶',
          fingerprint,
          source: item.source ?? 'ai',
          image_path: item.image_path ?? null,
          artwork_id: item.artwork_id ?? null
        });
        setQuestionTags(info.lastInsertRowid, tags);
        inserted.push(Number(info.lastInsertRowid));
      } catch (err) {
        if (String(err?.code).startsWith('SQLITE_CONSTRAINT')) {
          skipped += 1;
          continue;
        }
        throw err;
      }
    }
    return { inserted, skipped };
  });

  return run(items);
}

/**
 * 取候选新题：未被标记问题、没被排除、且还没作答过。
 * 出题时要靠它填满当日配额。
 * @param {{excludeIds?: number[]}} options
 */
export function getCandidates({ excludeIds = [] } = {}) {
  const db = getDb();
  const ids = excludeIds.map(Number).filter(Number.isInteger);
  const placeholders = ids.map(() => '?').join(',');

  const sql = `
    SELECT q.id, q.type, q.stem, q.difficulty, q.created_at,
           (SELECT group_concat(t.name, '||')
              FROM question_tags qt JOIN tags t ON t.id = qt.tag_id
             WHERE qt.question_id = q.id) AS tag_names
      FROM questions q
     WHERE q.is_flagged = 0
       AND q.id NOT IN (SELECT question_id FROM answers)
       ${ids.length ? `AND q.id NOT IN (${placeholders})` : ''}
     ORDER BY q.id
  `;

  return db.prepare(sql).all(...ids).map((row) => ({
    id: row.id,
    type: row.type,
    stem: row.stem,
    difficulty: row.difficulty,
    createdAt: row.created_at,
    tags: row.tag_names ? row.tag_names.split('||') : []
  }));
}

/** 按 id 取题（保留调用方给的顺序） */
export function getByIds(ids = []) {
  const db = getDb();
  const list = ids.map(Number);
  if (list.length === 0) return [];
  const placeholders = list.map(() => '?').join(',');
  const rows = db
    .prepare(`
      SELECT q.id, q.type, q.stem, q.difficulty,
             (SELECT group_concat(t.name, '||')
                FROM question_tags qt JOIN tags t ON t.id = qt.tag_id
               WHERE qt.question_id = q.id) AS tag_names
        FROM questions q
       WHERE q.id IN (${placeholders})
    `)
    .all(...list);

  const byId = new Map(
    rows.map((row) => [
      row.id,
      { id: row.id, type: row.type, stem: row.stem, difficulty: row.difficulty, tags: row.tag_names ? row.tag_names.split('||') : [] }
    ])
  );
  return list.map((id) => byId.get(id)).filter(Boolean);
}

/** 题库现有题数 */
export function countQuestions() {
  return getDb().prepare('SELECT count(*) AS c FROM questions').get().c;
}

/**
 * 标记 / 取消标记一道题（M6）。
 * 出题池的过滤靠 questions.is_flagged（getCandidates 里 `q.is_flagged = 0`），
 * 标记流水记在 flagged_items（见 db/flaggedItems.js），两边各存一份。
 */
export function setQuestionFlagged(id, flagged = true) {
  return getDb()
    .prepare('UPDATE questions SET is_flagged = @f WHERE id = @id')
    .run({ id: Number(id), f: flagged ? 1 : 0 }).changes;
}

/**
 * 从一组 id 里滤掉被标记的题（保留原顺序）。
 * 用来挡住"昨日未完成 / 到期复习"里那道已被标记的题——它不该再出现在每日题中。
 */
export function getUnflaggedIds(ids = []) {
  const list = ids.map(Number).filter(Number.isInteger);
  if (list.length === 0) return [];
  const placeholders = list.map(() => '?').join(',');
  const rows = getDb()
    .prepare(`SELECT id FROM questions WHERE id IN (${placeholders}) AND is_flagged = 0`)
    .all(...list);
  const ok = new Set(rows.map((row) => row.id));
  return list.filter((id) => ok.has(id));
}

/**
 * 回填图像辨识题的作品图（M5）：一件画下载好之后，
 * 把挂在这件画上的图像辨识题的 image_path 一起写上。
 * 一条 SQL 覆盖该画的全部题，幂等（值相同就不重复写）。
 */
export function setImagePathForArtwork(artworkId, imagePath) {
  return getDb()
    .prepare(`
      UPDATE questions
         SET image_path = @path
       WHERE artwork_id = @artwork_id
         AND type = 'image'
         AND (image_path IS NULL OR image_path <> @path)
    `)
    .run({ artwork_id: Number(artworkId), path: imagePath }).changes;
}

/** 还没拿到本地图片的图像辨识题数（自测 / 排查用） */
export function countImageQuestionsMissingPath() {
  return getDb()
    .prepare("SELECT count(*) AS c FROM questions WHERE type = 'image' AND artwork_id IS NOT NULL AND image_path IS NULL")
    .get().c;
}

/**
 * 取当日展示用的题（保留传入顺序）。
 * **只选安全字段：绝不带 answer / explanation**——接口契约 specs/01 第三节，
 * /api/today 不返回答案与解析，答案只在 POST /api/answers 的响应里给。
 */
export function getForDisplay(ids = []) {
  const list = ids.map(Number).filter(Number.isInteger);
  if (list.length === 0) return [];

  const placeholders = list.map(() => '?').join(',');
  const rows = getDb()
    .prepare(`
      SELECT q.id, q.type, q.stem, q.options, q.difficulty, q.image_path, q.artwork_id,
             (SELECT group_concat(t.name, '||')
                FROM question_tags qt JOIN tags t ON t.id = qt.tag_id
               WHERE qt.question_id = q.id) AS tag_names
        FROM questions q
       WHERE q.id IN (${placeholders})
    `)
    .all(...list);

  const byId = new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        type: row.type,
        stem: row.stem,
        options: parseOptions(row.options),
        difficulty: row.difficulty,
        imagePath: row.image_path ?? null,
        artworkId: row.artwork_id ?? null,
        tags: row.tag_names ? row.tag_names.split('||') : []
      }
    ])
  );

  return list.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * 判分用：按 id 取题，**带 answer 与 explanation**。
 * 只给 `POST /api/answers` 用——/api/today 走 getForDisplay，两条路不许混。
 */
export function getWithAnswer(id) {
  const row = getDb()
    .prepare('SELECT id, type, stem, options, answer, explanation, difficulty FROM questions WHERE id = ?')
    .get(Number(id));

  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    stem: row.stem,
    options: parseOptions(row.options),
    answer: row.answer,
    explanation: row.explanation,
    difficulty: row.difficulty
  };
}

/** 选项是 JSON 字符串存的，坏了就当没有选项，别让一条脏数据把整个接口带崩 */
function parseOptions(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}