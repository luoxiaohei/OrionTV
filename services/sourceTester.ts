/**
 * 源测速：HEAD/TTFB 估 ping，首段部分下载估速度，m3u8 主播放列表解析分辨率。
 * 思路移植自 decotv 的 preferBestSource，但不依赖 hls.js（RN 没 DOM）。
 *
 * 单次测速一条 URL，并行多源由调用方控制（建议批 4-6 路）。
 */
import Logger from "@/utils/Logger";

const logger = Logger.withTag("SourceTester");

export interface SourceMetric {
  url: string;
  resolution: string | null; // 如 "1080p"
  height: number | null;     // 用于打分
  speedKBps: number | null;
  pingMs: number | null;
  durationMs: number;        // 测速总耗时
  error?: string;
}

interface CacheEntry {
  metric: SourceMetric;
  timestamp: number;
}

const cache: { [url: string]: CacheEntry } = {};
const CACHE_DURATION_MS = 10 * 60 * 1000; // 10 分钟
const M3U8_FETCH_TIMEOUT_MS = 3000;
const TS_DOWNLOAD_TIMEOUT_MS = 3500;
const TS_BYTES_TARGET = 256 * 1024; // 测速取首段前 ~256KB

function clearStaleCache() {
  const now = Date.now();
  for (const k of Object.keys(cache)) {
    if (now - cache[k].timestamp > CACHE_DURATION_MS) delete cache[k];
  }
}

function resolveUrl(baseUrl: string, relative: string): string {
  if (/^https?:\/\//i.test(relative)) return relative;
  if (relative.startsWith("//")) {
    const proto = baseUrl.startsWith("https") ? "https:" : "http:";
    return proto + relative;
  }
  try {
    return new URL(relative, baseUrl).href;
  } catch {
    return relative;
  }
}

interface ParsedM3U8 {
  isMaster: boolean;
  height: number | null;
  resolution: string | null;
  firstSegmentUrl: string | null;
  variantUrl: string | null; // 主播放列表里第一个变体 URL
}

function parseM3U8(text: string): ParsedM3U8 {
  const lines = text.split("\n").map((l) => l.trim());
  const isMaster = text.includes("#EXT-X-STREAM-INF");

  let height: number | null = null;
  let resolution: string | null = null;
  let firstSegmentUrl: string | null = null;
  let variantUrl: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("#EXT-X-STREAM-INF")) {
      const m = line.match(/RESOLUTION=(\d+)x(\d+)/);
      if (m) {
        const h = parseInt(m[2], 10);
        if (h > (height ?? 0)) {
          height = h;
          resolution = `${h}p`;
        }
      }
      // 下一行一般是变体 URL
      if (variantUrl === null) {
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j];
          if (next && !next.startsWith("#")) {
            variantUrl = next;
            break;
          }
        }
      }
      continue;
    }

    // 变体 m3u8（无 STREAM-INF），找第一个 ts/segment
    if (!isMaster && firstSegmentUrl === null) {
      if (line && !line.startsWith("#")) {
        firstSegmentUrl = line;
      }
    }
  }

  return { isMaster, height, resolution, firstSegmentUrl, variantUrl };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onParentAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onParentAbort);
  }
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onParentAbort);
  }
}

async function measureSegmentSpeed(
  segUrl: string,
  signal?: AbortSignal,
): Promise<number | null> {
  const start = Date.now();
  let bytes = 0;
  try {
    const resp = await fetchWithTimeout(
      segUrl,
      { method: "GET" },
      TS_DOWNLOAD_TIMEOUT_MS,
      signal,
    );
    if (!resp.ok || !resp.body) return null;

    // RN 的 fetch 没有标准 Reader API；fallback 到一次性读 + 配合外层超时控制
    // expo / RN-Tvos 提供 Response.body.getReader（需要新版本）。
    const reader = (resp.body as any).getReader?.();
    if (reader && typeof reader.read === "function") {
      // 流式读取，达到目标字节数即停
      while (bytes < TS_BYTES_TARGET) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) bytes += value.byteLength || value.length || 0;
      }
      try { reader.cancel(); } catch { /* ignore */ }
    } else {
      // 兜底：直接 arrayBuffer。可能拉完整段，受外层超时保护。
      const buf = await resp.arrayBuffer();
      bytes = buf.byteLength;
    }

    const elapsedMs = Date.now() - start;
    if (elapsedMs <= 0 || bytes <= 0) return null;
    return bytes / 1024 / (elapsedMs / 1000);
  } catch {
    return null;
  }
}

/**
 * 测一条 URL 的"延迟 + 下载速度 + 分辨率"。带 10 分钟缓存。
 */
export async function testSource(
  url: string,
  signal?: AbortSignal,
): Promise<SourceMetric> {
  clearStaleCache();
  const cached = cache[url];
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION_MS) {
    return cached.metric;
  }

  const t0 = Date.now();
  const result: SourceMetric = {
    url,
    resolution: null,
    height: null,
    speedKBps: null,
    pingMs: null,
    durationMs: 0,
  };

  if (!/^https?:\/\//i.test(url) || !/\.m3u8(\?|#|$)/i.test(url)) {
    result.error = "not_m3u8";
    result.durationMs = Date.now() - t0;
    return result;
  }

  // 1) 拉 m3u8，TTFB 当 ping。带 3s 超时。
  let m3u8Text: string;
  let finalUrl: string;
  try {
    const fetchStart = Date.now();
    const resp = await fetchWithTimeout(
      url,
      { method: "GET" },
      M3U8_FETCH_TIMEOUT_MS,
      signal,
    );
    result.pingMs = Date.now() - fetchStart;
    if (!resp.ok) {
      result.error = `m3u8_status_${resp.status}`;
      result.durationMs = Date.now() - t0;
      return result;
    }
    m3u8Text = await resp.text();
    // 跟随 redirect 后实际拿内容的 URL
    finalUrl = (resp as any).url || url;
  } catch (e: any) {
    result.error = `m3u8_fetch_failed:${e?.message || "unknown"}`;
    result.durationMs = Date.now() - t0;
    return result;
  }

  const parsed = parseM3U8(m3u8Text);
  result.height = parsed.height;
  result.resolution = parsed.resolution;

  // 2) 主播放列表：再拉一次首个变体（用绝对 URL）继续解析
  let segmentUrl: string | null = parsed.firstSegmentUrl;
  let segmentBaseUrl = finalUrl;
  if (parsed.isMaster && parsed.variantUrl) {
    const variantAbs = resolveUrl(finalUrl, parsed.variantUrl);
    try {
      const resp = await fetchWithTimeout(
        variantAbs,
        { method: "GET" },
        M3U8_FETCH_TIMEOUT_MS,
        signal,
      );
      if (resp.ok) {
        const variantText = await resp.text();
        const sub = parseM3U8(variantText);
        if (sub.firstSegmentUrl) {
          segmentUrl = sub.firstSegmentUrl;
          segmentBaseUrl = (resp as any).url || variantAbs;
        }
        if (!result.height && sub.height) {
          result.height = sub.height;
          result.resolution = sub.resolution;
        }
      }
    } catch {
      // ignore - 用主播放列表的高度即可
    }
  }

  // 3) 测速：拿首段前 256KB
  if (segmentUrl) {
    const absoluteSeg = resolveUrl(segmentBaseUrl, segmentUrl);
    const speed = await measureSegmentSpeed(absoluteSeg, signal);
    if (speed !== null) result.speedKBps = speed;
  }

  result.durationMs = Date.now() - t0;
  cache[url] = { metric: result, timestamp: Date.now() };
  logger.info(
    `[TEST] ${url.substring(0, 80)}... → height=${result.height ?? "?"} ping=${result.pingMs ?? "?"}ms speed=${result.speedKBps?.toFixed(0) ?? "?"}KB/s (${result.durationMs}ms)`,
  );
  return result;
}

/**
 * 并发分批测一组 URL（返回顺序对应入参顺序）。
 */
export async function testSources(
  urls: string[],
  signal?: AbortSignal,
  concurrency = 4,
): Promise<SourceMetric[]> {
  const out: SourceMetric[] = new Array(urls.length);
  let i = 0;
  const workers: Promise<void>[] = [];
  const next = async () => {
    while (i < urls.length) {
      if (signal?.aborted) return;
      const idx = i++;
      out[idx] = await testSource(urls[idx], signal);
    }
  };
  for (let w = 0; w < Math.min(concurrency, urls.length); w++) workers.push(next());
  await Promise.all(workers);
  return out;
}

/**
 * 综合评分：分辨率 40% + 速度 40% + 延迟 20%。
 * 与 decotv preferBestSource 同款公式。
 */
export function scoreSource(
  metric: SourceMetric,
  groupMaxSpeedKBps: number,
  groupMinPingMs: number,
  groupMaxPingMs: number,
): number {
  if (metric.error) return -1;

  // 分辨率分（4K=100, 2K=85, 1080p=75, 720p=60, 480p=40, SD=20）
  const heightScore = (() => {
    const h = metric.height ?? 0;
    if (h >= 2160) return 100;
    if (h >= 1440) return 85;
    if (h >= 1080) return 75;
    if (h >= 720) return 60;
    if (h >= 480) return 40;
    if (h > 0) return 20;
    return 0; // 未知
  })();

  const speedScore = (() => {
    if (!metric.speedKBps || groupMaxSpeedKBps <= 0) return 30;
    const ratio = metric.speedKBps / groupMaxSpeedKBps;
    return Math.min(100, Math.max(0, ratio * 100));
  })();

  const pingScore = (() => {
    if (!metric.pingMs || metric.pingMs <= 0) return 0;
    if (groupMaxPingMs <= groupMinPingMs) return 100;
    const ratio = (metric.pingMs - groupMinPingMs) / (groupMaxPingMs - groupMinPingMs);
    return Math.max(0, Math.min(100, (1 - ratio) * 100));
  })();

  return heightScore * 0.4 + speedScore * 0.4 + pingScore * 0.2;
}

/**
 * 选出最佳源的 URL（输入 url -> metric 的映射）。
 * 全部测速失败时返回 null。
 */
export function pickBestUrl(
  metrics: { url: string; metric: SourceMetric }[],
): string | null {
  const valid = metrics.filter((m) => !m.metric.error);
  if (valid.length === 0) return null;

  const speeds = valid.map((m) => m.metric.speedKBps ?? 0).filter((s) => s > 0);
  const pings = valid.map((m) => m.metric.pingMs ?? 0).filter((p) => p > 0);

  const maxSpeed = speeds.length > 0 ? Math.max(...speeds) : 1024;
  const minPing = pings.length > 0 ? Math.min(...pings) : 50;
  const maxPing = pings.length > 0 ? Math.max(...pings) : 1000;

  let bestUrl: string | null = null;
  let bestScore = -Infinity;
  for (const { url, metric } of valid) {
    const s = scoreSource(metric, maxSpeed, minPing, maxPing);
    if (s > bestScore) {
      bestScore = s;
      bestUrl = url;
    }
  }
  return bestUrl;
}
