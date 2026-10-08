/** 学习进度页 —— M7 / T9 才做（连续 / 最长 / 总天数 / 正确率 + 打卡日历，只读） */
export default function StatsPage() {
  return (
    <main className="page">
      <h1>学习进度页</h1>
      <p className="sub">M0 · 占位。M7 / T9 再做：只读统计 + 打卡日历；不做趋势图、不做"薄弱点"。</p>

      <div className="card muted">数据来自 GET /api/stats。</div>
    </main>
  );
}