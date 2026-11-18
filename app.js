lucide.createIcons();

// --- 状態管理 ---
let ffmpeg = null;
let isFFmpegLoaded = false;
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
let convertedUrl = null;

// --- DOM 要素 ---
const wasmBadge = document.getElementById('wasmBadge');
const wasmBadgeText = document.getElementById('wasmBadgeText');
const loadingBanner = document.getElementById('loadingBanner');
const bannerTitle = document.getElementById('bannerTitle');
const bannerDesc = document.getElementById('bannerDesc');

const videoInput = document.getElementById('videoInput');
const selectBtn = document.getElementById('selectBtn');
const selectSection = document.getElementById('selectSection');
const editorSection = document.getElementById('editorSection');
const progressSection = document.getElementById('progressSection');
const resultSection = document.getElementById('resultSection');

const fileMetaName = document.getElementById('fileMetaName');
const fileMetaRes = document.getElementById('fileMetaRes');
const fileMetaSize = document.getElementById('fileMetaSize');
const videoPreview = document.getElementById('videoPreview');

const cropContainer = document.getElementById('cropContainer');
const cropBox = document.getElementById('cropBox');
const cropStatusText = document.getElementById('cropStatusText');
const cropPresetBtns = document.querySelectorAll('.crop-preset-btn');

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
const reselectBtn = document.getElementById('reselectBtn');
const progressBar = document.getElementById('progressBar');
const progressPercent = document.getElementById('progressPercent');
const progressStatusText = document.getElementById('progressStatusText');

const resSizeBefore = document.getElementById('resSizeBefore');
const resSizeAfter = document.getElementById('resSizeAfter');
const resultVideo = document.getElementById('resultVideo');
const resultImage = document.getElementById('resultImage');
const resultAudio = document.getElementById('resultAudio');
const downloadBtn = document.getElementById('downloadBtn');
const shareBtn = document.getElementById('shareBtn');
const resetBtn = document.getElementById('resetBtn');

// --- ユーティリティ ---
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

// 進捗付きファイルダウンロード (WASM読込用)
async function fetchWithProgress(url, onProgress) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  
  const contentLength = response.headers.get('content-length');
  const total = contentLength ? parseInt(contentLength, 10) : 31000000; // 約31MB目安
  let loaded = 0;

  const reader = response.body.getReader();
  const chunks = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (onProgress) {
      onProgress(Math.min(100, Math.round((loaded / total) * 100)));
    }
  }

  const allChunks = new Uint8Array(loaded);
  let position = 0;
  for (const chunk of chunks) {
    allChunks.set(chunk, position);
    position += chunk.length;
  }

  return allChunks;
}

// --- FFmpeg.wasm の初期化 (進捗バー表示付き) ---
async function initFFmpeg() {
  try {
    const { FFmpeg } = FFmpegWASM;

    ffmpeg = new FFmpeg();

    ffmpeg.on('progress', ({ progress }) => {
      let percent = Math.round(progress * 100);
      if (percent > 100) percent = 100;
      if (percent < 0) percent = 0;
      progressBar.style.width = `${percent}%`;
      progressPercent.textContent = `${percent}%`;
    });

    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';

    // 1. JSファイルの取得
    wasmBadgeText.textContent = 'エンジン準備中 (JS)';
    const coreJsBytes = await fetchWithProgress(`${baseURL}/ffmpeg-core.js`, (pct) => {
      wasmBadgeText.textContent = `JS読込 (${pct}%)`;
    });
    const coreJsBlob = new Blob([coreJsBytes], { type: 'text/javascript' });
    const coreJsURL = URL.createObjectURL(coreJsBlob);

    // 2. WASMファイル(約31MB)の取得
    wasmBadgeText.textContent = 'エンジンDL中 (0%)';
    const wasmBytes = await fetchWithProgress(`${baseURL}/ffmpeg-core.wasm`, (pct) => {
      wasmBadgeText.textContent = `WASM読込 (${pct}%)`;
      bannerTitle.textContent = `変換エンジンをダウンロード中... (${pct}%)`;
    });
    const wasmBlob = new Blob([wasmBytes], { type: 'application/wasm' });
    const wasmURL = URL.createObjectURL(wasmBlob);

    // 3. ロード実行
    wasmBadgeText.textContent = '初期化中...';
    await ffmpeg.load({
      coreURL: coreJsURL,
      wasmURL: wasmURL
    });

    isFFmpegLoaded = true;
    wasmBadge.className = 'text-[11px] px-2.5 py-1 rounded-full bg-emerald-950 text-emerald-400 border border-emerald-800/80 flex items-center gap-1.5 font-medium';
    wasmBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-400"></span><span>準備完了</span>';
    
    // バナーを非表示
    loadingBanner.classList.add('hidden');
  } catch (err) {
    console.error('FFmpeg load failed:', err);
    wasmBadge.className = 'text-[11px] px-2.5 py-1 rounded-full bg-rose-950 text-rose-400 border border-rose-800/80 flex items-center gap-1.5 font-medium';
    wasmBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-rose-400"></span><span>読込失敗</span>';
    bannerTitle.textContent = 'エンジンの読み込みに失敗しました';
    bannerDesc.textContent = '電波の良い環境でページを再読み込みしてください。(エラー: ' + (err.message || '通信タイムアウト') + ')';
  }
}

// 起動時にロード開始
initFFmpeg();

// --- iPhoneでの動画選択を確実に発火させる ---
selectBtn.addEventListener('click', () => {
  videoInput.click();
});

videoInput.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  currentFile = file;
  fileMetaName.textContent = file.name || 'video';
  fileMetaSize.textContent = formatBytes(file.size);

  const fileUrl = URL.createObjectURL(file);
  videoPreview.muted = true; // iOS Safariで自動再生/メタデータ読込に必須
  videoPreview.playsInline = true;
  videoPreview.src = fileUrl;

  // メタデータロード待ち
  const onMetaLoaded = () => {
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
  // 万が一イベントが来ない場合のフォールバック
  setTimeout(() => {
    if (editorSection.classList.contains('hidden')) {
      onMetaLoaded();
    }
  }, 1000);
});

reselectBtn.addEventListener('click', () => {
  videoInput.value = '';
  editorSection.classList.add('hidden');
  resultSection.classList.add('hidden');
  selectSection.classList.remove('hidden');
});

// --- トリミング設定 ---
function updateTrimLabels() {
  trimStartVal.textContent = formatTime(trimSettings.start);
  trimEndVal.textContent = formatTime(trimSettings.end);
  durationRangeText.textContent = `${formatTime(trimSettings.start)} - ${formatTime(trimSettings.end)} (${(trimSettings.end - trimSettings.start).toFixed(1)}s)`;
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
function getDisplayedVideoRect() {
  const containerRect = videoPreview.getBoundingClientRect();
  const videoRatio = (originalWidth || 16) / (originalHeight || 9);
  const containerRatio = containerRect.width / (containerRect.height || 1);

  let renderWidth, renderHeight, offsetX, offsetY;

  if (videoRatio > containerRatio) {
    renderWidth = containerRect.width;
    renderHeight = containerRect.width / videoRatio;
    offsetX = 0;
    offsetY = (containerRect.height - renderHeight) / 2;
  } else {
    renderHeight = containerRect.height;
    renderWidth = containerRect.height * videoRatio;
    offsetX = (containerRect.width - renderWidth) / 2;
    offsetY = 0;
  }

  return {
    left: offsetX,
    top: offsetY,
    width: renderWidth,
    height: renderHeight,
    scaleX: originalWidth / (renderWidth || 1),
    scaleY: originalHeight / (renderHeight || 1)
  };
}

function updateCropBoxUI(pxX, pxY, pxW, pxH) {
  const vRect = getDisplayedVideoRect();
  const uiLeft = vRect.left + (pxX / vRect.scaleX);
  const uiTop = vRect.top + (pxY / vRect.scaleY);
  const uiWidth = pxW / vRect.scaleX;
  const uiHeight = pxH / vRect.scaleY;

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
    cropStatusText.textContent = 'なし (全体)';
    return;
  }

  cropSettings.enabled = true;
  cropContainer.classList.remove('hidden');

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
    targetW = Math.round(originalWidth * 0.8);
    targetH = Math.round(originalHeight * 0.8);
    targetX = Math.round((originalWidth - targetW) / 2);
    targetY = Math.round((originalHeight - targetH) / 2);
  }

  updateCropBoxUI(targetX, targetY, targetW, targetH);
}

cropPresetBtns.forEach(btn => {
  btn.addEventListener('click', () => applyCropPreset(btn.dataset.preset));
});

// クロップボックスのドラッグ移動
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let initialCropX = 0;
let initialCropY = 0;

cropBox.addEventListener('pointerdown', (e) => {
  isDragging = true;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  initialCropX = cropSettings.x;
  initialCropY = cropSettings.y;
  cropBox.setPointerCapture(e.pointerId);
});

cropBox.addEventListener('pointermove', (e) => {
  if (!isDragging) return;
  const vRect = getDisplayedVideoRect();
  const deltaX = (e.clientX - dragStartX) * vRect.scaleX;
  const deltaY = (e.clientY - dragStartY) * vRect.scaleY;

  let newX = Math.max(0, Math.min(originalWidth - cropSettings.width, initialCropX + deltaX));
  let newY = Math.max(0, Math.min(originalHeight - cropSettings.height, initialCropY + deltaY));

  updateCropBoxUI(newX, newY, cropSettings.width, cropSettings.height);
});

cropBox.addEventListener('pointerup', () => { isDragging = false; });
cropBox.addEventListener('pointercancel', () => { isDragging = false; });

// --- 出力フォーマット ---
formatBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    outputFormat = btn.dataset.format;
    formatBtns.forEach(b => {
      b.className = (b === btn)
        ? 'format-btn active bg-blue-600 text-white font-medium py-2.5 rounded-xl flex flex-col items-center gap-1 transition-all'
        : 'format-btn bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-medium py-2.5 rounded-xl flex flex-col items-center gap-1 transition-all';
    });

    if (outputFormat === 'mp3') {
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

// --- 変換実行 ---
startConvertBtn.addEventListener('click', async () => {
  if (!isFFmpegLoaded) {
    alert('変換エンジン(WASM)の読み込み中です。右上のバッジが「準備完了」になるまでお待ちください。');
    return;
  }
  if (!currentFile) return;

  editorSection.classList.add('hidden');
  progressSection.classList.remove('hidden');
  progressBar.style.width = '0%';
  progressPercent.textContent = '0%';
  progressStatusText.textContent = '動画ファイルを準備中...';

  const { fetchFile } = FFmpegUtil;
  const inputName = 'input_' + Date.now() + '.' + (currentFile.name.split('.').pop() || 'mp4');
  const outputExt = outputFormat;
  const outputName = 'output_' + Date.now() + '.' + outputExt;

  try {
    await ffmpeg.writeFile(inputName, await fetchFile(currentFile));

    progressStatusText.textContent = '変換コマンドを準備中...';

    const args = [];

    // 時間トリミング
    if (trimSettings.start > 0) {
      args.push('-ss', trimSettings.start.toString());
    }
    if (trimSettings.end < videoDuration) {
      args.push('-to', trimSettings.end.toString());
    }

    args.push('-i', inputName);

    const filters = [];

    // クロップ処理（偶数ピクセル丸め）
    if (cropSettings.enabled) {
      const cw = Math.floor(cropSettings.width / 2) * 2;
      const ch = Math.floor(cropSettings.height / 2) * 2;
      const cx = Math.floor(cropSettings.x / 2) * 2;
      const cy = Math.floor(cropSettings.y / 2) * 2;
      filters.push(`crop=${cw}:${ch}:${cx}:${cy}`);
    }

    // 解像度スケール
    if (outputResolution !== 'original' && outputFormat !== 'mp3') {
      const targetSize = parseInt(outputResolution);
      if (originalWidth >= originalHeight) {
        filters.push(`scale=-2:${targetSize}`);
      } else {
        filters.push(`scale=${targetSize}:-2`);
      }
    }

    if (outputFormat === 'mp4') {
      if (filters.length > 0) {
        args.push('-vf', filters.join(','));
      }
      let crf = '24';
      if (outputQuality === 'high') crf = '18';
      if (outputQuality === 'small') crf = '28';

      args.push(
        '-c:v', 'libx264',
        '-crf', crf,
        '-preset', 'ultrafast',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart'
      );
    } else if (outputFormat === 'gif') {
      const baseFilter = filters.length > 0 ? filters.join(',') + ',' : '';
      const gifFilter = `${baseFilter}fps=15,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`;
      args.push('-vf', gifFilter);
    } else if (outputFormat === 'mp3') {
      args.push('-vn', '-c:a', 'libmp3lame', '-q:a', '2');
    } else if (outputFormat === 'webm') {
      if (filters.length > 0) {
        args.push('-vf', filters.join(','));
      }
      args.push('-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-c:a', 'libopus');
    }

    args.push(outputName);

    progressStatusText.textContent = '変換中... (端末内で処理しています)';
    console.log('FFmpeg args:', args);

    await ffmpeg.exec(args);

    const data = await ffmpeg.readFile(outputName);
    let mimeType = 'video/mp4';
    if (outputFormat === 'gif') mimeType = 'image/gif';
    if (outputFormat === 'mp3') mimeType = 'audio/mp3';
    if (outputFormat === 'webm') mimeType = 'video/webm';

    convertedBlob = new Blob([data.buffer], { type: mimeType });
    convertedUrl = URL.createObjectURL(convertedBlob);

    progressSection.classList.add('hidden');
    resultSection.classList.remove('hidden');

    resSizeBefore.textContent = formatBytes(currentFile.size);
    resSizeAfter.textContent = `${formatBytes(convertedBlob.size)} (${Math.round((1 - convertedBlob.size / currentFile.size) * 100)}% 削減)`;

    resultVideo.classList.add('hidden');
    resultImage.classList.add('hidden');
    resultAudio.classList.add('hidden');

    if (outputFormat === 'gif') {
      resultImage.src = convertedUrl;
      resultImage.classList.remove('hidden');
    } else if (outputFormat === 'mp3') {
      resultAudio.src = convertedUrl;
      resultAudio.classList.remove('hidden');
    } else {
      resultVideo.src = convertedUrl;
      resultVideo.classList.remove('hidden');
    }

    downloadBtn.href = convertedUrl;
    downloadBtn.download = `converted_${Date.now()}.${outputFormat}`;

    await ffmpeg.deleteFile(inputName);
    await ffmpeg.deleteFile(outputName);

    lucide.createIcons();
  } catch (err) {
    console.error('Conversion failed:', err);
    alert('変換処理中にエラーが発生しました。\n動画の長さや形式、端末の空きメモリをご確認ください。');
    progressSection.classList.add('hidden');
    editorSection.classList.remove('hidden');
  }
});

shareBtn.addEventListener('click', async () => {
  if (!convertedBlob) return;
  const fileName = `converted_${Date.now()}.${outputFormat}`;
  const file = new File([convertedBlob], fileName, { type: convertedBlob.type });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: '変換済み動画',
        text: 'ビデオコンバーターで変換した動画です'
      });
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('Share failed:', err);
      }
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
