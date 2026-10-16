const S = 4;
const PHOTO_BLEND = 0.25; // 0 = solo IA (más plástico) · 0.35 = más natural, menos nítido

const $ = id => document.getElementById(id);
const drop = $("drop"), fileInput = $("file"), go = $("go"), bar = $("bar"), cancelBtn = $("cancel");
const dlg = $("opts");
const allRadios = document.querySelectorAll("input[type=radio]");
const modeRadios = document.querySelectorAll("input[name=mode]");

const getOpt = name => document.querySelector(`input[name=${name}]:checked`).value;
const getMode = () => getOpt("mode");

const useHeavy = (cfg, mode) => mode === "photo" && !!cfg && cfg.gpu && !isMobile;

const padFor = (mode, heavy) =>
  mode === "photo" ? (heavy ? 20 : (isMobile ? 10 : 24)) : 24;

const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 820);

let srcImg = null, srcName = "imagen", srcType = "image/png", lastFormat = "png", currentUrl = null;
let worker = null, readyPromise = null, readyMode = null, info = null, cancelled = false, running = false, loadingModel = false;
let attempts = [], attemptIdx = -1, verified = false, initToken = 0;
const errors = [];
const rejectors = new Set();

drop.onclick = () => fileInput.click();
drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer.files[0]) load(e.dataTransfer.files[0]); };
fileInput.onchange = () => fileInput.files[0] && load(fileInput.files[0]);

modeRadios.forEach(r => r.addEventListener("change", () => {
  if (srcImg && !running) initWorker().catch(() => {});
}));

function setStatus(t) { $("status").textContent = t; }

function refreshUI() {
  const busy = loadingModel || running;
  go.disabled = !srcImg || running;
  $("change").classList.toggle("hidden", !srcImg || busy);
  cancelBtn.classList.toggle("hidden", !busy);
}

function load(file) {
  if (!file.type.startsWith("image/")) return setStatus("Ese archivo no es una imagen.");
  srcName = file.name.replace(/\.[^.]+$/, "");
  srcType = file.type;
  const url = URL.createObjectURL(file);
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = url;
  const img = new Image();
  img.onload = () => {
    srcImg = img;
    drop.classList.add("hidden");
    $("preview").src = url;
    $("previewWrap").classList.remove("hidden");
    $("info").textContent = `Original: ${img.naturalWidth} × ${img.naturalHeight} px`;
    $("resultCard").classList.add("hidden");
    setStatus("");

    initWorker().catch(() => {});
    refreshUI();
  };
  img.src = url;
}

go.onclick = () => { if (srcImg && !running) dlg.showModal(); };
$("optsCancel").onclick = () => dlg.close();
// El cuadro de opciones solo se cierra con Cancelar o Listo (no al hacer clic fuera ni con Esc).
dlg.addEventListener("cancel", e => e.preventDefault());
$("optsDone").onclick = () => { dlg.close(); run(); };

function abortAll(reason) {
  for (const r of [...rejectors]) r(new Error(reason));
  rejectors.clear();
}

function killWorker() {
  if (worker) { try { worker.terminate(); } catch {} }
  worker = null; readyPromise = null; readyMode = null; info = null;
}

async function buildAttempts() {
  let gpuOk = false;
  try { gpuOk = !isMobile && !!(navigator.gpu && await navigator.gpu.requestAdapter()); } catch {}
  const list = [];
  if (gpuOk) list.push({ device: "webgpu", dtype: "fp32", label: "GPU (WebGPU)", gpu: true });
  list.push({ device: "wasm", dtype: "fp32", label: "Procesador (lento)", gpu: false });
  return list;
}

function spawn(cfg, mode) {
  const w = new Worker("worker.js?v=25", { type: "module" });
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = err => {
      if (settled) return;
      settled = true; rejectors.delete(fail);
      try { w.terminate(); } catch {}
      reject(err);
    };
    rejectors.add(fail);
    w.onerror = ev => fail(new Error(ev.message || "No se pudo iniciar el procesador de imágenes"));
    w.onmessage = e => {
      const m = e.data;
      if (m.type === "progress") {
        bar.classList.remove("hidden"); bar.value = m.progress / 100;
        setStatus("Preparando…");
      } else if (m.type === "loading") {
        setStatus("Preparando…");
      } else if (m.type === "ready") {
        if (settled) return;
        settled = true; rejectors.delete(fail);
        worker = w; info = cfg;
        setStatus("");
        bar.classList.add("hidden");
        resolve();
      } else if (m.type === "error") {
        fail(new Error(m.message));
      }
    };
    w.postMessage({
      type: "init",
      device: cfg.device,
      dtype: cfg.dtype,
      // Modelo original especializado en ilustraciones para el modo Arte.
      model: mode === "art" ? "anime" : (useHeavy(cfg, mode) ? "plus" : "lite"),
      threads: Math.min(4, navigator.hardwareConcurrency || 1)
    });
  });
}

async function initFrom(start, mode) {
  for (let i = start; i < attempts.length; i++) {
    if (cancelled) throw new Error("cancelado");
    try {
      await spawn(attempts[i], mode);
      attemptIdx = i;
      return;
    } catch (e) {
      if (cancelled || e.message === "cancelado") throw e;
      errors.push(`${attempts[i].label} [${attempts[i].dtype}] al cargar: ${e.message}`);
      console.warn("Configuración falló:", attempts[i], e);
    }
  }
  throw new Error("No se pudo cargar. " + errors.join(" | "));
}

function initWorker() {
  const mode = getMode();
  if (readyPromise && readyMode === mode) return readyPromise;
  abortAll("cancelado");
  killWorker();
  readyMode = mode;
  const token = ++initToken;
  if (!running) cancelled = false;
  loadingModel = true;
  refreshUI();
  const p = (async () => {
    errors.length = 0; verified = false; attemptIdx = -1;
    const list = await buildAttempts();
    if (token !== initToken) throw new Error("cancelado");
    attempts = list;
    await initFrom(0, mode);
  })();
  readyPromise = p;
  const settle = () => {
    if (token !== initToken) return;
    loadingModel = false;
    if (!running) bar.classList.add("hidden");
    refreshUI();
  };
  p.then(settle, settle);
  p.catch(() => { if (readyPromise === p) killWorker(); });
  return p;
}

async function nextConfig() {
  if (worker) { try { worker.terminate(); } catch {} }
  worker = null;
  if (attemptIdx + 1 >= attempts.length) return false;
  try { await initFrom(attemptIdx + 1, readyMode); return true; }
  catch (e) { if (cancelled || e.message === "cancelado") throw e; return false; }
}

function runTileOnce(data, width, height) {
  return new Promise((resolve, reject) => {
    rejectors.add(reject);
    worker.onerror = ev => { rejectors.delete(reject); reject(new Error(ev.message || "Error en el procesador de imágenes")); };
    worker.onmessage = e => {
      const m = e.data;
      if (m.type === "tile") { rejectors.delete(reject); resolve(m); }
      else if (m.type === "error") { rejectors.delete(reject); reject(new Error(m.message)); }
    };
    worker.postMessage({ type: "tile", data, width, height }, [data.buffer]);
  });
}

async function runTile(rgb, width, height) {
  while (true) {
    try {
      const res = await runTileOnce(rgb.slice(), width, height);
      verified = true;
      return res;
    } catch (e) {
      if (cancelled || e.message === "cancelado" || verified) throw e;
      const a = attempts[attemptIdx];
      errors.push(`${a ? a.label + " [" + a.dtype + "]" : "?"} al procesar: ${e.message}`);
      if (!(await nextConfig())) throw new Error(errors.join(" | "));
    }
  }
}

// Los límites dependen solo de la memoria disponible, nunca de la velocidad.
function limits() {
  const gpu = info && info.gpu;
  const heavy = useHeavy(info, getMode());
  const weak = isMobile && ((navigator.deviceMemory || 4) <= 2 || (navigator.hardwareConcurrency || 4) <= 4);
  return {
    tile: heavy ? 96 : (weak ? 96 : 128),
    maxPixels: isMobile ? (weak ? 400000 : 1100000) : 1600000,
  };
}

function toCanvas(img, maxPixels) {
  let w = img.naturalWidth, h = img.naturalHeight;
  const k = Math.min(1, Math.sqrt(maxPixels / (w * h)));
  w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  c.getContext("2d").drawImage(img, 0, 0, w, h);
  return { canvas: c, resized: k < 1 };
}

function fmtTime(s) {
  s = Math.max(1, Math.round(s));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

const NOISE = {
  none:   null,
  low:    { r: 1, sc: 14 },
  medium: { r: 2, sc: 24 },
  high:   { r: 2, sc: 38 },
  max:    { r: 3, sc: 55 },
};

async function denoise(ctx, W, H, level) {
  const cfg = NOISE[level];
  if (!cfg) return;
  const src = ctx.getImageData(0, 0, W, H);
  const s = src.data;
  const out = new Uint8ClampedArray(s.length);
  const r = cfg.r, side = 2 * r + 1, sigS = Math.max(1, r * 0.75);

  const ws = new Float32Array(side * side);
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++)
      ws[(dy + r) * side + (dx + r)] = Math.exp(-(dx * dx + dy * dy) / (2 * sigS * sigS));

  const lut = new Float32Array(256);
  for (let d = 0; d < 256; d++) lut[d] = Math.exp(-(d * d) / (2 * cfg.sc * cfg.sc));

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const r0 = s[i], g0 = s[i + 1], b0 = s[i + 2];
      let sr = 0, sg = 0, sb = 0, sw = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(H - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx++) {
          const xx = Math.min(W - 1, Math.max(0, x + dx));
          const j = (yy * W + xx) * 4;
          const d = ((Math.abs(s[j] - r0) + Math.abs(s[j + 1] - g0) + Math.abs(s[j + 2] - b0)) / 3) | 0;
          const w = ws[(dy + r) * side + dx + r] * lut[d];
          sr += s[j] * w; sg += s[j + 1] * w; sb += s[j + 2] * w; sw += w;
        }
      }
      out[i] = sr / sw; out[i + 1] = sg / sw; out[i + 2] = sb / sw; out[i + 3] = 255;
    }
    if (y % 48 === 47) await new Promise(res => setTimeout(res));
    if (cancelled) throw new Error("cancelado");
  }
  ctx.putImageData(new ImageData(out, W, H), 0, 0);
}

const MIME = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

function resolveFormat(choice) {
  if (choice !== "default") return choice;
  if (srcType === "image/jpeg") return "jpg";
  if (srcType === "image/webp") return "webp";
  return "png";
}

async function run() {
  if (!srcImg || running) return;
  cancelled = false; running = true;
  refreshUI();
  allRadios.forEach(r => { r.disabled = true; });

  const scale = +getOpt("scale");
  const mode = getMode();
  const noise = getOpt("noise");
  const format = resolveFormat(getOpt("format"));

  try {
    setStatus("Preparando…");
    await initWorker();

    const heavy = useHeavy(info, mode);
    const PAD = padFor(mode, heavy);
    const { tile: TILE, maxPixels } = limits();

    // Solo se limita por memoria, nunca por velocidad del equipo.
    const { canvas: inCanvas, resized } = toCanvas(srcImg, maxPixels);
    const W = inCanvas.width, H = inCanvas.height;

    const flat = document.createElement("canvas"); flat.width = W; flat.height = H;
    const fctx = flat.getContext("2d");
    fctx.fillStyle = "#fff"; fctx.fillRect(0, 0, W, H); fctx.drawImage(inCanvas, 0, 0);

    const alphaData = inCanvas.getContext("2d").getImageData(0, 0, W, H).data;
    let hasAlpha = false;
    for (let i = 3; i < alphaData.length; i += 4) if (alphaData[i] < 255) { hasAlpha = true; break; }

    if (noise !== "none") {
      setStatus("Preparando…");
      await denoise(fctx, W, H, noise);
    }

    const tW = srcImg.naturalWidth * scale, tH = srcImg.naturalHeight * scale;
    const keep = resized && tW * tH <= 16000000;
    const oW = keep ? tW : W * scale, oH = keep ? tH : H * scale;
    const ox = oW / W, oy = oH / H;

    const out = document.createElement("canvas"); out.width = oW; out.height = oH;
    const octx = out.getContext("2d"); octx.imageSmoothingQuality = "high";
    const tmp = document.createElement("canvas");
    const tctx = tmp.getContext("2d");

    const tilesX = Math.ceil(W / TILE), tilesY = Math.ceil(H / TILE), total = tilesX * tilesY;
    let done = 0;
    const t0 = performance.now();
    bar.classList.remove("hidden"); bar.value = 0;
    setStatus("Mejorando…");

    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        if (cancelled) throw new Error("cancelado");
        const x = tx * TILE, y = ty * TILE;
        const w = Math.min(TILE, W - x), h = Math.min(TILE, H - y);
        const x0 = Math.max(0, x - PAD), y0 = Math.max(0, y - PAD);
        const x1 = Math.min(W, x + w + PAD), y1 = Math.min(H, y + h + PAD);
        const tw = x1 - x0, th = y1 - y0;

        const rgba = fctx.getImageData(x0, y0, tw, th).data;
        const rgb = new Uint8ClampedArray(tw * th * 3);
        for (let i = 0, j = 0; i < rgba.length; i += 4) {
          rgb[j++] = rgba[i]; rgb[j++] = rgba[i + 1]; rgb[j++] = rgba[i + 2];
        }

        const res = await runTile(rgb, tw, th);

        const rw = res.width, rh = res.height, ch = res.channels;
        tmp.width = rw; tmp.height = rh;
        const img = tctx.createImageData(rw, rh);
        for (let i = 0, j = 0; i < rw * rh; i++, j += 4) {
          img.data[j] = res.data[i * ch];
          img.data[j + 1] = res.data[i * ch + 1];
          img.data[j + 2] = res.data[i * ch + 2];
          img.data[j + 3] = 255;
        }
        tctx.putImageData(img, 0, 0);

        const dx0 = Math.round(x * ox), dy0 = Math.round(y * oy);
        const dx1 = Math.round((x + w) * ox), dy1 = Math.round((y + h) * oy);
        octx.drawImage(tmp, (x - x0) * S, (y - y0) * S, w * S, h * S, dx0, dy0, dx1 - dx0, dy1 - dy0);

        done++; bar.value = done / total;
        const elapsed = (performance.now() - t0) / 1000;
        const eta = (elapsed / done) * (total - done);
        setStatus(done < total ? `Mejorando… quedan aprox. ${fmtTime(eta)}` : "Terminando…");
      }
    }

    // Modo Foto: el modelo suaviza la piel y queda "plástico".
    // Mezclar un poco de la imagen original devuelve textura natural.
    if (mode === "photo" && PHOTO_BLEND > 0) {
      octx.save();
      octx.globalAlpha = PHOTO_BLEND;
      octx.imageSmoothingQuality = "high";
      octx.drawImage(keep ? srcImg : inCanvas, 0, 0, out.width, out.height);
      octx.restore();
    }

    if (hasAlpha) {
      const am = document.createElement("canvas"); am.width = out.width; am.height = out.height;
      const actx = am.getContext("2d"); actx.imageSmoothingQuality = "high";
      actx.drawImage(inCanvas, 0, 0, am.width, am.height);
      const a = actx.getImageData(0, 0, am.width, am.height).data;
      const o = octx.getImageData(0, 0, out.width, out.height);
      for (let i = 3; i < o.data.length; i += 4) o.data[i] = a[i];
      octx.putImageData(o, 0, 0);
    }

    const rc = $("result"); rc.width = out.width; rc.height = out.height;
    rc.getContext("2d").drawImage(out, 0, 0);
    lastFormat = format;
    $("download").textContent = "Descargar " + format.toUpperCase();
    $("resInfo").textContent = `Tamaño: ${out.width} × ${out.height} px`;
    $("resultCard").classList.remove("hidden");
    setStatus("¡Listo!");
  } catch (e) {
    console.error(e);
    if (cancelled || (e && e.message === "cancelado")) {
      setStatus("Cancelado.");
    } else {
      killWorker();
      setStatus("No se pudo mejorar la imagen. Prueba con otra más pequeña, con 2x, o recarga la página.");
    }
  } finally {
    running = false;
    allRadios.forEach(r => { r.disabled = false; });
    bar.classList.add("hidden");
    refreshUI();
  }
}

function resetAll() {
  if (running || loadingModel) return;
  srcImg = null;
  if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = null; }
  fileInput.value = "";
  $("preview").removeAttribute("src");
  $("previewWrap").classList.add("hidden");
  $("resultCard").classList.add("hidden");
  const rc = $("result"); rc.width = 1; rc.height = 1;
  $("info").textContent = "";
  $("resInfo").textContent = "";
  setStatus("");
  refreshUI();
  drop.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}
$("change").onclick = resetAll;
$("again").onclick = resetAll;

cancelBtn.onclick = () => {
  cancelled = true;
  abortAll("cancelado");
  killWorker();
  if (!running) { setStatus("Cancelado."); bar.classList.add("hidden"); }
};

$("download").onclick = () => {
  const src = $("result");
  let canvas = src;
  if (lastFormat === "jpg") {
    canvas = document.createElement("canvas");
    canvas.width = src.width; canvas.height = src.height;
    const c = canvas.getContext("2d");
    c.fillStyle = "#fff"; c.fillRect(0, 0, canvas.width, canvas.height);
    c.drawImage(src, 0, 0);
  }
  canvas.toBlob(b => {
    if (!b) return setStatus("No se pudo preparar la descarga. Prueba con otro formato.");

    const real = b.type === "image/jpeg" ? "jpg" : b.type === "image/webp" ? "webp" : "png";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = `${srcName}_mejorada.${real}`;
    a.click();
  }, MIME[lastFormat], 0.95);
};
