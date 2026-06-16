import { writeFile } from "node:fs/promises";

const headers = {
  Referer: "https://music.163.com/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
};

const strata = [
  { name: "综合热度-热歌榜", id: 3778678 },
  { name: "上升趋势-飙升榜", id: 19723756 },
  { name: "新近发行-新歌榜", id: 3779629 },
  { name: "原创音乐-原创榜", id: 2884035 },
  { name: "垂类-古典榜", id: 71384707 },
  { name: "垂类-电音榜", id: 1978921795 },
  { name: "垂类-中文说唱榜", id: 991319590 },
  { name: "新兴内容-AI歌曲榜", id: 9651277674 },
  { name: "垂类-欧美R&B榜", id: 12225155968 }
];

const tracksPerStratum = 24;
const commentsPerWindow = 80;
const temporalWindows = [0, 0.33, 0.66];
const requestDelayMs = 120;
const outputPath = new URL("./netease-stratified-sample.json", import.meta.url);

const provinceNames = [
  "北京", "天津", "河北", "山西", "内蒙古", "辽宁", "吉林", "黑龙江",
  "上海", "江苏", "浙江", "安徽", "福建", "江西", "山东", "河南",
  "湖北", "湖南", "广东", "广西", "海南", "重庆", "四川", "贵州",
  "云南", "西藏", "陕西", "甘肃", "青海", "宁夏", "新疆"
];

const provinceAliases = new Map();
for (const province of provinceNames) {
  provinceAliases.set(province, province);
  provinceAliases.set(`${province}省`, province);
  provinceAliases.set(`${province}市`, province);
  provinceAliases.set(`${province}自治区`, province);
}
provinceAliases.set("广西壮族自治区", "广西");
provinceAliases.set("宁夏回族自治区", "宁夏");
provinceAliases.set("新疆维吾尔自治区", "新疆");
provinceAliases.set("内蒙古自治区", "内蒙古");
provinceAliases.set("西藏自治区", "西藏");
provinceAliases.set("黑龙江省", "黑龙江");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeProvince(value) {
  const cleaned = String(value || "")
    .replace(/\s+/g, "")
    .replace(/中国/g, "")
    .replace(/省|市|壮族|回族|维吾尔|自治区/g, "");
  return provinceAliases.get(value) || provinceAliases.get(cleaned) || null;
}

async function fetchJson(url, retries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { headers });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = JSON.parse(text);
      if (data.code && data.code !== 200) throw new Error(`API code ${data.code}`);
      return data;
    } catch (error) {
      lastError = error;
      await sleep(500 * attempt);
    }
  }
  throw lastError;
}

function pickOffsets(total) {
  const maxOffset = Math.max(0, total - commentsPerWindow);
  const offsets = temporalWindows.map((ratio) => Math.floor(maxOffset * ratio));
  return [...new Set(offsets)].sort((a, b) => a - b);
}

async function getPlaylistTracks(stratum) {
  const url = `http://music.163.com/api/v6/playlist/detail?id=${stratum.id}`;
  const data = await fetchJson(url);
  const playlist = data.playlist || data.result || {};
  const tracks = playlist.tracks || [];
  const tracksById = new Map(tracks.map((track) => [track.id, track]));
  const trackIds = playlist.trackIds?.map((track) => track.id) || tracks.map((track) => track.id);
  return trackIds.map((id) => ({
    id,
    name: tracksById.get(id)?.name || "",
    stratum: stratum.name,
    listId: stratum.id
  })).filter((track) => track.id);
}

async function getComments(songId, offset) {
  const url = `http://music.163.com/api/v1/resource/comments/R_SO_4_${songId}?limit=${commentsPerWindow}&offset=${offset}`;
  return fetchJson(url);
}

const provinceCounts = Object.fromEntries(provinceNames.map((province) => [province, 0]));
const stratumStats = [];
const usedSongIds = new Set();
let rawComments = 0;
let matchedMainland = 0;
let excludedOrOther = 0;
let failedRequests = 0;

for (const stratum of strata) {
  const playlistTracks = await getPlaylistTracks(stratum);
  const selectedTracks = [];
  for (const track of playlistTracks) {
    if (usedSongIds.has(track.id)) continue;
    usedSongIds.add(track.id);
    selectedTracks.push(track);
    if (selectedTracks.length >= tracksPerStratum) break;
  }

  const stats = {
    name: stratum.name,
    list_id: stratum.id,
    selected_tracks: selectedTracks.length,
    requested_windows: 0,
    raw_comments: 0,
    matched_mainland: 0,
    excluded_or_other: 0
  };

  for (const track of selectedTracks) {
    let initial;
    try {
      initial = await getComments(track.id, 0);
      await sleep(requestDelayMs);
    } catch {
      failedRequests += 1;
      continue;
    }

    const total = Number(initial.total || initial.moreHot || 0);
    const offsets = pickOffsets(total || commentsPerWindow);
    const pages = new Map([[0, initial]]);

    for (const offset of offsets) {
      if (offset === 0) continue;
      try {
        pages.set(offset, await getComments(track.id, offset));
      } catch {
        failedRequests += 1;
      }
      await sleep(requestDelayMs);
    }

    for (const page of pages.values()) {
      stats.requested_windows += 1;
      const comments = Array.isArray(page.comments) ? page.comments : [];
      for (const comment of comments) {
        rawComments += 1;
        stats.raw_comments += 1;
        const location = comment?.ipLocation?.location;
        const province = normalizeProvince(location);
        if (province && provinceCounts[province] !== undefined) {
          provinceCounts[province] += 1;
          matchedMainland += 1;
          stats.matched_mainland += 1;
        } else {
          excludedOrOther += 1;
          stats.excluded_or_other += 1;
        }
      }
    }
  }

  stratumStats.push(stats);
  console.log(`${stats.name}: ${stats.matched_mainland}/${stats.raw_comments}`);
}

const result = {
  meta: {
    source_title: `网易云音乐9个公开榜单分层抽样：每榜最多${tracksPerStratum}首、每首最多${temporalWindows.length}个评论时间窗口、每窗口${commentsPerWindow}条`,
    platform: "网易云音乐",
    collected_at: new Date().toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }) + " +08:00",
    excluded_or_other: excludedOrOther,
    sampling_method: "榜单分层等额抽样；歌曲去重；单曲限额；评论分页位置按最新/中段/较早三窗口系统抽样；仅保存31省聚合计数。"
  },
  diagnostics: {
    strata: stratumStats,
    tracks_per_stratum: tracksPerStratum,
    comments_per_window: commentsPerWindow,
    temporal_windows: temporalWindows,
    unique_songs: usedSongIds.size,
    raw_comments: rawComments,
    matched_mainland: matchedMainland,
    excluded_or_other: excludedOrOther,
    failed_requests: failedRequests
  },
  commentData: provinceNames.map((province) => ({
    province,
    comment_count: provinceCounts[province]
  }))
};

await writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");
console.log(`Wrote ${outputPath.pathname}`);
