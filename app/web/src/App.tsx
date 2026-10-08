import { Navigate, Route, Routes } from 'react-router-dom';
import HomePage from './pages/HomePage';
import TodayPage from './pages/TodayPage';
import StatsPage from './pages/StatsPage';

/**
 * 三个路由（层级只有两层：主界面 ⇄ 二级页）：
 *   /        主界面（M7 / T8）
 *   /today   今日页（M1 起逐步做）
 *   /stats   学习进度页（M7 / T9）
 * 二级页都从主界面进、都能回主界面；推送通知打开的是 /today。
 */
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/today" element={<TodayPage />} />
      <Route path="/stats" element={<StatsPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}