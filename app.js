if (typeof lucide !== 'undefined') lucide.createIcons();

// --- 状態管理 ---
let currentFile = null;
let currentFileUrl = null;
let videoDuration = 0;
let originalWidth = 0;
let originalHeight = 0;
let originalCreationTimeMs = null;

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

// キャンセル制御・スリープ防止
let isCancelled = false;
let currentRecorder = null;
let wakeLockSentinel = null;

async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
    } catch (e) {}
  }
}

function releaseWakeLock() {
  if (wakeLockSentinel) {
    try { wakeLockSentinel.release(); } catch (e) {}
    wakeLockSentinel = null;
  }
}

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

// 1904-01-01 00:00:00 UTC と 1970-01-01 00:00:00 UTC の秒数差
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
  const d = new Date(ms || Date.now());
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd} ${hh}:${min}`;
}

function getPreservedFileName(originalName, newExt) {
  if (!originalName) return `video.${newExt}`;
  const lastDot = originalName.lastIndexOf('.');
  const baseName = lastDot > 0 ? originalName.substring(0, lastDot) : originalName;
  return `${baseName}.${newExt}`;
}

function findMvhdCreationTimeInBuffer(buffer) {
  try {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const len = bytes.length;

    for (let i = 4; i <= len - 24; i++) {
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
          if (macSec > MAC_EPOCH_OFFSET_SEC + 315532800) {
            const unixMs = (macSec - MAC_EPOCH_OFFSET_SEC) * 1000;
            if (unixMs <= Date.now() + 86400000 * 365) {
              return unixMs;
            }
          }
        }
      }
    }
  } catch (e) {}
  return null;
}

async function extractOriginalCreationDate(file) {
  try {
    const chunkSize = 256 * 1024; // 256KBのみ検査
    const headBuffer = await file.slice(0, Math.min(file.size, chunkSize)).arrayBuffer();
    const headTime = findMvhdCreationTimeInBuffer(headBuffer);
    if (headTime) return headTime;

    if (file.size > chunkSize) {
      const tailStart = Math.max(0, file.size - chunkSize);
      const tailBuffer = await file.slice(tailStart, file.size).arrayBuffer();
      const tailTime = findMvhdCreationTimeInBuffer(tailBuffer);
      if (tailTime) return tailTime;
    }
  } catch (e) {}
  return (file && file.lastModified) || Date.now();
}

// 先頭・末尾の64KBのみを書き換える超省メモリ方式
async function patchMp4CreationTime(mp4Blob, targetTimeMs) {
  try {
    const totalSize = mp4Blob.size;
    if (totalSize < 32) return mp4Blob;

    const targetMacSec = (Math.max(0, Math.floor(targetTimeMs / 1000) + MAC_EPOCH_OFFSET_SEC)) >>> 0;

    const patchBuffer = (buffer) => {
      const bytes = new Uint8Array(buffer);
      const view = new DataView(buffer);
      const len = bytes.length;

      for (let i = 4; i <= len - 24; i++) {
        const isMvhd = bytes[i] === 0x6d && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x68 && bytes[i + 3] === 0x64;
        const isTkhd = bytes[i] === 0x74 && bytes[i + 1] === 0x6b && bytes[i + 2] === 0x68 && bytes[i + 3] === 0x64;
        const isMdhd = bytes[i] === 0x6d && bytes[i + 1] === 0x64 && bytes[i + 2] === 0x68 && bytes[i + 3] === 0x64;

        if (isMvhd || isTkhd || isMdhd) {
          const boxSize = view.getUint32(i - 4, false);
          const version = bytes[i + 4];
          if (boxSize >= 24 && boxSize <= 512 && (version === 0 || version === 1)) {
            if (version === 0 && i + 16 <= len) {
              view.setUint32(i + 8, targetMacSec, false);
              view.setUint32(i + 12, targetMacSec, false);
            } else if (version === 1 && i + 24 <= len) {
              view.setUint32(i + 8, 0, false);
              view.setUint32(i + 12, targetMacSec, false);
              view.setUint32(i + 16, 0, false);
              view.setUint32(i + 20, targetMacSec, false);
            }
          }
        }
      }
      return buffer;
    };

    const SLICE_SIZE = 64 * 1024; // 64KBのみ
    if (totalSize <= SLICE_SIZE * 2) {
      const buf = patchBuffer(await mp4Blob.arrayBuffer());
      return new Blob([buf], { type: 'video/mp4' });
    } else {
      const headBuf = patchBuffer(await mp4Blob.slice(0, SLICE_SIZE).arrayBuffer());
      const middleBlob = mp4Blob.slice(SLICE_SIZE, totalSize - SLICE_SIZE);
      const tailBuf = patchBuffer(await mp4Blob.slice(totalSize - SLICE_SIZE, totalSize).arrayBuffer());
      return new Blob([headBuf, middleBlob, tailBuf], { type: 'video/mp4' });
    }
  } catch (e) {
    return mp4Blob;
  }
}

// --- 動画選択 ---
if (videoInput) {
  videoInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    if (selectTitle) selectTitle.textContent = '動画を読み込み中...';
    if (selectDesc) selectDesc.textContent = `${file.name || '動画'} (${formatBytes(file.size)})`;

    try {
      if (currentFileUrl) {
        try { URL.revokeObjectURL(currentFileUrl); } catch (err) {}
      }
      currentFile = file;
      originalCreationTimeMs = await extractOriginalCreationDate(file);
      if (fileMetaName) fileMetaName.textContent = `${file.name || 'video'} (${formatDateJP(originalCreationTimeMs)})`;
      if (fileMetaSize) fileMetaSize.textContent = formatBytes(file.size);

      currentFileUrl = URL.createObjectURL(file);
      videoPreview.muted = true;
      videoPreview.playsInline = true;
      videoPreview.setAttribute('playsinline', '');
      videoPreview.setAttribute('webkit-playsinline', '');
      videoPreview.src = currentFileUrl;

      let hasLoaded = false;
      const onMetaLoaded = () => {
        if (hasLoaded) return;
        hasLoaded = true;

        originalWidth = videoPreview.videoWidth || 1920;
        originalHeight = videoPreview.videoHeight || 1080;
        videoDuration = videoPreview.duration || 10;

        if (fileMetaRes) fileMetaRes.textContent = `${originalWidth}×${originalHeight}`;

        trimSettings.start = 0;
        trimSettings.end = videoDuration;
        if (trimStartRange) {
          trimStartRange.max = videoDuration;
          trimStartRange.value = 0;
        }
        if (trimEndRange) {
          trimEndRange.max = videoDuration;
          trimEndRange.value = videoDuration;
        }

        updateTrimLabels();
        applyCropPreset('none');

        if (selectSection) selectSection.classList.add('hidden');
        if (editorSection) editorSection.classList.remove('hidden');
        if (typeof lucide !== 'undefined') lucide.createIcons();
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
}

if (reselectBtn) {
  reselectBtn.addEventListener('click', () => {
    if (videoInput) videoInput.value = '';
    if (selectTitle) selectTitle.textContent = '写真・動画を選択';
    if (selectDesc) selectDesc.textContent = 'タップしてカメラロールから動画を選択';
    if (editorSection) editorSection.classList.add('hidden');
    if (resultSection) resultSection.classList.add('hidden');
    if (selectSection) selectSection.classList.remove('hidden');
  });
}

// --- トリミング設定 ---
function updateTrimLabels() {
  if (trimStartVal) trimStartVal.textContent = formatTime(trimSettings.start);
  if (trimEndVal) trimEndVal.textContent = formatTime(trimSettings.end);
  const diff = Math.max(0.1, trimSettings.end - trimSettings.start);
  if (durationRangeText) {
    durationRangeText.textContent = `${formatTime(trimSettings.start)} - ${formatTime(trimSettings.end)} (${diff.toFixed(1)}秒)`;
  }
}

if (trimStartRange) {
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
}

if (trimEndRange) {
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
}

if (setStartCurrentBtn) {
  setStartCurrentBtn.addEventListener('click', () => {
    const cur = videoPreview.currentTime;
    if (cur < trimSettings.end) {
      trimSettings.start = cur;
      if (trimStartRange) trimStartRange.value = cur;
      updateTrimLabels();
    }
  });
}

if (setEndCurrentBtn) {
  setEndCurrentBtn.addEventListener('click', () => {
    const cur = videoPreview.currentTime;
    if (cur > trimSettings.start) {
      trimSettings.end = cur;
      if (trimEndRange) trimEndRange.value = cur;
      updateTrimLabels();
    }
  });
}

// --- クロップ（画面切り抜き） ---
function getStageScale() {
  const stageW = (videoStage && videoStage.clientWidth) || videoPreview.clientWidth || 300;
  const stageH = (videoStage && videoStage.clientHeight) || videoPreview.clientHeight || 200;
  return {
    scaleX: (originalWidth || 1920) / stageW,
    scaleY: (originalHeight || 1080) / stageH,
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

  if (cropBox) {
    cropBox.style.left = `${uiLeft}px`;
    cropBox.style.top = `${uiTop}px`;
    cropBox.style.width = `${uiWidth}px`;
    cropBox.style.height = `${uiHeight}px`;
  }

  cropSettings.x = Math.round(pxX);
  cropSettings.y = Math.round(pxY);
  cropSettings.width = Math.round(pxW);
  cropSettings.height = Math.round(pxH);

  if (cropStatusText) cropStatusText.textContent = `${cropSettings.width} × ${cropSettings.height}`;
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
    if (cropContainer) cropContainer.classList.add('hidden');
    if (cropAlignControls) cropAlignControls.classList.add('hidden');
    if (cropStatusText) cropStatusText.textContent = '全体 (なし)';
    return;
  }

  cropSettings.enabled = true;
  if (cropContainer) cropContainer.classList.remove('hidden');
  if (cropAlignControls) cropAlignControls.classList.remove('hidden');

  let targetW = originalWidth;
  let targetH = originalHeight;
  let targetX = 0;
  let targetY = 0;

  if (preset === 'iphone-bar') {
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

if (alignTopBtn) {
  alignTopBtn.addEventListener('click', () => {
    if (!cropSettings.enabled) return;
    updateCropBoxUI(cropSettings.x, 0, cropSettings.width, cropSettings.height);
  });
}

if (alignCenterBtn) {
  alignCenterBtn.addEventListener('click', () => {
    if (!cropSettings.enabled) return;
    const centerY = Math.round((originalHeight - cropSettings.height) / 2);
    const centerX = Math.round((originalWidth - cropSettings.width) / 2);
    updateCropBoxUI(centerX, centerY, cropSettings.width, cropSettings.height);
  });
}

if (alignBottomBtn) {
  alignBottomBtn.addEventListener('click', () => {
    if (!cropSettings.enabled) return;
    const bottomY = Math.max(0, originalHeight - cropSettings.height);
    updateCropBoxUI(cropSettings.x, bottomY, cropSettings.width, cropSettings.height);
  });
}

// クロップ枠のタッチ＆ドラッグ
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

if (cropBox) {
  cropBox.addEventListener('mousedown', (e) => handleDragStart(e.clientX, e.clientY));
  cropBox.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      e.preventDefault();
      handleDragStart(e.touches[0].clientX, e.touches[0].clientY);
    }
  }, { passive: false });
}

window.addEventListener('mousemove', (e) => { if (isDragging) handleDragMove(e.clientX, e.clientY); });
window.addEventListener('mouseup', () => handleDragEnd());
window.addEventListener('touchmove', (e) => {
  if (isDragging && e.touches.length === 1) {
    e.preventDefault();
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

    if (videoSettingsCard) {
      if (outputFormat === 'wav') {
        videoSettingsCard.classList.add('hidden');
      } else {
        videoSettingsCard.classList.remove('hidden');
      }
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

if (resolutionSelect) {
  resolutionSelect.addEventListener('change', (e) => {
    outputResolution = e.target.value;
  });
}

// 変換停止ボタン
if (cancelConvertBtn) {
  cancelConvertBtn.addEventListener('click', () => {
    isCancelled = true;
    releaseWakeLock();
    document.title = 'Video Converter - ビデオコンバーター';
    if (videoPreview) videoPreview.pause();
    if (currentRecorder && currentRecorder.state !== 'inactive') {
      try { currentRecorder.stop(); } catch (e) {}
    }
    if (progressSection) progressSection.classList.add('hidden');
    if (editorSection) {
      editorSection.classList.remove('hidden');
      editorSection.style.cssText = '';
    }
    if (progressBar) progressBar.style.width = '0%';
    if (progressPercent) progressPercent.textContent = '0%';
  });
}

// --- 変換実行 ---
if (startConvertBtn) {
  startConvertBtn.addEventListener('click', async () => {
    if (!currentFile) return;

    isCancelled = false;
    await requestWakeLock();

    // ★重要: iOS SafariでvideoPreviewをdisplay:none(hidden)にするとGPUデコーダが壊れて完了時にクラッシュするため、
    // 画面外・透明化して描画状態を維持する
    if (editorSection) {
      editorSection.style.cssText = 'position:fixed; left:-9999px; top:0; width:320px; height:240px; opacity:0.01; pointer-events:none; overflow:hidden;';
    }
    if (progressSection) progressSection.classList.remove('hidden');
    if (progressBar) progressBar.style.width = '0%';
    if (progressPercent) progressPercent.textContent = '0%';
    if (progressStatusText) progressStatusText.textContent = '切り取り処理を開始中...';
    if (typeof lucide !== 'undefined') lucide.createIcons();

    try {
      if (outputFormat === 'gif') {
        await convertToGIF();
      } else if (outputFormat === 'wav') {
        await convertToAudio();
      } else {
        await convertToVideo();
      }
    } catch (err) {
      releaseWakeLock();
      document.title = 'Video Converter - ビデオコンバーター';
      if (isCancelled) return;
      console.error('Conversion failed:', err);
      alert('切り取り処理中にエラーが発生しました: ' + (err.message || err));
      if (progressSection) progressSection.classList.add('hidden');
      if (editorSection) {
        editorSection.style.cssText = '';
        editorSection.classList.remove('hidden');
      }
    }
  });
}

// 1. 動画の切り取り＆エンコード（iOS Safari クラッシュ完全対策版）
async function convertToVideo() {
  if (progressStatusText) progressStatusText.textContent = '動画を切り取り＆エンコード中...';

  if (!videoPreview.src && currentFileUrl) {
    videoPreview.src = currentFileUrl;
  }

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
  } else {
    // ★重要: iOS SafariのMediaRecorderは長辺が1280pxを超えるとファイナライズ時にGPUメモリ上限でクラッシュするため安全上限(1280px)に収める
    const maxSafeSide = 1280;
    const maxCurrent = Math.max(outW, outH);
    if (maxCurrent > maxSafeSide) {
      const ratio = maxSafeSide / maxCurrent;
      outW = Math.round(outW * ratio);
      outH = Math.round(outH * ratio);
    }
  }
  // H.264 ハードウェアエンコーダ必須の16の倍数（または偶数）に丸める
  outW = Math.max(16, Math.floor(outW / 4) * 4);
  outH = Math.max(16, Math.floor(outH / 4) * 4);

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d', { alpha: false });

  let bitrate = 2500000;
  if (outputQuality === 'high') bitrate = 5000000;
  if (outputQuality === 'small') bitrate = 1200000;

  const canvasStream = canvas.captureStream(24);

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

  videoPreview.currentTime = startSec;
  videoPreview.muted = true;
  await new Promise(r => {
    videoPreview.onseeked = r;
    setTimeout(r, 300);
  });

  // 最初の1フレームを描画してからスタート
  ctx.drawImage(videoPreview, sx, sy, sw, sh, 0, 0, outW, outH);

  // ★重要: タイムスライスなしの start() にすることで、細切れチャンク大量生成によるSafariクラッシュを防ぐ
  recorder.start();

  try {
    await videoPreview.play();
  } catch (e) {
    videoPreview.muted = true;
    await videoPreview.play();
  }

  let isRunning = true;
  function renderFrame() {
    if (!isRunning || isCancelled) {
      isRunning = false;
      return;
    }

    ctx.drawImage(videoPreview, sx, sy, sw, sh, 0, 0, outW, outH);

    const currentSec = videoPreview.currentTime;
    const progress = (currentSec - startSec) / totalDuration;
    const pct = Math.min(99, Math.max(0, Math.round(progress * 100)));
    if (progressBar) progressBar.style.width = `${pct}%`;
    if (progressPercent) progressPercent.textContent = `${pct}%`;
    document.title = `(${pct}%) 変換中...`;

    if (currentSec >= endSec || videoPreview.ended) {
      isRunning = false;
      videoPreview.pause();
      if (!isCancelled && recorder.state !== 'inactive') {
        recorder.stop();
      }
    } else if (document.hidden) {
      setTimeout(renderFrame, 40);
    } else {
      requestAnimationFrame(renderFrame);
    }
  }

  renderFrame();

  await new Promise(resolve => recorder.onstop = resolve);

  // GPU・ストリームメモリを即座に解放
  try { canvasStream.getTracks().forEach(t => t.stop()); } catch (e) {}
  canvas.width = 1;
  canvas.height = 1;

  if (editorSection) {
    editorSection.style.cssText = '';
    editorSection.classList.add('hidden');
  }

  if (isCancelled) {
    chunks.length = 0;
    return;
  }

  const finalExt = mimeType.includes('mp4') ? 'mp4' : 'webm';
  const cleanMime = finalExt === 'mp4' ? 'video/mp4' : 'video/webm';
  convertedBlob = new Blob(chunks, { type: cleanMime });
  chunks.length = 0;

  await finishConversion(finalExt);
}

// 2. GIF 変換
function convertToGIF() {
  return new Promise((resolve, reject) => {
    if (progressStatusText) progressStatusText.textContent = 'GIFフレームを生成中...';
    const startSec = trimSettings.start;
    const duration = Math.min(10, trimSettings.end - startSec);

    let sx = cropSettings.enabled ? cropSettings.x : 0;
    let sy = cropSettings.enabled ? cropSettings.y : 0;
    let sw = cropSettings.enabled ? cropSettings.width : originalWidth;
    let sh = cropSettings.enabled ? cropSettings.height : originalHeight;

    gifshot.createGIF({
      video: [currentFileUrl || URL.createObjectURL(currentFile)],
      offset: startSec,
      duration: duration,
      numFrames: Math.max(5, Math.round(duration * 10)),
      frameDuration: 1,
      sampleInterval: 10,
      videoX: sx,
      videoY: sy,
      videoWidth: sw,
      videoHeight: sh,
      gifWidth: 360,
      gifHeight: Math.round(360 * (sh / (sw || 1))),
      progressCallback: (captureProgress) => {
        const pct = Math.round(captureProgress * 100);
        if (progressBar) progressBar.style.width = `${pct}%`;
        if (progressPercent) progressPercent.textContent = `${pct}%`;
      }
    }, async (obj) => {
      if (editorSection) {
        editorSection.style.cssText = '';
        editorSection.classList.add('hidden');
      }
      if (!obj.error) {
        try {
          const byteCharacters = atob(obj.image.split(',')[1]);
          const byteNumbers = new Array(byteCharacters.length);
          for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
          }
          convertedBlob = new Blob([new Uint8Array(byteNumbers)], { type: 'image/gif' });
          await finishConversion('gif');
          resolve();
        } catch (err) {
          reject(err);
        }
      } else {
        reject(new Error(obj.error));
      }
    });
  });
}

// 3. 音声抽出 (WAV)
async function convertToAudio() {
  if (progressStatusText) progressStatusText.textContent = '音声を抽出しています...';
  if (editorSection) {
    editorSection.style.cssText = '';
    editorSection.classList.add('hidden');
  }
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const response = await fetch(currentFileUrl || URL.createObjectURL(currentFile));
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

  out.setUint32(0, 0x46464952, true);
  out.setUint32(4, length - 8, true);
  out.setUint32(8, 0x45564157, true);
  out.setUint32(12, 0x20746d66, true);
  setUint32(16);
  setUint16(1);
  setUint16(numOfChan);
  setUint32(buffer.sampleRate);
  setUint32(buffer.sampleRate * 2 * numOfChan);
  setUint16(numOfChan * 2);
  setUint16(16);
  out.setUint32(pos, 0x61746164, true); pos += 4;
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

// --- 完了処理 ---
async function finishConversion(ext) {
  releaseWakeLock();
  document.title = '✅【変換完了】ビデオコンバーター';

  // 編集用ビデオのメモリを解放して完了画面のクラッシュを防ぐ
  try {
    videoPreview.pause();
    videoPreview.removeAttribute('src');
    videoPreview.load();
  } catch (e) {}

  const targetDateMs = originalCreationTimeMs || (currentFile && currentFile.lastModified) || Date.now();
  const finalFileName = getPreservedFileName(currentFile ? currentFile.name : 'video', ext);

  if (ext === 'mp4') {
    if (progressStatusText) progressStatusText.textContent = '元の撮影日時・タイトルを書き込み中...';
    convertedBlob = await patchMp4CreationTime(convertedBlob, targetDateMs);
  }

  const cleanMime = ext === 'mp4' ? 'video/mp4' : (ext === 'gif' ? 'image/gif' : (ext === 'wav' ? 'audio/wav' : 'video/webm'));

  try {
    convertedFile = new File([convertedBlob], finalFileName, {
      type: cleanMime,
      lastModified: targetDateMs
    });
  } catch (e) {
    convertedFile = convertedBlob;
    convertedFile.name = finalFileName;
  }

  if (convertedUrl) {
    try { URL.revokeObjectURL(convertedUrl); } catch (e) {}
  }
  convertedUrl = URL.createObjectURL(convertedBlob);

  if (progressSection) progressSection.classList.add('hidden');
  if (resultSection) resultSection.classList.remove('hidden');

  if (resSizeBefore && currentFile) {
    resSizeBefore.textContent = formatBytes(currentFile.size);
  }
  if (resSizeAfter && currentFile) {
    const pct = currentFile.size > 0 ? Math.round((1 - convertedBlob.size / currentFile.size) * 100) : 0;
    resSizeAfter.textContent = `${formatBytes(convertedBlob.size)} (${pct}% 削減)`;
  }
  if (resMetaInfo) {
    resMetaInfo.textContent = `📄 ${finalFileName} ｜ 📅 ${formatDateJP(targetDateMs)}`;
  }

  if (resultVideo) resultVideo.classList.add('hidden');
  if (resultImage) resultImage.classList.add('hidden');
  if (resultAudio) resultAudio.classList.add('hidden');

  if (ext === 'gif' && resultImage) {
    resultImage.src = convertedUrl;
    resultImage.classList.remove('hidden');
  } else if (ext === 'wav' && resultAudio) {
    resultAudio.src = convertedUrl;
    resultAudio.classList.remove('hidden');
  } else if (resultVideo) {
    // 自動フルデコードによるメモリスパイクを防ぐため preload="none" にする
    resultVideo.preload = 'none';
    resultVideo.src = convertedUrl;
    resultVideo.classList.remove('hidden');
  }

  if (downloadBtn) {
    downloadBtn.href = convertedUrl;
    downloadBtn.download = finalFileName;
  }

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

if (shareBtn) {
  shareBtn.addEventListener('click', async () => {
    if (!convertedFile) return;

    if (navigator.canShare && navigator.canShare({ files: [convertedFile] })) {
      try {
        await navigator.share({
          files: [convertedFile]
        });
      } catch (err) {
        if (err.name !== 'AbortError') console.error('Share failed:', err);
      }
    } else if (downloadBtn) {
      downloadBtn.click();
    }
  });
}

if (resetBtn) {
  resetBtn.addEventListener('click', () => {
    document.title = 'Video Converter - ビデオコンバーター';
    if (resultVideo) {
      try {
        resultVideo.pause();
        resultVideo.removeAttribute('src');
        resultVideo.load();
      } catch (e) {}
    }
    if (resultSection) resultSection.classList.add('hidden');
    if (selectSection) selectSection.classList.remove('hidden');
    if (videoInput) videoInput.value = '';
    currentFile = null;
  });
}
