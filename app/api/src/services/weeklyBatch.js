// 每周一批的规则层（一个批次 = 1 张画 + 1 段摘录 + 1 个开放问题）
// 依据：docs/03-MVP-Spec.md「每周一批」验收、docs/03 决策记录（滚动 7 天，非自然周）、
//       specs/01-接口契约.md 第一节第 5~7 条
//
// 三条边界：
//   ① 周期是**滚动 7 天**（上次起算日 + 7 天），不是自然周——周一重置会造出隐性 deadline；
//   ② 未满 7 天 → 返回当前批次，**内容不变**，也不调 AI；
//   ③ 新批次没生成出来（AI / 图源挂了）→ 退回当前批次，不让页面空掉。
import { getLatestBatch, getBatchById, insertBatch } from '../db/weeklyBatches.js';
import { insertExcerpt, getExcerptById, getRecentBookTitles, setExcerptBatch } from '../db/excerpts.js';
import { insertOpenQuestion, getOpenQuestionById, saveOpenAnswer, setOpenQuestionBatch } from '../db/openQuestions.js';
import { insertArtworkNote, getLatestNoteForArtwork } from '../db/artworkNotes.js';
import { ensureArtwork, getArtworkById, getUsedExternalIds } from '../db/artworks.js';
import { generateWeeklyContent } from '../ai/generateWeekly.js';
import { fetchArtworksForToday } from '../images/artworkSource.js';
import { cacheArtworkAndLink } from './artworkCache.js';
import { todayInShanghai } from './questionPicker.js';

const BATCH_DAYS = 7;

/** 该不该开新批次：没有批次，或距上次起算日已满 7 天 */
export function needsNewBatch(today, startsOn) {
  if (!startsOn) return true;
  return addDays(startsOn, BATCH_DAYS) <= String(today);
}

/**
 * `GET /api/weekly` 的数据。
 * @param {{date?:string, generation?:object}} params
 *   generation：测试注入 `{artwork, excerpt, openQuestion}`——给了就不调 AI、不取博物馆
 * @returns {Promise<object|null>}
 */
export async function getWeeklyView({ date, generation } = {}) {
  const day = date ?? todayInShanghai();
  const latest = getLatestBatch();

  if (latest && !needsNewBatch(day, latest.startsOn)) return buildView(latest);

  const created = await createWeeklyBatch({ date: day, generation });
  return buildView(created ?? latest);
}

/**
 * 生成并落库一个新批次。三件内容各自入库拿到 id，再建批次串起来。
 * @returns {Promise<object|null>} 新批次；什么都没生成出来返回 null
 */
export async function createWeeklyBatch({ date, generation } = {}) {
  const day = date ?? todayInShanghai();

  // ① 摘录 + 开放问题：真调用时把"最近用过的书名"喂回去，让它轮换取材
  const content = generation ?? (await generateWeeklyContent({ usedBooks: getRecentBookTitles(5) }));
  const excerpt = content?.excerpt ?? null;
  const openQuestion = content?.openQuestion ?? null;
  if (!excerpt && !openQuestion) return null;

  // ② 一张画：按已有批次数的奇偶轮换取中国 / 外国
  const artworkMeta = generation?.artwork ?? (await pickBatchArtwork());

  // ③ 落库
  const artworkId = artworkMeta ? await saveArtwork(artworkMeta) : null;
  const excerptId = excerpt ? insertExcerpt(excerpt) : null;
  const openQuestionId = openQuestion ? insertOpenQuestion(openQuestion) : null;

  const batch = insertBatch({
    startsOn: day,
    endsOn: addDays(day, BATCH_DAYS - 1),
    artworkId,
    excerptId,
    openQuestionId
  });

  // 摘录 / 开放问题的 batch_id 建批次时还不知道，回头补上
  if (excerptId) setExcerptBatch(excerptId, batch.id);
  if (openQuestionId) setOpenQuestionBatch(openQuestionId, batch.id);

  return batch;
}

/** POST /api/artworks/note —— 记下看画时写的一句；空内容也记，标成"未写" */
export function saveArtworkNote({ artworkId, content } = {}) {
  const id = Number(artworkId);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('artwork_id 必须是正整数');
  if (!getArtworkById(id)) throw badRequest('这件画不存在');

  const text = String(content ?? '').trim();
  insertArtworkNote({
    artworkId: id,
    noteDate: todayInShanghai(),
    content: text || null,
    isEmpty: !text
  });

  return { ok: true };
}

/** POST /api/open-questions/answer —— 写开放问题的回答；可留空（留空不算答过） */
export function saveOpenQuestionAnswer({ openQuestionId, content } = {}) {
  const id = Number(openQuestionId);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('open_question_id 必须是正整数');
  if (!getOpenQuestionById(id)) throw badRequest('这个开放问题不存在');

  saveOpenAnswer({ id, content });
  return { ok: true };
}

/** 把批次拼成接口返回的形状（画 / 摘录 / 开放问题各自的字段见 specs/01 一之四） */
function buildView(batch) {
  if (!batch) return null;

  const artwork = batch.artworkId ? getArtworkById(batch.artworkId) : null;
  const note = artwork ? getLatestNoteForArtwork(artwork.id) : null;
  const excerpt = batch.excerptId ? getExcerptById(batch.excerptId) : null;
  const openQuestion = batch.openQuestionId ? getOpenQuestionById(batch.openQuestionId) : null;

  return {
    batch_id: batch.id,
    starts_on: batch.startsOn,
    ends_on: batch.endsOn,
    artwork: artwork
      ? {
          id: artwork.id,
          title: artwork.title,
          artist: artwork.artist,
          period: artwork.period,
          school: artwork.school,
          image_url: artwork.local_path ? `/api/images/${artwork.local_path}` : null,
          note: note ? { content: note.content, is_empty: note.isEmpty } : null
        }
      : null,
    excerpt: excerpt
      ? {
          id: excerpt.id,
          book_title: excerpt.bookTitle,
          chapter: excerpt.chapter,
          source_text: excerpt.sourceText,
          contact_line: excerpt.contactLine
        }
      : null,
    open_question: openQuestion
      ? {
          id: openQuestion.id,
          stem: openQuestion.stem,
          reference_thoughts: openQuestion.referenceThoughts,
          user_answer: openQuestion.userAnswer
        }
      : null
  };
}

/** 入库一件画并把图缓存到本机；返回 artworks.id */
async function saveArtwork(meta) {
  const id = ensureArtwork({
    title: meta.title ?? null,
    artist: meta.artist ?? null,
    period: meta.period ?? null,
    school: meta.school ?? null,
    source_library: meta.sourceLibrary ?? null,
    external_id: meta.externalId ?? null
  });

  // 图下载失败返回 null，画照留、界面显示无图——不阻塞这一周的内容
  await cacheArtworkAndLink(id, meta);
  return id;
}

/** 按已用批次的奇偶轮换中外，尽量让画不一边倒 */
async function pickBatchArtwork() {
  const side = (getLatestBatch()?.id ?? 0) % 2 === 0 ? 'foreign' : 'cn';
  const list = await fetchArtworksForToday({ count: 1, usedExternalIds: getUsedExternalIds(), side });
  return list[0] ?? null;
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/** 按 YYYY-MM-DD 加减天数（走 UTC，避免本地时区把日子算歪，同 reviewQueue / todaySession） */
function addDays(day, delta) {
  const [year, month, date] = String(day).split('-').map(Number);
  const moment = new Date(Date.UTC(year, month - 1, date));
  moment.setUTCDate(moment.getUTCDate() + delta);
  return moment.toISOString().slice(0, 10);
}