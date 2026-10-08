// 当日会话的组装（唯一写规则的地方）
// 依据：specs/04-核心规则.md 第一节「组装顺序」、specs/01-接口契约.md 第一节第 2 条
//
// 顺序：① 昨日未完成题 → ② 今天到期的复习题 → ③ 不够的用 AI 补足
// 两条边界：**配额永不膨胀**（凑够 10 就停，不是再发 10 道）；当天题一旦写入就固定。
import { config } from '../config.js';
import { getSession, getSessionQuestionIds, saveSession } from '../db/dailySessions.js';
import { getDueReviewIds, getActiveReviewIds } from '../db/reviewQueue.js';
import { getAnsweredIdsOn, filterUnanswered } from '../db/answers.js';
import { getForDisplay } from '../db/questions.js';
import { getUsedExternalIds } from '../db/artworks.js';
import { pickDailyQuestions, todayInShanghai } from './questionPicker.js';
import { generateAndStoreDailyQuestions } from './dailyGeneration.js';
import { describeAiFailure } from './aiFailure.js';
import { fetchArtworksForToday, artworkDemandForToday } from '../images/artworkSource.js';

/**
 * 凑齐并写下当天的题单。**幂等**：同一天第二次调用直接读库，不再调 AI、不再花钱。
 *
 * @param {{date?:string, artworks?:Array<object>}} params
 *   artworks：测试用，显式指定作品元数据；不传则走 images/ 层取博物馆数据
 * @returns {Promise<{date, questionIds, hook, checkedIn, generated, reused, shortfall}>}
 */
export async function buildTodaySession({ date, artworks } = {}) {
  const day = date ?? todayInShanghai();

  // 当天已经写过：原样返回，这是"同一天不二次调 AI"的落地方式
  const existing = getSession(day);
  if (existing) {
    return {
      date: day,
      questionIds: existing.questionIds,
      hook: existing.hook,
      checkedIn: existing.checkedIn,
      generated: false,
      reused: true,
      shortfall: Math.max(0, config.dailyQuestionCount - existing.questionIds.length),
      generationError: null
    };
  }

  // ① 昨日未完成的题：顺序保留，排最前。由这一层显式算，组题层故意不扫 daily_sessions
  const yesterday = previousDay(day);
  const carryOverIds = filterUnanswered(getSessionQuestionIds(yesterday), yesterday);

  // ② 今天到期的复习题（含过期没做的）
  const dueReviewIds = getDueReviewIds(day);

  // ③ 先按规则组一次；缺题才调 AI，补完再组一次
  let plan = pickDailyQuestions({ carryOverIds, dueReviewIds, date: day });
  let generated = false;
  let shortfall = 0;
  let hook = null;
  let generationError = null;

  if (plan.needMore > 0) {
    try {
      const result = await generateAndStoreDailyQuestions({
        date: day,
        needMore: plan.needMore,
        needMoreByType: plan.needMoreByType,
        artworks: await resolveArtworks(plan.needMoreByType.image, artworks)
      });
      generated = result.inserted > 0;
      shortfall = result.shortfall;
      hook = result.hook;
    } catch (err) {
      // M6 兜底：AI 挂了不该白屏或 500。先把手头能给的题（昨日未完成 + 到期复习 + 题库现成）
      // 给出去，并带上一句人话提示；**不写会话**，这样"重开这一页"能真的再试一次。
      generationError = describeAiFailure(err);
      shortfall = plan.needMore;
    }

    plan = pickDailyQuestions({ carryOverIds, dueReviewIds, date: day });
  }

  // AI 失败：本次不落库（否则这天就固定了、永远补不上），直接把现有题返回 + 提示
  if (generationError) {
    return {
      date: day,
      questionIds: plan.questionIds,
      hook: null,
      checkedIn: false,
      generated: false,
      reused: false,
      shortfall,
      generationError
    };
  }

  // 当天题单就此固定。AI 没补齐也照写：宁可有几天题少一点，也不反复花钱重试
  const saved = saveSession({
    date: day,
    questionIds: plan.questionIds,
    total: plan.questionIds.length,
    hook
  });

  return {
    date: day,
    questionIds: saved.questionIds,
    hook: saved.hook,
    checkedIn: saved.checkedIn,
    generated,
    reused: false,
    shortfall,
    generationError: null
  };
}

/**
 * 组装 `GET /api/today` 的完整返回。
 * 注意 questions 走的是 db 的 getForDisplay，**天然不含 answer / explanation**；
 * 这里是唯一的出口，别在这条路上加答案字段。
 */
export async function getTodayView({ date, artworks } = {}) {
  const day = date ?? todayInShanghai();
  const session = await buildTodaySession({ date: day, artworks });

  const reviewIds = new Set(getActiveReviewIds());
  const questions = getForDisplay(session.questionIds).map((question) => ({
    id: question.id,
    type: question.type,
    stem: question.stem,
    options: question.options,
    difficulty: question.difficulty,
    image_url: question.imagePath ? `/api/images/${question.imagePath}` : null,
    is_review: reviewIds.has(question.id),
    tags: question.tags
  }));

  const answered = new Set(getAnsweredIdsOn(day));
  const done = session.questionIds.filter((id) => answered.has(id)).length;

  return {
    date: day,
    questions,
    progress: { done, total: session.questionIds.length },
    checked_in: session.checkedIn,
    // M6 兜底：AI 没帮上忙时给一句人话（正常时为 null，字段始终在，前端可直接判空）
    notice: session.generationError ?? null
  };
}

/** 图像辨识题要几件作品：显式传了就照用（测试），不传就走 images/ 层取博物馆元数据 */
async function resolveArtworks(imageNeeded, artworks) {
  if (Array.isArray(artworks)) return artworks;

  const count = artworkDemandForToday(imageNeeded);
  if (count <= 0) return [];
  return fetchArtworksForToday({ count, usedExternalIds: getUsedExternalIds() });
}

/** 前一天（按 YYYY-MM-DD 算，避免本地时区把日子算歪） */
function previousDay(day) {
  const [year, month, date] = String(day).split('-').map(Number);
  const moment = new Date(Date.UTC(year, month - 1, date));
  moment.setUTCDate(moment.getUTCDate() - 1);
  return moment.toISOString().slice(0, 10);
}