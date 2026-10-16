const TJS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3";
const ORT_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";
const ORT_URL = ORT_BASE + "ort.webgpu.min.mjs";
const ART_MODEL = "Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr";

const PHOTO_MODELS = {
  plus: "https://huggingface.co/jonathanst29/tinier-upscale-models/resolve/main/realesrgan-x4plus.onnx",
  lite: "https://huggingface.co/jonathanst29/tinier-upscale-models/resolve/main/realesr-general-x4v3.onnx",
};

let engine = null;
let upscaler = null;
let RawImage = null;
let ort = null, session = null, inName = "", outName = "";

function errText(e) {
  const m = e && e.message !== undefined ? e.message : e;
  const s = String(m);

  return /^\d+$/.test(s) ? `error interno del motor (código ${s}; suele indicar falta de memoria o incompatibilidad)` : s;
}

const progress = p => postMessage({ type: "progress", progress: p });

async function fetchModel(url) {
  const CACHE = "ashure-models-v1";
  try {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  } catch {}
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("No se pudo descargar el archivo (" + resp.status + ")");
  const total = +resp.headers.get("content-length") || 0;
  const reader = resp.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    if (total) progress(Math.min(100, (got / total) * 100));
  }
  const buf = new Uint8Array(got); let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  try { const cache = await caches.open(CACHE); await cache.put(url, new Response(buf)); } catch {}
  return buf;
}

async function initArt(m) {
  const tjs = await import(TJS_URL);
  tjs.env.allowLocalModels = false;
  RawImage = tjs.RawImage;
  if (tjs.env.backends && tjs.env.backends.onnx && tjs.env.backends.onnx.wasm) {
    tjs.env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, m.threads || 1) : 1;
  }
  upscaler = await tjs.pipeline("image-to-image", ART_MODEL, {
    device: m.device,
    dtype: m.dtype,
    progress_callback: p => { if (p.status === "progress") progress(p.progress); },
  });
}

async function initPhoto(m) {
  ort = await import(ORT_URL);
  ort.env.wasm.wasmPaths = ORT_BASE;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, m.threads || 1) : 1;
  const bytes = await fetchModel(PHOTO_MODELS[m.model] || PHOTO_MODELS.lite);
  session = await ort.InferenceSession.create(bytes, {
    executionProviders: [m.device],
    graphOptimizationLevel: "all",
  });
  inName = session.inputNames[0];
  outName = session.outputNames[0];
}

async function inferArt(m) {
  const img = new RawImage(m.data, m.width, m.height, 3);
  let res = await upscaler(img);
  if (Array.isArray(res)) res = res[0];
  return { data: res.data, width: res.width, height: res.height, channels: res.channels };
}

async function inferPhoto(m) {
  const { width: w, height: h, data: d } = m;
  const plane = w * h;

  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    input[i] = d[i * 3] / 255;
    input[plane + i] = d[i * 3 + 1] / 255;
    input[2 * plane + i] = d[i * 3 + 2] / 255;
  }
  const tensor = new ort.Tensor("float32", input, [1, 3, h, w]);
  const out = await session.run({ [inName]: tensor });
  const t = out[outName];
  const od = t.data;
  const oh = t.dims[2], ow = t.dims[3], oplane = oh * ow;

  const rgb = new Uint8ClampedArray(oplane * 3);
  for (let i = 0; i < oplane; i++) {
    rgb[i * 3] = od[i] * 255;
    rgb[i * 3 + 1] = od[oplane + i] * 255;
    rgb[i * 3 + 2] = od[2 * oplane + i] * 255;
  }
  try { tensor.dispose && tensor.dispose(); t.dispose && t.dispose(); } catch {}
  return { data: rgb, width: ow, height: oh, channels: 3 };
}

self.onmessage = async e => {
  const m = e.data;

  if (m.type === "init") {
    try {
      postMessage({ type: "loading" });
      engine = m.mode === "photo" ? "photo" : "art";
      if (engine === "photo") await initPhoto(m); else await initArt(m);
      postMessage({ type: "ready" });
    } catch (err) {
      console.warn("Falló al cargar:", m, err);
      postMessage({ type: "error", message: errText(err) });
    }
    return;
  }

  if (m.type === "tile") {
    try {
      const r = engine === "photo" ? await inferPhoto(m) : await inferArt(m);
      postMessage({ type: "tile", ...r });
    } catch (err) {
      console.warn("Falló al procesar:", err);
      postMessage({ type: "error", message: errText(err) });
    }
  }
};
