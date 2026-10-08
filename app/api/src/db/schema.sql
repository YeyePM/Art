-- 美术史复盘网站 · 数据库表结构
-- 依据：specs/02-数据模型.md
-- 约定：日期存 TEXT 'YYYY-MM-DD'；时间戳存 TEXT 'YYYY-MM-DD HH:MM:SS'（本地时区 Asia/Shanghai）

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------- 题目与标签 ----------

-- 1. 题目库
CREATE TABLE IF NOT EXISTS questions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT    NOT NULL CHECK (type IN ('objective','term','image','essay')),
  stem          TEXT    NOT NULL,
  options       TEXT,                       -- JSON 数组；term / essay 为 NULL
  answer        TEXT    NOT NULL,
  explanation   TEXT    NOT NULL,
  difficulty    TEXT    NOT NULL DEFAULT '进阶' CHECK (difficulty IN ('基础','进阶','挑战')),
  fingerprint   TEXT    NOT NULL UNIQUE,    -- 内容指纹（题干 + 核心标签 哈希），去重用
  source        TEXT    NOT NULL DEFAULT 'ai' CHECK (source IN ('ai','manual')),
  image_path    TEXT,                       -- 图像辨识题的作品图（本地文件名，走 /api/images/）
  artwork_id    INTEGER,                    -- 关联 artworks.id（图像辨识题）
  is_flagged    INTEGER NOT NULL DEFAULT 0, -- 被标记问题的题不再出现在每日题中
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 2. 标签
CREATE TABLE IF NOT EXISTS tags (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL UNIQUE,
  category  TEXT NOT NULL CHECK (category IN ('中外','时期','流派','作者','作品','技法'))
);

-- 3. 题目 ↔ 标签
CREATE TABLE IF NOT EXISTS question_tags (
  question_id INTEGER NOT NULL REFERENCES questions(id),
  tag_id      INTEGER NOT NULL REFERENCES tags(id),
  PRIMARY KEY (question_id, tag_id)
);

-- ---------- 作答与复习 ----------

-- 4. 作答记录
CREATE TABLE IF NOT EXISTS answers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id    INTEGER NOT NULL REFERENCES questions(id),
  session_date   TEXT    NOT NULL,          -- 归属哪一天的额度
  user_answer    TEXT,
  is_correct     INTEGER NOT NULL,          -- 最终判定：客观题直接比、主观题 AI 判，用户可覆盖
  is_self_graded INTEGER NOT NULL DEFAULT 0,-- 最终判定由用户给 = 1（改判 AI，或 AI 没判上时用户自己定）
  ai_correct     INTEGER,                   -- 主观题 AI 的原始判定（用户改判后仍保留）；非 AI 判为 NULL
  ai_comment     TEXT,                      -- 主观题 AI 的点评
  ai_errors      TEXT,                      -- JSON 数组：AI 抓出的事实性硬错误
  duration_ms    INTEGER,
  answered_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 5. 复习队列（一题一条）
CREATE TABLE IF NOT EXISTS review_queue (
  question_id     INTEGER PRIMARY KEY REFERENCES questions(id),
  first_wrong_on  TEXT    NOT NULL,
  next_review_on  TEXT    NOT NULL,         -- 下次出现日
  interval_days   INTEGER NOT NULL DEFAULT 1 CHECK (interval_days IN (1,3,7,15)),
  correct_streak  INTEGER NOT NULL DEFAULT 0,
  status          TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','done')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ---------- 每日与打卡 ----------

-- 6. 每日任务
CREATE TABLE IF NOT EXISTS daily_sessions (
  date         TEXT    PRIMARY KEY,         -- 'YYYY-MM-DD'
  question_ids TEXT    NOT NULL,            -- JSON 数组，当日固定 10 题
  done_count   INTEGER NOT NULL DEFAULT 0,
  total        INTEGER NOT NULL DEFAULT 10,
  checked_in   INTEGER NOT NULL DEFAULT 0,
  hook         TEXT,                        -- 当天通知用的一句引子
  created_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 12. 打卡
CREATE TABLE IF NOT EXISTS checkins (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  date           TEXT    NOT NULL UNIQUE,
  completed_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  question_count INTEGER NOT NULL DEFAULT 10
);

-- ---------- 每周一批 ----------

-- 7. 画作
CREATE TABLE IF NOT EXISTS artworks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT,
  artist         TEXT,
  period         TEXT,                      -- 年代（博物馆元数据 objectDate）
  school         TEXT,
  local_path     TEXT,                      -- 本地缓存文件名，走 /api/images/
  source_library TEXT,                      -- met / chicago / taipei
  external_id    TEXT,                      -- 来源库的 object id
  created_at     TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 8. 画库（你写的一句话）
CREATE TABLE IF NOT EXISTS artwork_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  artwork_id INTEGER NOT NULL REFERENCES artworks(id),
  note_date  TEXT    NOT NULL,
  content    TEXT,
  is_empty   INTEGER NOT NULL DEFAULT 0,    -- 未写标记
  created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 9. 书籍摘录
CREATE TABLE IF NOT EXISTS excerpts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  book_title    TEXT NOT NULL,
  chapter       TEXT,
  source_text   TEXT NOT NULL,
  contact_line  TEXT,                       -- 配的一句白话触点
  is_favorite   INTEGER NOT NULL DEFAULT 0,
  batch_id      INTEGER,                    -- 归属周批次
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 10. 开放问题
CREATE TABLE IF NOT EXISTS open_questions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  stem               TEXT NOT NULL,
  reference_thoughts TEXT,
  user_answer        TEXT,
  batch_id           INTEGER,
  answered_at        TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 11. 周批次
CREATE TABLE IF NOT EXISTS weekly_batches (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  starts_on        TEXT NOT NULL,           -- 滚动 7 天，不是自然周
  ends_on          TEXT NOT NULL,
  artwork_id       INTEGER REFERENCES artworks(id),
  excerpt_id       INTEGER REFERENCES excerpts(id),
  open_question_id INTEGER REFERENCES open_questions(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ---------- 兜底与推送 ----------

-- 13. 标记问题
CREATE TABLE IF NOT EXISTS flagged_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL CHECK (target_type IN ('question','artwork','excerpt','open_question','fragment')),
  target_id   INTEGER NOT NULL,
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 14. 推送记录（防重复发 + 排查"今天怎么没弹"）
CREATE TABLE IF NOT EXISTS push_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  date      TEXT    NOT NULL UNIQUE,
  sent_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  body      TEXT    NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 1
);

-- ---------- v0.2 · 碎片池（M0 就建好，避免以后改结构） ----------

-- 15. 碎片池
CREATE TABLE IF NOT EXISTS fragments (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  kind                 TEXT NOT NULL CHECK (kind IN ('artwork','text')),
  image_path           TEXT,                -- 本地文件名，走 /api/images/
  user_note            TEXT,
  ai_summary           TEXT,
  ai_tags              TEXT,                -- JSON 数组
  ocr_text             TEXT,
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  used_in_batch_id     INTEGER,
  used_in_question_id  INTEGER,
  created_at           TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ---------- 索引 ----------

CREATE INDEX IF NOT EXISTS idx_questions_type        ON questions(type);
CREATE INDEX IF NOT EXISTS idx_questions_flagged     ON questions(is_flagged);
CREATE INDEX IF NOT EXISTS idx_question_tags_tag     ON question_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_answers_question      ON answers(question_id);
CREATE INDEX IF NOT EXISTS idx_answers_date          ON answers(session_date);
CREATE INDEX IF NOT EXISTS idx_review_due            ON review_queue(status, next_review_on);
CREATE INDEX IF NOT EXISTS idx_artwork_notes_art     ON artwork_notes(artwork_id);
CREATE INDEX IF NOT EXISTS idx_excerpts_batch        ON excerpts(batch_id);
CREATE INDEX IF NOT EXISTS idx_open_questions_batch  ON open_questions(batch_id);
CREATE INDEX IF NOT EXISTS idx_flagged_target        ON flagged_items(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_fragments_status      ON fragments(status);