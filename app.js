lucide.createIcons();

// --- 状態管理 ---
let currentFile = null;
let videoDuration = 0;
let originalWidth = 0;
let originalHeight = 0;

let cropSettings = {
  enabled: false,
  preset: 'none',
  x: 0,
  y: 0,
  width: 0,
  height: 0
};

let trimSettings = {
  start: 0,
  end: 0
};

let outputFormat = 'mp4';
let outputQuality = 'medium';
let outputResolution = 'original';
let convertedBlob = null;
let convertedFile = null;
let convertedUrl = null;
let originalCreationTimeMs = null;

// --- DOM 要素 ---
const videoInput = document.getElementById('videoInput');
const selectTitle = document.getElementById('selectTitle');
const selectDesc = document.getElementById('selectDesc');
const selectSection = document.getElementById('selectSection');
const editorSection = document.getElementById('editorSection');
const progressSection = document.getElementById('progressSection');
const resultSection = document.getElementById('resultSection');

const fileMetaName = document.getElementById('fileMetaName');
const fileMetaRes = document.getElementById('fileMetaRes');
const fileMetaSize = document.getElementById('fileMetaSize');
const videoPreview = document.getElementById('videoPreview');

const videoStage = document.getElementById('videoStage');
const cropContainer = document.getElementById('cropContainer');
const cropBox = document.getElementById('cropBox');
const cropStatusText = document.getElementById('cropStatusText');
const cropPresetBtns = document.querySelectorAll('.crop-preset-btn');
const cropAlignControls = document.getElementById('cropAlignControls');
const alignTopBtn = document.getElementById('alignTopBtn');
const alignCenterBtn = document.getElementById('alignCenterBtn');
const alignBottomBtn = document.getElementById('alignBottomBtn');

const trimStartRange = document.getElementById('trimStartRange');
const trimEndRange = document.getElementById('trimEndRange');
const trimStartVal = document.getElementById('trimStartVal');
const trimEndVal = document.getElementById('trimEndVal');
const durationRangeText = document.getElementById('durationRangeText');
const setStartCurrentBtn = document.getElementById('setStartCurrentBtn');
const setEndCurrentBtn = document.getElementById('setEndCurrentBtn');

const formatBtns = document.querySelectorAll('.format-btn');
const qualityBtns = document.querySelectorAll('.quality-btn');
const resolutionSelect = document.getElementById('resolutionSelect');
const videoSettingsCard = document.getElementById('videoSettingsCard');

const startConvertBtn = document.getElementById('startConvertBtn');
const cancelConvertBtn = document.getElementById('cancelConvertBtn');
const reselectBtn = document.getElementById('reselectBtn');
const progressBar = document.getElementById('progressBar');
const progressPercent = document.getElementById('progressPercent');
const progressStatusText = document.getElementById('progressStatusText');

const resSizeBefore = document.getElementById('resSizeBefore');
const resSizeAfter = document.getElementById('resSizeAfter');
const resMetaInfo = document.getElementById('resMetaInfo');
const resultVideo = document.getElementById('resultVideo');
const resultImage = document.getElementById('resultImage');
const resultAudio = document.getElementById('resultAudio');
const downloadBtn = document.getElementById('downloadBtn');
const shareBtn = document.getElementById('shareBtn');
const resetBtn = document.getElementById('resetBtn');

// 1904-01-01 00:00:00 UTC と 1970-01-01 00:00:00 UTC の秒数差 (MP4/QuickTime規格)
const MAC_EPOCH_OFFSET_SEC = 2082844800;

function formatBytes(bytes, decimals = 1) {
  if (!+bytes) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function formatDateJP(ms) {
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd} ${hh}:${min}`;
}

// 元のファイル名（タイトル）を維持して拡張子のみ設定する
function getPreservedFileName(originalName, newExt) {
  if (!originalName) return `video.${newExt}`;
  const lastDot = originalName.lastIndexOf('.');
  const baseName = lastDot > 0 ? originalName.substring(0, lastDot) : originalName;
  return `${baseName}.${newExt}`;
}

// バッファ内から mvhd の creation_time (1904年基準秒) を探して Unix ミリ秒で返す
function findMvhdCreationTimeInBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const len = bytes.length;

  // 'mvhd' (0x6d, 0x76, 0x68, 0x64) を検索
  for (let i = 4; i < len - 24; i++) {
    if (
      bytes[i] === 0x6d &&
      bytes[i + 1] === 0x76 &&
      bytes[i + 2] === 0x68 &&
      bytes[i + 3] === 0x64
    ) {
      const boxSize = view.getUint32(i - 4, false);
      const version = bytes[i + 4];
      if (boxSize >= 96 && boxSize <= 512 && (version === 0 || version === 1)) {
        let macSec = 0;
        if (version === 0) {
          macSec = view.getUint32(i + 8, false);
        } else {
          const high = view.getUint32(i + 8, false);
          const low = view.getUint32(i + 12, false);
          macSec = high * 4294967296 + low;
        }
        // 1980年〜現在+1年以内の妥当なタイムスタンプか確認
        if (macSec > MAC_EPOCH_OFFSET_SEC + 315532800) {
          const unixMs = (macSec - MAC_EPOCH_OFFSET_SEC) * 1000;
          if (unixMs <= Date.now() + 86400000 * 365) {
            return unixMs;
          }
        }
      }
    }
  }
  return null;
}

// 元動画ファイルから本来の撮影日時を抽出する
async function extractOriginalCreationDate(file) {
  try {
    const chunkSize = 8 * 1024 * 1024; // 先頭・末尾 8MB を検査
    const headBuffer = await file.slice(0, Math.min(file.size, chunkSize)).arrayBuffer();
    const headTime = findMvhdCreationTimeInBuffer(headBuffer);
    if (headTime) return headTime;

    if (file.size > chunkSize) {
      const tailStart = Math.max(0, file.size - chunkSize);
      const tailBuffer = await file.slice(tailStart, file.size).arrayBuffer();
      const tailTime = findMvhdCreationTimeInBuffer(tailBuffer);
      if (tailTime) return tailTime;
    }
  } catch (e) {
    console.warn('Metadata date read skipped:', e);
  }
  return file.lastModified || Date.now();
}

// 変換後のMP4バイナリ内の mvhd / tkhd / mdhd の作成日時・更新日時を元の撮影日時に書き換える
async function patchMp4CreationTime(mp4Blob, targetTimeMs) {
  try {
    const buffer = await mp4Blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const len = bytes.length;

    const targetMacSec = Math.max(0, Math.floor(targetTimeMs / 1000) + MAC_EPOCH_OFFSET_SEC);

    for (let i = 4; i < len - 24; i++) {
      // 'mvhd' (6d 76 68 64), 'tkhd' (74 6b 68 64), 'mdhd' (6d 64 68 64)
      const isMvhd = bytes[i] === 0x6d && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x68 && bytes[i + 3] === 0x64;
      const isTkhd = bytes[i] === 0x74 && bytes[i + 1] === 0x6b && bytes[i + 2] === 0x68 && bytes[i + 3] === 0x64;
      const isMdhd = bytes[i] === 0x6d && bytes[i + 1] === 0x64 && bytes[i + 2] === 0x68 && bytes[i + 3] === 0x64;

      if (isMvhd || isTkhd || isMdhd) {
        const boxSize = view.getUint32(i - 4, false);
        const version = bytes[i + 4];
        // 各ヘッダBoxの妥当なサイズとバージョン(0 or 1)を確認
        if (boxSize >= 24 && boxSize <= 512 && (version === 0 || version === 1)) {
          if (version === 0) {
            view.setUint32(i + 8, targetMacSec, false);  // creation_time
            view.setUint32(i + 12, targetMacSec, false); // modification_time
          } else {
            view.setUint32(i + 8, 0, false);
            view.setUint32(i + 12, targetMacSec, false); // creation_time (64bit)
            view.setUint32(i + 16, 0, false);
            view.setUint32(i + 20, targetMacSec, false); // modification_time (64bit)
          }
        }
      }
    }

    return new Blob([buffer], { type: mp4Blob.type || 'video/mp4' });
  } catch (e) {
    console.warn('MP4 timestamp patch skipped:', e);
    return mp4Blob;
  }
}

// --- 動画選択 ---
videoInput.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  if (selectTitle) selectTitle.textContent = '動画を読み込み中...';
  if (selectDesc) selectDesc.textContent = `${file.name || '動画'} (${formatBytes(file.size)})`;

  try {
    currentFile = file;
    originalCreationTimeMs = await extractOriginalCreationDate(file);
    fileMetaName.textContent = `${file.name || 'video'} (${formatDateJP(originalCreationTimeMs)})`;
    fileMetaSize.textContent = formatBytes(file.size);

    const fileUrl = URL.createObjectURL(file);
    videoPreview.muted = true;
    videoPreview.playsInline = true;
    videoPreview.setAttribute('playsinline', '');
    videoPreview.setAttribute('webkit-playsinline', '');
    videoPreview.src = fileUrl;

    let hasLoaded = false;
    const onMetaLoaded = () => {
      if (hasLoaded) return;
      hasLoaded = true;

      originalWidth = videoPreview.videoWidth || 1920;
      originalHeight = videoPreview.videoHeight || 1080;
      videoDuration = videoPreview.duration || 10;

      fileMetaRes.textContent = `${originalWidth}×${originalHeight}`;

      trimSettings.start = 0;
      trimSettings.end = videoDuration;
      trimStartRange.max = videoDuration;
      trimStartRange.value = 0;
      trimEndRange.max = videoDuration;
      trimEndRange.value = videoDuration;

      updateTrimLabels();
      applyCropPreset('none');

      selectSection.classList.add('hidden');
      editorSection.classList.remove('hidden');
      lucide.createIcons();
    };

    videoPreview.onloadedmetadata = onMetaLoaded;
    videoPreview.onloadeddata = onMetaLoaded;
    videoPreview.oncanplay = onMetaLoaded;

    setTimeout(() => {
      if (!hasLoaded) onMetaLoaded();
    }, 1200);

  } catch (err) {
    console.error('File load error:', err);
    alert('動画の読み込みに失敗しました');
  }
});

reselectBtn.addEventListener('click', () => {
  videoInput.value = '';
  if (selectTitle) selectTitle.textContent = '写真・動画を選択';
  if (selectDesc) selectDesc.textContent = 'タップしてカメラロールから動画を選択';
  editorSection.classList.add('hidden');
  resultSection.classList.add('hidden');
  selectSection.classList.remove('hidden');
});

// --- トリミング設定 ---
function updateTrimLabels() {
  trimStartVal.textContent = formatTime(trimSettings.start);
  trimEndVal.textContent = formatTime(trimSettings.end);
  const diff = Math.max(0.1, trimSettings.end - trimSettings.start);
  durationRangeText.textContent = `${formatTime(trimSettings.start)} - ${formatTime(trimSettings.end)} (${diff.toFixed(1)}秒)`;
}

trimStartRange.addEventListener('input', (e) => {
  const val = parseFloat(e.target.value);
  if (val >= trimSettings.end) {
    trimSettings.start = Math.max(0, trimSettings.end - 0.5);
    trimStartRange.value = trimSettings.start;
  } else {
    trimSettings.start = val;
  }
  videoPreview.currentTime = trimSettings.start;
  updateTrimLabels();
});

trimEndRange.addEventListener('input', (e) => {
  const val = parseFloat(e.target.value);
  if (val <= trimSettings.start) {
    trimSettings.end = Math.min(videoDuration, trimSettings.start + 0.5);
    trimEndRange.value = trimSettings.end;
  } else {
    trimSettings.end = val;
  }
  videoPreview.currentTime = trimSettings.end;
  updateTrimLabels();
});

setStartCurrentBtn.addEventListener('click', () => {
  const cur = videoPreview.currentTime;
  if (cur < trimSettings.end) {
    trimSettings.start = cur;
    trimStartRange.value = cur;
    updateTrimLabels();
  }
});

setEndCurrentBtn.addEventListener('click', () => {
  const cur = videoPreview.currentTime;
  if (cur > trimSettings.start) {
    trimSettings.end = cur;
    trimEndRange.value = cur;
    updateTrimLabels();
  }
});

// --- クロップ（画面切り抜き） ---
function getStageScale() {
  const stageW = videoStage.clientWidth || 300;
  const stageH = videoStage.clientHeight || 200;
  return {
    scaleX: originalWidth / stageW,
    scaleY: originalHeight / stageH,
    stageW,
    stageH
  };
}

function updateCropBoxUI(pxX, pxY, pxW, pxH) {
  const { scaleX, scaleY } = getStageScale();

  const uiLeft = pxX / scaleX;
  const uiTop = pxY / scaleY;
  const uiWidth = pxW / scaleX;
  const uiHeight = pxH / scaleY;

  cropBox.style.left = `${uiLeft}px`;
  cropBox.style.top = `${uiTop}px`;
  cropBox.style.width = `${uiWidth}px`;
  cropBox.style.height = `${uiHeight}px`;

  cropSettings.x = Math.round(pxX);
  cropSettings.y = Math.round(pxY);
  cropSettings.width = Math.round(pxW);
  cropSettings.height = Math.round(pxH);

  cropStatusText.textContent = `${cropSettings.width} × ${cropSettings.height}`;
}

function applyCropPreset(preset) {
  cropSettings.preset = preset;

  cropPresetBtns.forEach(btn => {
    if (btn.dataset.preset === preset) {
      btn.className = 'crop-preset-btn active bg-blue-600 text-white font-medium py-2 rounded-xl transition-all';
    } else {
      btn.className = 'crop-preset-btn bg-zinc-800 hover:bg-zinc-700 text-zinc-300 py-2 rounded-xl transition-all';
    }
  });

  if (preset === 'none') {
    cropSettings.enabled = false;
    cropContainer.classList.add('hidden');
    cropAlignControls.classList.add('hidden');
    cropStatusText.textContent = '全体 (なし)';
    return;
  }

  cropSettings.enabled = true;
  cropContainer.classList.remove('hidden');
  cropAlignControls.classList.remove('hidden');

  let targetW = originalWidth;
  let targetH = originalHeight;
  let targetX = 0;
  let targetY = 0;

  if (preset === 'iphone-bar') {
    // iPhone画面録画: 上部7%（時計・Dynamic Island）、下部4%（ホームバー）を除去
    const topCut = Math.round(originalHeight * 0.07);
    const bottomCut = Math.round(originalHeight * 0.04);
    targetY = topCut;
    targetH = originalHeight - topCut - bottomCut;
    targetX = 0;
    targetW = originalWidth;
  } else if (preset === '9-16') {
    targetW = Math.min(originalWidth, Math.round(originalHeight * (9 / 16)));
    targetH = Math.round(targetW * (16 / 9));
    targetX = Math.round((originalWidth - targetW) / 2);
    targetY = Math.round((originalHeight - targetH) / 2);
  } else if (preset === '16-9') {
    targetH = Math.min(originalHeight, Math.round(originalWidth * (9 / 16)));
    targetW = Math.round(targetH * (16 / 9));
    targetX = Math.round((originalWidth - targetW) / 2);
    targetY = Math.round((originalHeight - targetH) / 2);
  } else if (preset === '1-1') {
    const side = Math.min(originalWidth, originalHeight);
    targetW = side;
    targetH = side;
    targetX = Math.round((originalWidth - side) / 2);
    targetY = Math.round((originalHeight - side) / 2);
  } else if (preset === 'custom') {
    targetW = Math.round(originalWidth * 0.85);
    targetH = Math.round(originalHeight * 0.85);
    targetX = Math.round((originalWidth - targetW) / 2);
    targetY = Math.round((originalHeight - targetH) / 2);
  }

  updateCropBoxUI(targetX, targetY, targetW, targetH);
}

cropPresetBtns.forEach(btn => {
  btn.addEventListener('click', () => applyCropPreset(btn.dataset.preset));
});

// 位置合わせボタン (上寄せ・中央・下寄せ)
alignTopBtn.addEventListener('click', () => {
  if (!cropSettings.enabled) return;
  updateCropBoxUI(cropSettings.x, 0, cropSettings.width, cropSettings.height);
});

alignCenterBtn.addEventListener('click', () => {
  if (!cropSettings.enabled) return;
  const centerY = Math.round((originalHeight - cropSettings.height) / 2);
  const centerX = Math.round((originalWidth - cropSettings.width) / 2);
  updateCropBoxUI(centerX, centerY, cropSettings.width, cropSettings.height);
});

alignBottomBtn.addEventListener('click', () => {
  if (!cropSettings.enabled) return;
  const bottomY = Math.max(0, originalHeight - cropSettings.height);
  updateCropBoxUI(cropSettings.x, bottomY, cropSettings.width, cropSettings.height);
});

// クロップ枠のタッチ＆ドラッグ（スマホスクロールを完全防止）
let isDragging = false;
let touchStartX = 0;
let touchStartY = 0;
let initialCropX = 0;
let initialCropY = 0;

function handleDragStart(clientX, clientY) {
  isDragging = true;
  touchStartX = clientX;
  touchStartY = clientY;
  initialCropX = cropSettings.x;
  initialCropY = cropSettings.y;
}

function handleDragMove(clientX, clientY) {
  if (!isDragging) return;
  const { scaleX, scaleY } = getStageScale();
  const deltaX = (clientX - touchStartX) * scaleX;
  const deltaY = (clientY - touchStartY) * scaleY;

  let newX = Math.max(0, Math.min(originalWidth - cropSettings.width, initialCropX + deltaX));
  let newY = Math.max(0, Math.min(originalHeight - cropSettings.height, initialCropY + deltaY));

  updateCropBoxUI(newX, newY, cropSettings.width, cropSettings.height);
}

function handleDragEnd() {
  isDragging = false;
}

// マウスイベント
cropBox.addEventListener('mousedown', (e) => handleDragStart(e.clientX, e.clientY));
window.addEventListener('mousemove', (e) => { if (isDragging) handleDragMove(e.clientX, e.clientY); });
window.addEventListener('mouseup', () => handleDragEnd());

// タッチイベント (スマホ専用：画面スクロールを完全に抑止)
cropBox.addEventListener('touchstart', (e) => {
  if (e.touches.length === 1) {
    e.preventDefault(); // スクロール防止
    handleDragStart(e.touches[0].clientX, e.touches[0].clientY);
  }
}, { passive: false });

window.addEventListener('touchmove', (e) => {
  if (isDragging && e.touches.length === 1) {
    e.preventDefault(); // スクロール防止
    handleDragMove(e.touches[0].clientX, e.touches[0].clientY);
  }
}, { passive: false });

window.addEventListener('touchend', () => handleDragEnd());
window.addEventListener('touchcancel', () => handleDragEnd());

// --- 出力フォーマット ---
formatBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    outputFormat = btn.dataset.format;
    formatBtns.forEach(b => {
      b.className = (b === btn)
        ? 'format-btn active bg-blue-600 text-white font-medium py-2.5 rounded-xl flex flex-col items-center gap-1 transition-all'
        : 'format-btn bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-medium py-2.5 rounded-xl flex flex-col items-center gap-1 transition-all';
    });

    if (outputFormat === 'wav') {
      videoSettingsCard.classList.add('hidden');
    } else {
      videoSettingsCard.classList.remove('hidden');
    }
  });
});

qualityBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    outputQuality = btn.dataset.quality;
    qualityBtns.forEach(b => {
      if (b === btn) {
        b.className = 'quality-btn active px-3 py-1 rounded-lg text-white font-medium bg-blue-600 transition-all';
      } else {
        b.className = 'quality-btn px-3 py-1 rounded-lg text-zinc-400 transition-all';
      }
    });
  });
});

resolutionSelect.addEventListener('change', (e) => {
  outputResolution = e.target.value;
});

// キャンセル制御フラグ
let isCancelled = false;
let currentRecorder = null;

// 変換停止ボタンの処理
cancelConvertBtn.addEventListener('click', () => {
  isCancelled = true;
  if (videoPreview) {
    videoPreview.pause();
  }
  if (currentRecorder && currentRecorder.state !== 'inactive') {
    try {
      currentRecorder.stop();
    } catch (e) {}
  }
  progressSection.classList.add('hidden');
  editorSection.classList.remove('hidden');
  progressBar.style.width = '0%';
  progressPercent.textContent = '0%';
});

// --- 変換実行 (切り取り処理) ---
startConvertBtn.addEventListener('click', async () => {
  if (!currentFile) return;

  isCancelled = false;
  editorSection.classList.add('hidden');
  progressSection.classList.remove('hidden');
  progressBar.style.width = '0%';
  progressPercent.textContent = '0%';
  progressStatusText.textContent = '切り取り処理を開始中...';
  lucide.createIcons();

  try {
    if (outputFormat === 'gif') {
      await convertToGIF();
    } else if (outputFormat === 'wav') {
      await convertToAudio();
    } else {
      await convertToVideo();
    }
  } catch (err) {
    if (isCancelled) return; // ユーザーキャンセル時はエラーアラートを出さない
    console.error('Conversion failed:', err);
    alert('切り取り処理中にエラーが発生しました: ' + (err.message || err));
    progressSection.classList.add('hidden');
    editorSection.classList.remove('hidden');
  }
});

// 1. 動画の切り取り＆エンコード
async function convertToVideo() {
  progressStatusText.textContent = '動画を切り取り＆エンコード中...';

  // 切り抜き範囲の決定
  let sx = 0, sy = 0, sw = originalWidth, sh = originalHeight;
  if (cropSettings.enabled) {
    sx = Math.max(0, cropSettings.x);
    sy = Math.max(0, cropSettings.y);
    sw = Math.min(originalWidth - sx, cropSettings.width);
    sh = Math.min(originalHeight - sy, cropSettings.height);
  }

  let outW = sw;
  let outH = sh;
  if (outputResolution !== 'original') {
    const target = parseInt(outputResolution);
    if (sw >= sh) {
      outW = Math.round(target * (sw / sh));
      outH = target;
    } else {
      outW = target;
      outH = Math.round(target * (sh / sw));
    }
  }
  // 偶数ピクセル丸め
  outW = Math.floor(outW / 2) * 2;
  outH = Math.floor(outH / 2) * 2;

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');

  // ビットレート
  let bitrate = 4000000;
  if (outputQuality === 'high') bitrate = 8000000;
  if (outputQuality === 'small') bitrate = 1500000;

  const canvasStream = canvas.captureStream(30);

  // iPhoneでサポートされている動画形式を自動判別
  let mimeType = 'video/mp4';
  if (!MediaRecorder.isTypeSupported('video/mp4')) {
    mimeType = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1') ? 'video/mp4;codecs=avc1' : 'video/webm';
  }

  const recorder = new MediaRecorder(canvasStream, {
    mimeType: mimeType,
    videoBitsPerSecond: bitrate
  });
  currentRecorder = recorder;

  const chunks = [];
  recorder.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data); };

  const startSec = trimSettings.start;
  const endSec = trimSettings.end;
  const totalDuration = Math.max(0.2, endSec - startSec);

  // 画面上のvideoPreviewを使って確実に再生・キャプチャ
  videoPreview.currentTime = startSec;
  videoPreview.muted = true; // Safari必須
  await new Promise(r => {
    videoPreview.onseeked = r;
    setTimeout(r, 300);
  });

  recorder.start(100);
  try {
    await videoPreview.play();
  } catch (e) {
    console.warn('Play interrupted, retrying muted...', e);
    videoPreview.muted = true;
    await videoPreview.play();
  }

  let isRunning = true;
  function renderFrame() {
    if (!isRunning || isCancelled) {
      isRunning = false;
      return;
    }

    // クロップ描画
    ctx.drawImage(videoPreview, sx, sy, sw, sh, 0, 0, outW, outH);

    const currentSec = videoPreview.currentTime;
    const progress = (currentSec - startSec) / totalDuration;
    const pct = Math.min(100, Math.max(0, Math.round(progress * 100)));
    progressBar.style.width = `${pct}%`;
    progressPercent.textContent = `${pct}%`;

    if (currentSec >= endSec || videoPreview.ended) {
      isRunning = false;
      videoPreview.pause();
      if (!isCancelled) recorder.stop();
    } else {
      requestAnimationFrame(renderFrame);
    }
  }

  renderFrame();

  await new Promise(resolve => recorder.onstop = resolve);
  if (isCancelled) return;

  const finalExt = mimeType.includes('mp4') ? 'mp4' : 'webm';
  convertedBlob = new Blob(chunks, { type: mimeType });
  await finishConversion(finalExt);
}

// 2. GIF 変換
async function convertToGIF() {
  progressStatusText.textContent = 'GIFフレームを生成中...';
  const startSec = trimSettings.start;
  const duration = Math.min(10, trimSettings.end - startSec);

  let sx = cropSettings.enabled ? cropSettings.x : 0;
  let sy = cropSettings.enabled ? cropSettings.y : 0;
  let sw = cropSettings.enabled ? cropSettings.width : originalWidth;
  let sh = cropSettings.enabled ? cropSettings.height : originalHeight;

  gifshot.createGIF({
    video: [URL.createObjectURL(currentFile)],
    offset: startSec,
    duration: duration,
    numFrames: Math.round(duration * 10),
    frameDuration: 1,
    sampleInterval: 10,
    videoX: sx,
    videoY: sy,
    videoWidth: sw,
    videoHeight: sh,
    gifWidth: 400,
    gifHeight: Math.round(400 * (sh / sw)),
    progressCallback: (captureProgress) => {
      const pct = Math.round(captureProgress * 100);
      progressBar.style.width = `${pct}%`;
      progressPercent.textContent = `${pct}%`;
    }
  }, (obj) => {
    if (!obj.error) {
      const byteCharacters = atob(obj.image.split(',')[1]);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      convertedBlob = new Blob([new Uint8Array(byteNumbers)], { type: 'image/gif' });
      finishConversion('gif');
    } else {
      throw new Error(obj.error);
    }
  });
}

// 3. 音声抽出 (WAV)
async function convertToAudio() {
  progressStatusText.textContent = '音声を抽出しています...';
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const response = await fetch(URL.createObjectURL(currentFile));
  const arrayBuffer = await response.arrayBuffer();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

  const startSec = trimSettings.start;
  const endSec = trimSettings.end;
  const startSample = Math.floor(startSec * audioBuffer.sampleRate);
  const endSample = Math.floor(endSec * audioBuffer.sampleRate);
  const length = Math.max(1000, endSample - startSample);

  const trimmed = audioCtx.createBuffer(audioBuffer.numberOfChannels, length, audioBuffer.sampleRate);
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    trimmed.copyToChannel(audioBuffer.getChannelData(ch).subarray(startSample, endSample), ch, 0);
  }

  convertedBlob = audioBufferToWavBlob(trimmed);
  await finishConversion('wav');
}

function audioBufferToWavBlob(buffer) {
  const numOfChan = buffer.numberOfChannels;
  const length = buffer.length * numOfChan * 2 + 44;
  const out = new DataView(new ArrayBuffer(length));
  let pos = 0;

  function setUint16(data) { out.setUint16(pos, data, true); pos += 2; }
  function setUint32(data) { out.setUint32(pos, data, true); pos += 4; }

  out.setUint32(0, 0x46464952, true); // "RIFF"
  out.setUint32(4, length - 8, true);
  out.setUint32(8, 0x45564157, true); // "WAVE"
  out.setUint32(12, 0x20746d66, true); // "fmt "
  setUint32(16);
  setUint16(1);
  setUint16(numOfChan);
  setUint32(buffer.sampleRate);
  setUint32(buffer.sampleRate * 2 * numOfChan);
  setUint16(numOfChan * 2);
  setUint16(16);
  out.setUint32(pos, 0x61746164, true); pos += 4; // "data"
  setUint32(length - pos - 4);

  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numOfChan; ch++) {
      let sample = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      out.setInt16(pos, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      pos += 2;
    }
  }

  return new Blob([out.buffer], { type: 'audio/wav' });
}

async function finishConversion(ext) {
  const targetDateMs = originalCreationTimeMs || (currentFile && currentFile.lastModified) || Date.now();
  const finalFileName = getPreservedFileName(currentFile ? currentFile.name : 'video', ext);

  // MP4の場合はバイナリ内部のmvhd/tkhd/mdhd作成日時を元の撮影日時に書き換える（Googleフォト・写真アプリの撮影日維持）
  if (ext === 'mp4') {
    progressStatusText.textContent = '元の撮影日時・タイトルを書き込み中...';
    convertedBlob = await patchMp4CreationTime(convertedBlob, targetDateMs);
  }

  // 元のタイトル・元の更新日時(lastModified)を持ったFileオブジェクトを生成
  convertedFile = new File([convertedBlob], finalFileName, {
    type: convertedBlob.type,
    lastModified: targetDateMs
  });

  convertedUrl = URL.createObjectURL(convertedFile);

  progressSection.classList.add('hidden');
  resultSection.classList.remove('hidden');

  resSizeBefore.textContent = formatBytes(currentFile.size);
  resSizeAfter.textContent = `${formatBytes(convertedBlob.size)} (${Math.round((1 - convertedBlob.size / currentFile.size) * 100)}% 削減)`;
  if (resMetaInfo) {
    resMetaInfo.textContent = `📄 ${finalFileName} ｜ 📅 ${formatDateJP(targetDateMs)}`;
  }

  resultVideo.classList.add('hidden');
  resultImage.classList.add('hidden');
  resultAudio.classList.add('hidden');

  if (ext === 'gif') {
    resultImage.src = convertedUrl;
    resultImage.classList.remove('hidden');
  } else if (ext === 'wav') {
    resultAudio.src = convertedUrl;
    resultAudio.classList.remove('hidden');
  } else {
    resultVideo.src = convertedUrl;
    resultVideo.classList.remove('hidden');
  }

  downloadBtn.href = convertedUrl;
  downloadBtn.download = finalFileName;

  lucide.createIcons();
}

shareBtn.addEventListener('click', async () => {
  if (!convertedFile) return;

  // iOS Safariで「ビデオを保存」（写真アプリへ直接保存）を確実に出すため、titleやtextを含めずfilesのみを渡す
  if (navigator.canShare && navigator.canShare({ files: [convertedFile] })) {
    try {
      await navigator.share({
        files: [convertedFile]
      });
    } catch (err) {
      if (err.name !== 'AbortError') console.error('Share failed:', err);
    }
  } else {
    downloadBtn.click();
  }
});

resetBtn.addEventListener('click', () => {
  resultSection.classList.add('hidden');
  selectSection.classList.remove('hidden');
  videoInput.value = '';
  currentFile = null;
});
