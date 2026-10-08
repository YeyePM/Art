import { Link } from 'react-router-dom';

/** 主界面 —— M7 / T8 才做（三个概览卡横排 + 鼠标左右移动驱动平移） */
export default function HomePage() {
  return (
    <main className="page">
      <h1>主界面</h1>
      <p className="sub">M0 · 占位。M7 / T8 再做：三个概览卡横排、每张右侧配一张名画。</p>

      <div className="card">
        <p style={{ margin: 0 }} className="muted">
          先走这两个入口：
        </p>
        <p style={{ margin: '14px 0 0', display: 'flex', gap: 18 }}>
          <Link to="/today">今日页 →</Link>
          <Link to="/stats">学习进度页 →</Link>
        </p>
      </div>
    </main>
  );
}