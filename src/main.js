'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileP = promisify(execFile);

// sips 로 JPEG 변환이 필요한 확장자 (Chromium 이 직접 디코드하지 못함)
const CONVERT_EXT = new Set(['.heic', '.heif', '.hif', '.tif', '.tiff']);
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'heic', 'heif', 'hif', 'tif', 'tiff', 'gif', 'webp', 'bmp', 'avif'];

let win = null;
let rendererReady = false;
let textFieldFocused = false;
let interceptCount = 0;

// 메인 프로세스에서 가로채 렌더러로 보내는 단축키 (물리 키 코드)
const SHORTCUT_CODES = new Set([
  'KeyW', 'KeyR', 'KeyE', 'KeyS', 'KeyB', 'KeyC', 'KeyF', 'KeyD', 'KeyH',
  'BracketLeft', 'BracketRight', 'Backslash', 'Space', 'Slash', 'Escape',
]);
const pendingOpen = [];

const selftestArg = process.argv.find((a) => a.startsWith('--selftest='));
const selftestDir = selftestArg ? selftestArg.slice('--selftest='.length) : null;

// ---------- 파일 읽기 (HEIC/TIFF 는 sips 로 JPEG 변환) ----------
async function readImageFile(filePath, forceConvert) {
  const ext = path.extname(filePath).toLowerCase();
  let readPath = filePath;
  let converted = false;
  if (forceConvert || CONVERT_EXT.has(ext)) {
    const tmp = path.join(os.tmpdir(), `liquify-${process.pid}-${Date.now()}.jpg`);
    await execFileP('/usr/bin/sips', [
      '-s', 'format', 'jpeg',
      '-s', 'formatOptions', '100',
      filePath, '--out', tmp,
    ]);
    readPath = tmp;
    converted = true;
  }
  const data = await fs.readFile(readPath);
  if (converted) fs.unlink(readPath).catch(() => {});
  return { name: path.basename(filePath), path: filePath, data, converted };
}

function sendMenu(action) {
  if (win && !win.isDestroyed()) win.webContents.send('menu', action);
}

function flushPendingOpen() {
  if (!rendererReady || !win) return;
  while (pendingOpen.length) {
    win.webContents.send('open-file', pendingOpen.shift());
  }
}

function queueOpen(p) {
  if (!p) return;
  pendingOpen.push(p);
  flushPendingOpen();
}

// 커맨드라인 인자로 넘어온 이미지 경로 (개발 모드: electron . foo.jpg)
function argvImagePaths(argv) {
  return argv.slice(1).filter((a) => {
    if (a.startsWith('-')) return false;
    const ext = path.extname(a).slice(1).toLowerCase();
    return IMAGE_EXTS.includes(ext);
  }).map((a) => path.resolve(a));
}

// ---------- 메뉴 ----------
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: 'Liquify 정보' },
        { type: 'separator' },
        { role: 'hide', label: 'Liquify 가리기' },
        { role: 'hideOthers', label: '다른 앱 가리기' },
        { role: 'unhide', label: '모두 보기' },
        { type: 'separator' },
        { role: 'quit', label: 'Liquify 종료' },
      ],
    }] : []),
    {
      label: '파일',
      submenu: [
        { label: '열기…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('open') },
        { label: '저장…', accelerator: 'CmdOrCtrl+S', click: () => sendMenu('save') },
        { type: 'separator' },
        isMac ? { role: 'close', label: '창 닫기' } : { role: 'quit', label: '종료' },
      ],
    },
    {
      label: '편집',
      submenu: [
        { label: '실행 취소', accelerator: 'CmdOrCtrl+Z', click: () => sendMenu('undo') },
        { label: '다시 실행', accelerator: 'Shift+CmdOrCtrl+Z', click: () => sendMenu('redo') },
        { type: 'separator' },
        { label: '모두 복원', click: () => sendMenu('restore') },
        { label: '마스크 모두 해제', click: () => sendMenu('thaw-all') },
      ],
    },
    {
      label: '보기',
      submenu: [
        { label: '확대', accelerator: 'CmdOrCtrl+=', click: () => sendMenu('zoom-in') },
        { label: '축소', accelerator: 'CmdOrCtrl+-', click: () => sendMenu('zoom-out') },
        { label: '화면에 맞춤', accelerator: 'CmdOrCtrl+0', click: () => sendMenu('zoom-fit') },
        { label: '실제 크기(100%)', accelerator: 'CmdOrCtrl+1', click: () => sendMenu('zoom-100') },
        { type: 'separator' },
        { label: '마스크 표시', type: 'checkbox', checked: true, click: (item) => sendMenu(item.checked ? 'mask-show' : 'mask-hide') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '전체 화면' },
        { role: 'toggleDevTools', label: '개발자 도구' },
      ],
    },
    {
      label: '윈도우',
      role: 'windowMenu',
      submenu: [
        { role: 'minimize', label: '최소화' },
        { role: 'zoom', label: '확대/축소' },
        { type: 'separator' },
        { role: 'front', label: '모두 앞으로' },
      ],
    },
    {
      label: '도움말',
      role: 'help',
      submenu: [
        // ? 키는 렌더러 keydown 에서 처리하므로 메뉴에는 표시만 (중복 실행 방지)
        { label: '단축키 보기', accelerator: 'Shift+/', registerAccelerator: false, click: () => sendMenu('help') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- 창 ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Liquify',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    backgroundColor: '#FFF7E8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // 단축키는 입력기(IME)보다 먼저 여기서 가로챈다.
  // 한글 입력 상태에서는 페이지 keydown 이 'ㅈ'·'Process' 등으로 오거나 입력기에 먹혀서
  // 단축키가 동작하지 않을 수 있으므로, 물리 키(input.code) 기준으로 렌더러에 전달한다.
  win.webContents.on('before-input-event', (event, input) => {
    if (textFieldFocused) return;                      // 숫자 입력칸에 타이핑 중이면 그대로 둔다
    if (input.meta || input.control) return;           // ⌘ 조합은 메뉴가 처리
    if (input.type !== 'keyDown' && input.type !== 'keyUp') return;
    if (!SHORTCUT_CODES.has(input.code)) return;
    event.preventDefault();
    interceptCount++;
    win.webContents.send('shortcut', {
      type: input.type === 'keyDown' ? 'down' : 'up',
      code: input.code, shift: !!input.shift, alt: !!input.alt, repeat: !!input.isAutoRepeat,
    });
  });
  win.on('closed', () => { win = null; rendererReady = false; });

  if (selftestDir) {
    win.webContents.on('did-finish-load', () => runSelftest());
  }
}

async function runSelftest() {
  try {
    await fs.mkdir(selftestDir, { recursive: true });
    await new Promise((r) => setTimeout(r, 400));
    const emptyShot = await win.webContents.capturePage();
    await fs.writeFile(path.join(selftestDir, 'empty.png'), emptyShot.toPNG());
    const report = await win.webContents.executeJavaScript(
      `window.__selftest(${JSON.stringify(selftestDir)})`, true);
    // 실제 입력 경로(before-input-event → IPC) 단축키 검사
    const wc = win.webContents;
    const activeTool = () => wc.executeJavaScript(`document.querySelector('.tool.active').dataset.tool`);
    const press = async (keyCode, modifiers = []) => {
      wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
      await new Promise((r) => setTimeout(r, 120));
    };
    win.focus(); wc.focus();
    const before = interceptCount;
    const ipcCheck = {};
    await press('R'); ipcCheck.R = await activeTool();
    await press('C'); ipcCheck.C = await activeTool();
    await wc.executeJavaScript(`document.querySelector('.row[data-opt=size] input[type=number]').focus()`);
    await new Promise((r) => setTimeout(r, 100));
    await press('B'); ipcCheck.numberFocus_B = await activeTool();
    await wc.executeJavaScript(`document.activeElement.blur()`);
    await new Promise((r) => setTimeout(r, 100));
    await press('W'); ipcCheck.W = await activeTool();
    ipcCheck.intercepted = interceptCount - before;
    const ipcOk = ipcCheck.R === 'reconstruct' && ipcCheck.C === 'twirl' && ipcCheck.numberFocus_B === 'twirl'
      && ipcCheck.W === 'warp' && ipcCheck.intercepted === 3;
    report.steps.push(ipcOk ? { name: 'shortcuts-native', ...ipcCheck } : { name: 'shortcuts-native', fail: JSON.stringify(ipcCheck) });
    if (!ipcOk) report.ok = false;

    const shot = await win.webContents.capturePage();
    await fs.writeFile(path.join(selftestDir, 'ui.png'), shot.toPNG());
    await win.webContents.executeJavaScript(`document.querySelector('#help').hidden = false`);
    await new Promise((r) => setTimeout(r, 200));
    const helpShot = await win.webContents.capturePage();
    await fs.writeFile(path.join(selftestDir, 'help.png'), helpShot.toPNG());
    process.stdout.write('SELFTEST ' + JSON.stringify(report, null, 2) + '\n');
    app.exit(report && report.ok ? 0 : 2);
  } catch (err) {
    process.stdout.write('SELFTEST_ERROR ' + String(err && err.stack || err) + '\n');
    app.exit(3);
  }
}

// ---------- IPC ----------
ipcMain.on('text-focus', (_e, v) => { textFieldFocused = !!v; });

ipcMain.on('renderer-ready', () => {
  rendererReady = true;
  flushPendingOpen();
});

ipcMain.handle('open-dialog', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '사진 열기',
    properties: ['openFile'],
    filters: [{ name: '이미지', extensions: IMAGE_EXTS }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return readImageFile(r.filePaths[0], false);
});

ipcMain.handle('load-path', async (_e, p, forceConvert) => readImageFile(p, !!forceConvert));

ipcMain.handle('save-dialog', async (_e, defaultName) => {
  const r = await dialog.showSaveDialog(win, {
    title: '저장',
    defaultPath: path.join(app.getPath('pictures'), defaultName || 'image.jpg'),
    filters: [
      { name: 'JPEG', extensions: ['jpg', 'jpeg'] },
      { name: 'PNG', extensions: ['png'] },
    ],
  });
  if (r.canceled || !r.filePath) return null;
  let p = r.filePath;
  if (!/\.(jpe?g|png)$/i.test(p)) p += '.jpg';
  return p;
});

ipcMain.handle('write-file', async (_e, p, data) => {
  await fs.writeFile(p, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  return true;
});

ipcMain.handle('show-error', async (_e, title, message) => {
  dialog.showMessageBox(win, { type: 'error', title, message: title, detail: message, buttons: ['확인'] });
});

// ---------- 앱 라이프사이클 ----------
app.on('will-finish-launching', () => {
  app.on('open-file', (e, p) => {
    e.preventDefault();
    queueOpen(p);
  });
});

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  argvImagePaths(process.argv).forEach(queueOpen);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
