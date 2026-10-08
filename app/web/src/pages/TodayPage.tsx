import { useCallback, useEffect, useState } from 'react';
import { submitAnswer } from '../api/answers';
import { loadToday } from '../api/today';
import { QUESTION_TYPE_LABEL, type AnswerResult, type Question, type TodayResponse } from '../api/types';

type AnswerState = {
  userAnswer: string;
  result: AnswerResult | null;
  /** 这次判定是用户改判来的 */
  selfGraded: boolean;
  submitting: boolean;
  error: string | null;
};

const BLANK: AnswerState = {
  userAnswer: '',
  result: null,
  selfGraded: false,
  submitting: false,
  error: null
};

/** 把 "A 吴道子" 拆成字母 + 内容 */
function splitOption(option: string): { letter: string; text: string } {
  const matched = /^\s*([A-Da-d])\s*[.、,，:：)）]?\s*(.*)$/.exec(option);
  if (!matched) return { letter: '', text: option };
  return { letter: matched[1].toUpperCase(), text: matched[2] };
}

/** 客观 / 图像辨识题的参考答案是一个选项字母；名词解释 / 论述返回的是原文，这里取不到 */
function correctLetterOf(question: Question, result: AnswerResult | null): string | null {
  if (!question.options || !result) return null;
  const raw = String(result.reference_answer ?? '').trim();
  return /^[A-Da-d]$/.test(raw) ? raw.toUpperCase() : null;
}

function Feedback({
  question,
  result,
  selfGraded,
  onSubmit
}: {
  question: Question;
  result: AnswerResult;
  selfGraded: boolean;
  onSubmit: (selfGrade?: boolean) => void;
}) {
  const isChoice = !!question.options;
  const verdict = result.correct === null ? 'unknown' : result.correct ? 'ok' : 'bad';
  const correctLetter = correctLetterOf(question, result);

  // 客观题把字母还原成整条选项文字，看着更省事
  let reference = result.reference_answer ?? '';
  if (isChoice && correctLetter) {
    const hit = question.options!.find((option) => splitOption(option).letter === correctLetter);
    if (hit) reference = hit;
  }

  return (
    <div className={`fb fb-${verdict}`}>
      <div className="fb-hd">
        {verdict === 'ok' && '✓ 答对了'}
        {verdict === 'bad' && '✕ 答错了'}
        {verdict === 'unknown' && 'AI 没判上，你来定'}
        {selfGraded && <span className="tag">已改判</span>}
      </div>

      <dl className="fb-dl">
        <dt>{isChoice ? '正确答案' : '参考答案'}</dt>
        <dd>{reference || '—'}</dd>

        {result.explanation && (
          <>
            <dt>解析</dt>
            <dd>{result.explanation}</dd>
          </>
        )}

        {result.ai_comment && (
          <>
            <dt>AI 点评</dt>
            <dd>{result.ai_comment}</dd>
          </>
        )}

        {result.ai_errors.length > 0 && (
          <>
            <dt>事实性硬错误</dt>
            <dd>
              <ul className="fb-errs">
                {result.ai_errors.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </dd>
          </>
        )}

        <dt>下次复习</dt>
        <dd>{result.next_review_at ?? '不在复习队列'}</dd>
      </dl>

      {/* AI 调不通：让用户自己定，会记进复习队列 */}
      {verdict === 'unknown' && (
        <div className="fb-act">
          <span className="hint">自己定一下：</span>
          <button className="btn-ghost" onClick={() => onSubmit(true)}>
            我答对了
          </button>
          <button className="btn-ghost" onClick={() => onSubmit(false)}>
            我答错了
          </button>
        </div>
      )}

      {/* 主观题不认可 AI 判定：再提交一次带 self_grade 即改判 */}
      {verdict !== 'unknown' && !isChoice && (
        <div className="fb-act">
          <span className="hint">不认可这个判定？</span>
          <button className="btn-ghost" onClick={() => onSubmit(!result.correct)}>
            {result.correct ? '其实我答错了' : '我其实答对了'}
          </button>
          <span className="hint">改判只覆盖判定，不重调 AI</span>
        </div>
      )}
    </div>
  );
}

function QuestionCard({
  question,
  index,
  state,
  onAnswer,
  onSubmit
}: {
  question: Question;
  index: number;
  state: AnswerState;
  onAnswer: (value: string) => void;
  onSubmit: (selfGrade?: boolean) => void;
}) {
  const result = state.result;
  const locked = !!result;
  const subjective = question.type === 'term' || question.type === 'essay';
  const withFigure = question.type === 'image' && !!question.image_url;
  const correctLetter = correctLetterOf(question, result);
  const canSubmit = state.userAnswer.trim().length > 0 && !state.submitting && !locked;

  return (
    <article className="q">
      <div className="q-hd">
        <span className="q-idx">第 {String(index + 1).padStart(2, '0')} 题</span>
        <span className="chip">{QUESTION_TYPE_LABEL[question.type]}</span>
      </div>

      <div className={withFigure ? 'q-body' : 'q-body plain'}>
        {withFigure && (
          <figure className="q-fig">
            <img src={question.image_url!} alt="作品图" />
          </figure>
        )}

        <div className="q-main">
          <p className="q-stem">{question.stem}</p>

          {question.options ? (
            <div className="opts">
              {question.options.map((option) => {
                const { letter, text } = splitOption(option);
                const picked = state.userAnswer === letter;
                const classes = ['opt'];
                if (picked && !locked) classes.push('on');
                if (locked && correctLetter === letter) classes.push('right');
                if (locked && picked && correctLetter !== letter) classes.push('wrong');
                return (
                  <button
                    type="button"
                    key={option}
                    className={classes.join(' ')}
                    disabled={locked}
                    onClick={() => onAnswer(letter)}
                  >
                    <span className="k">{letter}</span>
                    <span>{text}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="sheet">
              <textarea
                value={state.userAnswer}
                disabled={locked}
                onChange={(event) => onAnswer(event.target.value)}
                placeholder={question.type === 'essay' ? '写下你的论述…' : '写下你的解释…'}
              />
            </div>
          )}

          {!locked && (
            <div className="row-end">
              <button className="btn" disabled={!canSubmit} onClick={() => onSubmit()}>
                {state.submitting ? '判分中…' : '提交'}
              </button>
              <span className="hint">
                {state.submitting
                  ? subjective
                    ? 'AI 正在判分，约十几秒，别关页面'
                    : '判定中…'
                  : subjective
                    ? '提交后才给参考答案与 AI 点评'
                    : '选一个再提交'}
              </span>
            </div>
          )}

          {state.error && <p className="fb-err">{state.error}</p>}

          {result && (
            <Feedback
              question={question}
              result={result}
              selfGraded={state.selfGraded}
              onSubmit={onSubmit}
            />
          )}
        </div>
      </div>
    </article>
  );
}

/** 今日页 —— M2：答题交互与反馈，题目与判分都走真实接口 */
export default function TodayPage() {
  const [data, setData] = useState<TodayResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<number, AnswerState>>({});

  const load = useCallback(() => {
    setLoadError(null);
    setData(null);
    loadToday()
      .then(setData)
      .catch((e: Error) => setLoadError(e.message));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const patch = useCallback((id: number, next: Partial<AnswerState>) => {
    setAnswers((prev) => ({ ...prev, [id]: { ...BLANK, ...prev[id], ...next } }));
  }, []);

  const handleSubmit = useCallback(
    async (question: Question, selfGrade?: boolean) => {
      const userAnswer = answers[question.id]?.userAnswer ?? '';
      if (!userAnswer.trim()) return;

      patch(question.id, { submitting: true, error: null });
      try {
        const result = await submitAnswer({
          question_id: question.id,
          user_answer: userAnswer,
          ...(selfGrade == null ? {} : { self_grade: selfGrade })
        });
        patch(question.id, { result, submitting: false, selfGraded: selfGrade != null });
      } catch (e) {
        patch(question.id, { submitting: false, error: (e as Error).message });
      }
    },
    [answers, patch]
  );

  if (loadError) {
    return (
      <main className="page">
        <h1>今日页</h1>
        <div className="card">
          <div style={{ marginBottom: 12 }}>{loadError}</div>
          <button className="btn" onClick={load}>
            重试
          </button>
        </div>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="page">
        <p className="muted">正在准备今天的题…</p>
        <p className="sub">第一次打开要凑齐 10 题，可能要几十秒，别关页面。</p>
      </main>
    );
  }

  const { questions, progress, notice } = data;
  const answeredHere = questions.filter((question) => answers[question.id]?.result).length;
  const done = Math.min(progress.total, progress.done + answeredHere);

  return (
    <main className="page">
      {/* ① 统计条 —— M4 接 GET /api/stats */}
      <div className="stats">
        <span>
          连续 <b>—</b>天
        </span>
        <span>
          最长 <b>—</b>天
        </span>
        <span>
          累计 <b>—</b>天
        </span>
        <span>
          正确率 <b>—</b>
        </span>
      </div>

      {/* ② 今日题目 */}
      <section className="block">
        <div className="block-hd">
          <h2>今日 {questions.length} 题</h2>
          <span className="meta">
            进度{' '}
            <b>
              {done}/{progress.total}
            </b>
          </span>
        </div>

        {notice && <div className="notice">{notice.message}</div>}

        {questions.map((question, index) => (
          <QuestionCard
            key={question.id}
            question={question}
            index={index}
            state={answers[question.id] ?? BLANK}
            onAnswer={(value) => patch(question.id, { userAnswer: value })}
            onSubmit={(selfGrade) => handleSubmit(question, selfGrade)}
          />
        ))}
      </section>

      {/* ③ 本周一批 —— M5 再做 */}
      <section className="block">
        <div className="block-hd">
          <h2>本周一批</h2>
          <span className="meta">本周不看也不会催你</span>
        </div>
        <div className="placeholder">
          M5 再做：每日一画（看图 + 写一句）、书籍摘录、一个开放问题。
        </div>
      </section>

      <p className="foot">M2 · 题目与判分走真实接口（GET /api/today + POST /api/answers）。</p>
    </main>
  );
}