// M8 配套：把后端写进 Windows「启动」文件夹，实现开机自启（幂等）。
//   node app/api/scripts/install-autostart.js         安装 / 覆盖
//   node app/api/scripts/install-autostart.js remove  移除
//
// 做法：在「启动」文件夹里建一个快捷方式，指向本机的 node.exe + 后端入口，
// 工作目录设为项目根（后端靠进程自身位置找 .env 与 data/，两处都稳）。
// 这样开机登录后后端自动在后台常驻，推送定时器随之启动（不是托盘图标，是后台进程）。
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT_DIR } from '../src/config.js';

const LINK_NAME = 'ArtReview-backend.lnk';
const ENTRY = path.join('app', 'api', 'src', 'index.js');

function runPowerShell(script) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8' }
  );
  return {
    ok: result.status === 0,
    out: (result.stdout ?? '').trim(),
    err: (result.stderr ?? '').trim() || (result.error ? String(result.error.message) : '')
  };
}

/** 立刻在后台起一份后端（隐藏窗口、独立于本脚本，脚本退出后它继续跑） */
function startBackendNow() {
  const child = spawn(process.execPath, [path.join(ROOT_DIR, ENTRY)], {
    cwd: ROOT_DIR,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
}

const remove = process.argv.includes('remove');
const startupDir = path.join(
  process.env.APPDATA ?? '',
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  'Startup'
);
const linkPath = path.join(startupDir, LINK_NAME);

if (remove) {
  const { ok, out, err } = runPowerShell(
    `$ErrorActionPreference='Stop';` +
      `if (Test-Path -LiteralPath '${linkPath}') { Remove-Item -LiteralPath '${linkPath}' -Force; 'REMOVED' } else { 'NOT_FOUND' }`
  );
  console.log('');
  console.log(ok ? `开机自启已移除（${out || 'NOT_FOUND'}）` : `移除失败：${err}`);
  console.log('');
  process.exitCode = ok ? 0 : 1;
} else {
  const script =
    `$ErrorActionPreference='Stop';` +
    `$startup=[Environment]::GetFolderPath('Startup');` +
    `$ws=New-Object -ComObject WScript.Shell;` +
    `$lnk=$ws.CreateShortcut((Join-Path $startup '${LINK_NAME}'));` +
    `$lnk.TargetPath='${process.execPath}';` +
    `$lnk.Arguments='${ENTRY}';` +
    `$lnk.WorkingDirectory='${ROOT_DIR}';` +
    `$lnk.WindowStyle=7;` +
    `$lnk.Description='Art History Review backend (daily push)';` +
    `$lnk.Save();` +
    `Write-Output ('OK ' + $lnk.FullName)`;

  const { ok, out, err } = runPowerShell(script);

  console.log('');
  if (!ok) {
    console.log('安装开机自启失败：');
    console.log(`  ${err}`);
    console.log('可以手动做：Win+R 输入 shell:startup，把后端的启动方式拖进去。');
    console.log('');
    process.exitCode = 1;
  } else {
    console.log('开机自启已装好（下次开机自动在后台跑，不用再手动启动）。');
    console.log(`  快捷方式：${out.replace(/^OK\s*/, '') || linkPath}`);
    console.log(`  启动命令：${process.execPath} ${ENTRY}`);

    if (process.argv.includes('--no-start')) {
      console.log('');
      console.log('（按参数要求，这次没有立刻启动后端。）');
    } else {
      startBackendNow();
      console.log('');
      console.log('已顺手在后台启动一份后端（隐藏窗口，关掉本窗口也不会停）。');
      console.log('先去 http://localhost:5178/api/health 看看是不是 {"ok":true}。');
      console.log('（若打不开，通常是 5178 端口已被别的后端占着，说明它本来就在跑。）');
    }

    console.log('');
    console.log('想取消开机自启：跑 install-autostart.js remove。');
    console.log('');
  }
}