(() => {
  "use strict";

  const CFG = window.VIEWER_CONFIG || {};
  const PAGE = CFG.PAGE_SIZE || 40;
  const CACHE_MS = (CFG.CACHE_MINUTES ?? 30) * 60 * 1000;
  const API = "https://www.googleapis.com/youtube/v3/";
  const SHORTS_MAX_SEC = 180;      // '전체 기간' 검색 모드에서 쇼츠 판별 기준
  const SCAN_MAX_PAGES = 50;       // 기간별 조회수순: 이보다 많은 페이지가 필요하면 검색 방식으로 전환
  const PERIOD_SCAN_CAP = SCAN_MAX_PAGES * 50;
  const LS = "gdv_";
  const SITE = /^https?:/.test(location.origin) ? location.origin : "http://localhost:8080";
  const ALLOW_ALL_TIME = !!CFG.ALLOW_ALL_TIME_VIEWS;

  const $ = (s) => document.querySelector(s);
  const els = {
    tabs: $("#tabs"), grid: $("#grid"), empty: $("#empty"), status: $("#status"), chips: $("#chips"),
    more: $("#btnMore"), loader: $("#loader"), quota: $("#quota"),
    segType: $("#segType"), segSort: $("#segSort"), periodWrap: $("#periodWrap"), period: $("#period"),
    player: $("#playerModal"), settings: $("#settingsModal"), guide: $("#guideModal"), toast: $("#toast"),
  };

  const CATEGORIES = CFG.CHANNELS || [];

  const state = {
    tab: "all", type: "videos", sort: "date", period: "30",
    items: [], seen: new Set(), merger: null, token: 0, loading: false, notes: [],
  };

  // ── 저장소 유틸 ──────────────────────────────────────────
  const store = {
    get(k) { try { return localStorage.getItem(LS + k); } catch { return null; } },
    set(k, v) {
      try { localStorage.setItem(LS + k, v); }
      catch {
        purgeCache();
        try { localStorage.setItem(LS + k, v); } catch { /* 저장 불가 시 무시 */ }
      }
    },
    del(k) { try { localStorage.removeItem(LS + k); } catch { /* noop */ } },
  };

  function purgeCache(expiredOnly = false) {
    try {
      const now = Date.now();
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(LS + "c:")) continue;
        if (!expiredOnly) { localStorage.removeItem(k); continue; }
        try { if (JSON.parse(localStorage.getItem(k)).exp < now) localStorage.removeItem(k); }
        catch { localStorage.removeItem(k); }
      }
    } catch { /* noop */ }
  }

  const apiKey = () => store.get("api_key") || CFG.API_KEY || "";

  // ── 할당량 추정 (태평양 시간 자정 리셋) ───────────────────
  const ptDate = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  function quotaUsed() {
    try {
      const q = JSON.parse(store.get("quota") || "{}");
      return q.date === ptDate() ? q.used : 0;
    } catch { return 0; }
  }
  function addQuota(n) {
    store.set("quota", JSON.stringify({ date: ptDate(), used: quotaUsed() + n }));
    renderQuota();
  }
  function renderQuota() {
    els.quota.textContent = `오늘 API 사용량 ≈ ${quotaUsed().toLocaleString()} / 10,000`;
  }

  // ── YouTube API ──────────────────────────────────────────
  const mem = new Map();

  class ApiError extends Error {
    constructor(msg, reason) { super(msg); this.reason = reason; }
  }

  async function apiGet(endpoint, params, { cost = 1, force = false, ttl = CACHE_MS } = {}) {
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ""));
    const qs = new URLSearchParams(clean).toString();
    const ck = `c:${endpoint}?${qs}`;

    if (!force) {
      const hit = mem.get(ck);
      if (hit && hit.exp > Date.now()) return hit.data;
      try {
        const raw = store.get(ck);
        if (raw) {
          const c = JSON.parse(raw);
          if (c.exp > Date.now()) { mem.set(ck, c); return c.data; }
        }
      } catch { /* 캐시 손상 무시 */ }
    }

    const key = apiKey();
    if (!key) throw new ApiError("API 키가 설정되지 않았습니다.", "noKey");

    const res = await fetch(`${API}${endpoint}?${qs}&key=${encodeURIComponent(key)}`);
    addQuota(cost);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      const err = data.error || {};
      const reason = (err.errors && err.errors[0] && err.errors[0].reason) || err.status || String(res.status);
      throw new ApiError(explainError(reason, err.message), reason);
    }
    const entry = { exp: Date.now() + ttl, data };
    mem.set(ck, entry);
    store.set(ck, JSON.stringify(entry));
    return data;
  }

  function explainError(reason, raw) {
    const map = {
      quotaExceeded: "오늘 YouTube API 할당량을 모두 사용했습니다. (태평양 시간 자정, 한국시간 오후 4~5시에 초기화)",
      dailyLimitExceeded: "오늘 YouTube API 할당량을 모두 사용했습니다.",
      keyInvalid: "API 키가 올바르지 않습니다. ⚙ 설정에서 다시 입력해 주세요.",
      accessNotConfigured: "이 API 키의 프로젝트에서 YouTube Data API v3가 사용 설정되지 않았습니다.",
      ipRefererBlocked: `API 키의 웹사이트 제한에 ${SITE}/* 이 허용되어 있는지 확인해 주세요.`,
      forbidden: "API 요청이 거부되었습니다. 키 제한 설정을 확인해 주세요.",
    };
    if (reason === "badRequest" && /API key/i.test(raw || "")) return map.keyInvalid;
    return map[reason] || `YouTube API 오류: ${raw || reason}`;
  }

  // 채널 핸들/ID → 채널 정보 (7일 캐시)
  async function resolveChannel(ref) {
    const isId = /^UC[\w-]{22}$/.test(ref);
    const params = { part: "snippet", fields: "items(id,snippet(title,customUrl,thumbnails/default/url))" };
    if (isId) params.id = ref; else params.forHandle = ref.startsWith("@") ? ref : "@" + ref;
    const data = await apiGet("channels", params, { ttl: 7 * 864e5 });
    const ch = data.items && data.items[0];
    if (!ch) throw new ApiError(`채널을 찾을 수 없음: ${ref}`, "channelNotFound");
    return {
      ref, id: ch.id, title: ch.snippet.title,
      handle: ch.snippet.customUrl || "", thumb: ch.snippet.thumbnails?.default?.url || "",
    };
  }

  function parseDuration(iso) {
    const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || "");
    if (!m) return 0;
    return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
  }

  async function fetchVideos(ids, force) {
    if (!ids.length) return [];
    const data = await apiGet("videos", {
      part: "snippet,statistics,contentDetails",
      id: ids.join(","),
      maxResults: 50,
      fields: "items(id,snippet(publishedAt,channelId,channelTitle,title,description,tags,thumbnails,liveBroadcastContent),statistics(viewCount,likeCount,commentCount),contentDetails(duration))",
    }, { force });
    const byId = new Map((data.items || []).map((v) => [v.id, v]));
    return ids.map((id) => byId.get(id)).filter(Boolean)
      .filter((v) => v.snippet.liveBroadcastContent !== "upcoming")
      .map((v) => {
        const t = v.snippet.thumbnails || {};
        return {
          id: v.id,
          title: v.snippet.title,
          desc: v.snippet.description || "",
          tags: v.snippet.tags || [],
          channelId: v.snippet.channelId,
          channelTitle: v.snippet.channelTitle,
          publishedAt: Date.parse(v.snippet.publishedAt),
          views: +(v.statistics?.viewCount || 0),
          likes: v.statistics?.likeCount != null ? +v.statistics.likeCount : null,
          comments: v.statistics?.commentCount != null ? +v.statistics.commentCount : null,
          durationSec: parseDuration(v.contentDetails?.duration),
          thumb: (t.high || t.medium || t.default || {}).url || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
        };
      });
  }

  // ── 데이터 스트림 ────────────────────────────────────────
  // 업로드 재생목록: UULF = 일반 동영상(쇼츠·라이브 제외), UUSH = 쇼츠
  const playlistFor = (channelId, type) => (type === "shorts" ? "UUSH" : "UULF") + channelId.slice(2);
  const FILTERED_SCAN_CAP = 3000;  // 키워드 필터 채널: 결과가 드물어도 무한 스캔하지 않도록

  const wordsRe = (s) => {
    const words = (s || "").split("|").map((w) => w.trim().replace(/[.*+?^${}()[\]\\]/g, "\\$&")).filter(Boolean);
    return words.length ? new RegExp(words.join("|"), "i") : null;
  };

  // filter: "a|b" 문자열 또는 { include, exclude, minMinutes, matchDescription }
  function normFilter(f) {
    if (!f) return null;
    if (typeof f === "string") return { include: f, exclude: "", minMinutes: 0, matchDescription: false };
    return { include: f.include || "", exclude: f.exclude || "", minMinutes: +f.minMinutes || 0, matchDescription: !!f.matchDescription };
  }

  // 채널 공통 문구(구독 안내·링크·해시태그 줄)는 모든 영상에 붙어 있어 판별에 쓰면 안 됨
  const BOILERPLATE = /https?:\/\/|subscribe|follow us|iplayer|instagram|tiktok|facebook|twitter|#\w/i;
  const descCore = (desc) => desc.split("\n").filter((l) => l.trim() && !BOILERPLATE.test(l)).join("\n").slice(0, 400);

  function makeMatcher(f, shorts) {
    if (!f) return null;
    const inc = wordsRe(f.include), exc = wordsRe(f.exclude);
    const minSec = shorts ? 0 : f.minMinutes * 60;
    return (v) => {
      const core = descCore(v.desc);
      const tags = (v.tags || []).join(" | ");
      const head = f.matchDescription ? [v.title, core, tags].join("\n") : v.title;
      if (inc && !inc.test(head)) return false;
      if (exc && (exc.test(v.title) || exc.test(core) || exc.test(tags))) return false;
      return v.durationSec >= minSec;
    };
  }

  function describeFilter(f, shorts, brief = false) {
    const parts = [];
    if (f.include) {
      const where = f.matchDescription ? "제목·설명·태그" : "제목";
      parts.push(brief ? `${where}에 다큐·시사 키워드 ${f.include.split("|").length}개 중 하나 포함`
        : `${where}에 '${f.include.split("|").join("', '")}' 포함`);
    }
    if (f.exclude) {
      parts.push(brief ? `예능·토크쇼 등 제외 키워드 ${f.exclude.split("|").length}개`
        : `'${f.exclude.split("|").join("', '")}' 제외`);
    }
    if (f.minMinutes && !shorts) parts.push(`${f.minMinutes}분 이상`);
    return parts.join(" · ");
  }

  class PlaylistStream {
    constructor(playlistId, { cutoff = 0, force = false, onScan, match = null } = {}) {
      Object.assign(this, { playlistId, cutoff, force, onScan, match, buf: [], done: false, pageToken: "", scanned: 0, oldest: Date.now() });
    }
    async more() {
      let res;
      try {
        res = await apiGet("playlistItems", {
          part: "contentDetails", playlistId: this.playlistId, maxResults: 50, pageToken: this.pageToken,
          fields: "nextPageToken,items(contentDetails(videoId,videoPublishedAt))",
        }, { force: this.force });
      } catch (e) {
        if (e.reason === "playlistNotFound" || e.reason === "notFound" || e.reason === "404") { this.done = true; return; }
        throw e;
      }
      const rows = (res.items || []).map((i) => i.contentDetails).filter((c) => c && c.videoId);
      let reachedCutoff = false;
      const ids = [];
      for (const c of rows) {
        const t = c.videoPublishedAt ? Date.parse(c.videoPublishedAt) : NaN;
        if (t < this.oldest) this.oldest = t;
        if (this.cutoff && t < this.cutoff) { reachedCutoff = true; continue; }
        ids.push(c.videoId);
      }
      let vids = await fetchVideos(ids, this.force);
      if (this.match) vids = vids.filter(this.match);
      vids.sort((a, b) => b.publishedAt - a.publishedAt);
      this.buf.push(...vids);
      this.scanned += rows.length;
      if (this.onScan) this.onScan(rows.length);
      this.pageToken = res.nextPageToken || "";
      if (!this.pageToken || reachedCutoff) this.done = true;
      if (this.match && this.scanned >= FILTERED_SCAN_CAP) this.done = true;
    }
  }

  // 기간별 조회수순. 업로드가 적은 채널은 기간 내 업로드를 모두 모아 정렬하고(정확·저렴),
  // 기간 내 업로드가 SCAN_MAX_PAGES 페이지를 넘을 채널(KBS·EBS 등)은 YouTube 검색(기간 지정, 조회수순)으로 전환
  class PeriodViewsStream {
    constructor(channel, type, { cutoff, force = false, onScan, match = null }) {
      Object.assign(this, { channel, type, cutoff, force, match, buf: [], done: false, capped: false, viaSearch: false });
      this.inner = new PlaylistStream(playlistFor(channel.id, type), { cutoff, force, onScan, match });
    }
    // 지금까지 스캔한 속도로 기간 전체에 필요한 페이지 수를 추정
    pagesNeeded() {
      const span = Date.now() - this.inner.oldest;
      const pages = this.inner.scanned / 50;
      return span > 0 ? ((Date.now() - this.cutoff) / span) * pages : Infinity;
    }
    async more() {
      if (this.search) return this.pullSearch();
      // 키워드 필터 채널은 검색 결과를 걸러내면 거의 남지 않으므로 항상 스캔
      const cap = this.match ? FILTERED_SCAN_CAP : PERIOD_SCAN_CAP;
      do {
        await this.inner.more();
        if (!this.match && !this.inner.done && this.pagesNeeded() > SCAN_MAX_PAGES) {
          this.viaSearch = true;
          this.search = new SearchViewsStream(this.channel.id, this.type === "shorts", {
            force: this.force, publishedAfter: new Date(this.cutoff).toISOString(),
          });
          this.buf = this.search.buf;
          return this.pullSearch();
        }
      } while (!this.inner.done && this.inner.scanned < cap);
      this.capped = !this.inner.done;
      this.buf = this.inner.buf.sort((a, b) => b.views - a.views);
      this.done = true;
    }
    async pullSearch() {
      await this.search.more();
      this.done = this.search.done;
    }
  }

  // 조회수순 검색: search.list (요청당 100 유닛)
  class SearchViewsStream {
    constructor(channelId, shorts, { force = false, filter = "", match = null, publishedAfter = "" } = {}) {
      Object.assign(this, { channelId, shorts, force, filter, match, publishedAfter, buf: [], done: false, pageToken: "" });
    }
    async more() {
      const res = await apiGet("search", {
        part: "id", channelId: this.channelId, type: "video", order: "viewCount", q: this.filter,
        publishedAfter: this.publishedAfter,
        maxResults: 50, pageToken: this.pageToken, fields: "nextPageToken,items(id/videoId)",
      }, { cost: 100, force: this.force });
      const ids = (res.items || []).map((i) => i.id && i.id.videoId).filter(Boolean);
      const vids = (await fetchVideos(ids, this.force))
        .filter((v) => !this.match || this.match(v))
        .filter((v) => v.durationSec > 0 && (this.shorts ? v.durationSec <= SHORTS_MAX_SEC : v.durationSec > SHORTS_MAX_SEC));
      this.buf.push(...vids);
      this.buf.sort((a, b) => b.views - a.views);
      this.pageToken = res.nextPageToken || "";
      if (!this.pageToken) this.done = true;
    }
  }

  // 여러 채널 스트림을 정렬 기준에 따라 병합
  class Merger {
    constructor(streams, key) { this.streams = streams; this.key = key; }
    async fill(s) { while (!s.buf.length && !s.done) await s.more(); }
    async next(n) {
      const out = [];
      while (out.length < n) {
        await Promise.all(this.streams.map((s) => this.fill(s)));
        let best = null;
        for (const s of this.streams) {
          if (s.buf.length && (!best || this.key(s.buf[0]) > this.key(best.buf[0]))) best = s;
        }
        if (!best) break;
        out.push(best.buf.shift());
      }
      return out;
    }
    get exhausted() { return this.streams.every((s) => s.done && !s.buf.length); }
  }

  // ── 포맷 ────────────────────────────────────────────────
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function fmtCount(n) {
    if (n == null) return "-";
    const trim = (x) => (x < 10 ? x.toFixed(1).replace(/\.0$/, "") : Math.floor(x).toString());
    if (n >= 1e8) return trim(n / 1e8) + "억";
    if (n >= 1e4) return trim(n / 1e4) + "만";
    if (n >= 1e3) return trim(n / 1e3) + "천";
    return String(n);
  }
  function fmtAgo(t) {
    const s = (Date.now() - t) / 1000;
    if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}분 전`;
    if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)}일 전`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400 / 7)}주 전`;
    if (s < 86400 * 365) return `${Math.floor(s / 86400 / 30)}개월 전`;
    return `${Math.floor(s / 86400 / 365)}년 전`;
  }
  function fmtDur(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const pad = (x) => String(x).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }
  const fmtDate = (t) => new Date(t).toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" });
  const watchUrl = (id) => (state.type === "shorts" ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`);

  // ── UI: 탭/컨트롤 ───────────────────────────────────────
  function renderTabs() {
    const tabs = [{ v: "all", name: "전체" }, ...CATEGORIES.map((c, i) => ({ v: String(i), name: c.name }))];
    els.tabs.innerHTML = tabs.map((t) =>
      `<button class="tab${t.v === state.tab ? " on" : ""}" data-v="${t.v}">${esc(t.name)}</button>`).join("");
  }

  function syncControls() {
    for (const [seg, val] of [[els.segType, state.type], [els.segSort, state.sort]]) {
      seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === val));
    }
    els.periodWrap.hidden = state.sort !== "views";
    els.period.value = state.period;
    els.grid.classList.toggle("shorts", state.type === "shorts");
    store.set("ui", JSON.stringify({ tab: state.tab, type: state.type, sort: state.sort, period: state.period }));
  }

  function restoreUi() {
    try {
      const ui = JSON.parse(store.get("ui") || "{}");
      if (ui.tab === "all" || CATEGORIES[+ui.tab]) state.tab = ui.tab;
      if (["videos", "shorts"].includes(ui.type)) state.type = ui.type;
      if (["date", "views"].includes(ui.sort)) state.sort = ui.sort;
      if (["7", "30", "90", "365", "1095"].includes(ui.period) || (ALLOW_ALL_TIME && ui.period === "all")) state.period = ui.period;
    } catch { /* noop */ }
  }

  const currentCats = () => (state.tab === "all" ? CATEGORIES : [CATEGORIES[+state.tab]]);

  function currentRefs() {
    return [...new Set(currentCats().flatMap((c) => c.channels || []))];
  }

  function filterForRef(ref) {
    const cat = currentCats().find((c) => (c.channels || []).includes(ref));
    return normFilter(cat && cat.filter);
  }

  function tabLabel() {
    return state.tab === "all" ? "전체 채널" : CATEGORIES[+state.tab].name;
  }

  function renderStatus(extra = "") {
    const sortTxt = state.sort === "date" ? "최신순"
      : `조회수순 (${els.period.options[els.period.selectedIndex].text})`;
    const parts = [`<b>${esc(tabLabel())}</b>`, state.type === "shorts" ? "쇼츠" : "동영상", sortTxt];
    if (state.items.length) parts.push(`${state.items.length}개 표시`);
    let html = parts.join(" · ");
    if (extra) html += ` <span class="warn">${extra}</span>`;
    for (const n of state.notes) html += `<br><span class="warn">※ ${n}</span>`;
    els.status.innerHTML = html;
  }

  function renderChips(results) {
    els.chips.innerHTML = results.map((r) => {
      if (r.status === "rejected") return `<span class="chip err" title="${esc(r.reason.message)}">⚠ ${esc(r.ref)}</span>`;
      const c = r.value;
      return `<a class="chip" href="https://www.youtube.com/channel/${c.id}" target="_blank" rel="noopener" title="${esc(c.handle || c.id)}">
        ${c.thumb ? `<img src="${esc(c.thumb)}" alt="">` : ""}${esc(c.title)}</a>`;
    }).join("");
  }

  // ── UI: 그리드 ───────────────────────────────────────────
  function cardHtml(v, idx) {
    const rank = state.sort === "views" ? `<span class="badge-rank">${idx + 1}</span>` : "";
    return `<article class="card">
      <button class="thumb" data-idx="${idx}" aria-label="${esc(v.title)} 재생">
        <img src="${esc(v.thumb)}" alt="" loading="lazy">
        ${rank}<span class="badge-dur">${fmtDur(v.durationSec)}</span>
        <span class="overlay"><span class="play-ico">▶</span></span>
      </button>
      <a class="yt-link" href="${watchUrl(v.id)}" target="_blank" rel="noopener" title="YouTube에서 보기">YouTube ↗</a>
      <div class="meta">
        <h3 class="title" data-idx="${idx}" title="${esc(v.title)}">${esc(v.title)}</h3>
        <div class="sub-line">
          <span>${esc(v.channelTitle)}</span>
          <span class="views">조회수 ${fmtCount(v.views)}회</span>
          <span>${fmtAgo(v.publishedAt)}</span>
        </div>
      </div>
    </article>`;
  }

  function skeletonHtml(n) {
    return Array.from({ length: n }, () =>
      `<div class="card skeleton"><div class="thumb"></div><div class="bar"></div><div class="bar short"></div></div>`).join("");
  }

  function showEmpty(html) { els.empty.innerHTML = html; els.empty.hidden = false; }

  function onboardingHtml() {
    return `<h3>YouTube API 키를 먼저 설정해 주세요</h3>
      <p>이 뷰어는 YouTube Data API v3로 채널 영상 목록을 불러옵니다.<br>
      Google 계정만 있으면 무료로 5~10분이면 만들 수 있습니다.</p>
      <button class="primary-btn" data-open-guide>단계별 발급 가이드 시작하기</button>`;
  }

  // ── 로드 ────────────────────────────────────────────────
  async function load({ reset = true, force = false } = {}) {
    const token = reset ? ++state.token : state.token;
    if (state.loading && !reset) return;
    state.loading = true;
    els.more.hidden = true;
    els.empty.hidden = true;

    try {
      if (reset) {
        state.items = []; state.seen = new Set(); state.notes = []; state.merger = null;
        els.grid.innerHTML = "";
        els.chips.innerHTML = "";
        if (!apiKey()) { renderStatus(); showEmpty(onboardingHtml()); return; }
        els.grid.innerHTML = skeletonHtml(PAGE);
        renderStatus("불러오는 중…");

        const refs = currentRefs();
        const results = await Promise.allSettled(refs.map(resolveChannel));
        if (token !== state.token) return;
        results.forEach((r, i) => { r.ref = refs[i]; });
        renderChips(results);
        const fatal = results.find((r) => r.status === "rejected" && r.reason.reason !== "channelNotFound");
        if (fatal) throw fatal.reason;
        const chans = [...new Map(results.filter((r) => r.status === "fulfilled").map((r) => {
          const filter = filterForRef(r.ref);
          return [r.value.id, { ...r.value, filter, match: makeMatcher(filter, state.type === "shorts") }];
        })).values()];
        if (!chans.length) throw new ApiError("연동된 채널을 찾을 수 없습니다. config.js의 채널 핸들/ID를 확인해 주세요.", "noChannels");
        for (const c of chans) {
          if (c.filter) {
            const sh = state.type === "shorts";
            state.notes.push(`<span title="${esc(describeFilter(c.filter, sh))}">${esc(c.title)} 다큐 필터: ${esc(describeFilter(c.filter, sh, true))} (전체 목록: ⚙ 설정)</span>`);
          }
        }

        let scanned = 0;
        const onScan = (n) => { scanned += n; if (token === state.token) renderStatus(`업로드 목록 스캔 중… ${scanned.toLocaleString()}개`); };
        const shorts = state.type === "shorts";
        let streams, key;
        if (state.sort === "date") {
          streams = chans.map((c) => new PlaylistStream(playlistFor(c.id, state.type), { force, match: c.match }));
          key = (v) => v.publishedAt;
        } else if (state.period === "all") {
          streams = chans.map((c) => new SearchViewsStream(c.id, shorts, { force, filter: c.filter ? c.filter.include : "", match: c.match }));
          key = (v) => v.views;
          state.notes.push(`전체 기간 조회수순은 YouTube 검색 기반이라 API 사용량이 큽니다(요청당 100). ${shorts ? "쇼츠는 3분 이하 영상으로 분류합니다." : "3분 이하 영상은 제외됩니다."}`);
        } else {
          const cutoff = Date.now() - +state.period * 864e5;
          streams = chans.map((c) => new PeriodViewsStream(c, state.type, { cutoff, force, onScan, match: c.match }));
          key = (v) => v.views;
        }
        state.merger = new Merger(streams, key);
      } else {
        els.loader.hidden = false;
      }

      const merger = state.merger;
      const batch = (await merger.next(PAGE)).filter((v) => !state.seen.has(v.id));
      if (token !== state.token) return;

      if (reset) {
        els.grid.innerHTML = "";
        const capped = merger.streams.filter((s) => s.capped).length;
        if (capped) state.notes.push(`업로드가 많은 채널은 최근 ${PERIOD_SCAN_CAP.toLocaleString()}개 영상까지만 집계했습니다.`);
        const viaSearch = merger.streams.filter((s) => s.viaSearch).map((s) => esc(s.channel.title));
        if (viaSearch.length) {
          state.notes.push(`${viaSearch.join(", ")}: 업로드가 매우 많아 YouTube 검색(기간·조회수순)으로 집계했습니다. 이 채널은 3분 이하 영상을 쇼츠로 분류합니다.`);
        }
      }
      const start = state.items.length;
      batch.forEach((v) => state.seen.add(v.id));
      state.items.push(...batch);
      els.grid.insertAdjacentHTML("beforeend", batch.map((v, i) => cardHtml(v, start + i)).join(""));

      if (!state.items.length) showEmpty(`<h3>해당 조건의 영상이 없습니다</h3><p>기간을 넓히거나 다른 채널·유형을 선택해 보세요.</p>`);
      els.more.hidden = merger.exhausted || !batch.length;
      renderStatus();
    } catch (e) {
      if (token !== state.token) return;
      console.error(e);
      if (reset) els.grid.innerHTML = "";
      renderStatus();
      if (e.reason === "noKey") showEmpty(onboardingHtml());
      else if (reset) showEmpty(`<h3>불러오지 못했습니다</h3><p>${esc(e.message)}</p>`);
      else { toast(e.message); els.more.hidden = false; }
    } finally {
      if (token === state.token) { state.loading = false; els.loader.hidden = true; }
    }
  }

  // ── 플레이어 모달 ───────────────────────────────────────
  let lastFocus = null;
  function openModal(m) { lastFocus = document.activeElement; m.hidden = false; document.body.style.overflow = "hidden"; m.querySelector(".close-x").focus(); }
  function closeModal(m) {
    m.hidden = true;
    if (m === els.player) $("#pmFrame").innerHTML = "";
    if (els.player.hidden && els.settings.hidden && els.guide.hidden) document.body.style.overflow = "";
    if (lastFocus) lastFocus.focus();
  }

  function openPlayer(v) {
    const vertical = state.type === "shorts";
    $(".player-box").classList.toggle("vertical", vertical);
    const origin = location.protocol.startsWith("http") ? `&origin=${encodeURIComponent(location.origin)}` : "";
    $("#pmFrame").innerHTML = `<iframe src="https://www.youtube.com/embed/${v.id}?autoplay=1&rel=0&playsinline=1${origin}"
      title="${esc(v.title)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen; web-share"
      referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`;
    $("#pmTitle").textContent = v.title;
    $("#pmMeta").innerHTML = [
      `<span><b>${esc(v.channelTitle)}</b></span>`,
      `<span>조회수 <b>${v.views.toLocaleString()}</b>회</span>`,
      v.likes != null ? `<span>좋아요 <b>${v.likes.toLocaleString()}</b></span>` : "",
      v.comments != null ? `<span>댓글 <b>${v.comments.toLocaleString()}</b></span>` : "",
      `<span>${fmtDate(v.publishedAt)} (${fmtAgo(v.publishedAt)})</span>`,
      `<span>길이 ${fmtDur(v.durationSec)}</span>`,
    ].join("");
    $("#pmYt").href = watchUrl(v.id);
    $("#pmCopy").onclick = async () => {
      try { await navigator.clipboard.writeText(watchUrl(v.id)); toast("링크를 복사했습니다"); }
      catch { toast(watchUrl(v.id)); }
    };
    $("#pmDesc").textContent = v.desc;
    $("#pmDesc").hidden = !v.desc;
    openModal(els.player);
  }

  // ── 설정 모달 ───────────────────────────────────────────
  function openSettings() {
    $("#apiKey").value = store.get("api_key") || CFG.API_KEY || "";
    $("#channelList").innerHTML = CATEGORIES.map((c) =>
      `<div class="row"><b>${esc(c.name)}</b><span>${(c.channels || []).map(esc).join(", ") || "(미지정)"}${c.filter ? ` — 필터: ${esc(describeFilter(normFilter(c.filter), false))}` : ""}</span></div>`).join("");
    openModal(els.settings);
  }

  // ── API 키 발급 가이드 ──────────────────────────────────
  const GC = "https://console.cloud.google.com";
  const GUIDE = [
    {
      title: "Google Cloud 프로젝트 만들기",
      link: [`${GC}/projectcreate`, "프로젝트 만들기 화면 열기"],
      steps: [
        "아래 파란 버튼을 눌러 새 탭에서 Google Cloud를 엽니다. (Google 계정으로 로그인)",
        "처음 사용하면 <b>국가 선택 · 서비스 약관 동의</b> 화면이 먼저 나옵니다. 대한민국 선택 후 동의하고 계속합니다.",
        "<b>프로젝트 이름</b>에 <code>docu-viewer</code> 를 입력합니다. (아무 이름이나 괜찮습니다)",
        "위치는 <b>조직 없음</b> 그대로 두고 <b>만들기</b>를 누릅니다.",
        "오른쪽 위 🔔 알림에 '프로젝트 만들기 완료'가 뜰 때까지 30초 정도 기다립니다.",
      ],
      tips: [
        "결제 정보나 신용카드는 입력하지 않아도 됩니다. '무료 체험판' 안내가 나오면 무시하세요.",
        "회사 계정으로 '권한이 없습니다'가 나오면 개인 Gmail 계정으로 다시 시도하세요.",
      ],
    },
    {
      title: "YouTube Data API v3 사용 설정",
      link: [`${GC}/apis/library/youtube.googleapis.com`, "YouTube Data API v3 화면 열기"],
      steps: [
        "아래 버튼으로 YouTube Data API v3 화면을 엽니다.",
        "화면 맨 위 프로젝트 선택 상자에 1단계에서 만든 프로젝트(예: docu-viewer)가 선택되어 있는지 확인합니다. 다르면 눌러서 바꿉니다.",
        "파란색 <b>사용</b>(Enable) 버튼을 누릅니다.",
        "'API/서비스 세부정보' 화면으로 바뀌면 완료입니다.",
      ],
      tips: ["<b>사용</b> 대신 <b>관리</b> 버튼이 보이면 이미 켜져 있는 것이니 다음 단계로 넘어가세요."],
    },
    {
      title: "API 키 만들기",
      link: [`${GC}/apis/credentials`, "사용자 인증 정보 화면 열기"],
      steps: [
        "아래 버튼으로 <b>사용자 인증 정보</b> 화면을 엽니다. (맨 위 프로젝트가 1단계에서 만든 것인지 다시 확인)",
        "화면 <b>맨 위 가로줄</b>의 <b>+ 사용자 인증 정보 만들기</b> → 펼쳐진 목록에서 <b>API 키</b>를 누릅니다. (OAuth 클라이언트 ID, 서비스 계정이 아님)",
        "'API 키 만들기' 입력 양식이 먼저 나오면 이름은 그대로 두고 맨 아래 <b>만들기</b>를 누릅니다.",
        "<code>AIza…</code>로 시작하는 키가 담긴 창이 뜨면 복사 아이콘으로 <b>복사</b>해 메모장 등에 잠시 붙여 둡니다.",
      ],
      tips: [
        "키 창이 안 보이면 같은 화면 가운데 <b>'API 키'</b> 목록을 확인하세요. 항목(예: API key 1)이 있다면 <b>키 표시</b>를 눌러 복사하면 됩니다.",
        "API 화면의 '사용자 인증 정보 만들기' 버튼을 누르면 '어떤 데이터에 액세스…'를 묻는 다른 마법사가 나옵니다. 그 창은 닫고 위 순서대로 들어오세요.",
      ],
    },
    {
      title: "키 사용 범위 제한하기 (권장)",
      link: [`${GC}/apis/credentials`, "사용자 인증 정보 화면 열기"],
      steps: [
        "'API 키' 목록에서 방금 만든 키(예: API key 1)의 이름을 눌러 수정 화면으로 들어갑니다.",
        "<b>애플리케이션 제한사항</b>에서 <b>웹사이트</b>를 고릅니다.",
        `<b>웹사이트 제한사항 → 추가</b>를 누르고 <code>${SITE}/*</code> 를 입력한 뒤 완료를 누릅니다. (이 뷰어를 여는 주소입니다)`,
        "<b>API 제한사항</b>에서 <b>키 제한</b>을 고르고, 목록에서 <b>YouTube Data API v3</b>만 체크합니다.",
        "맨 아래 <b>저장</b>을 누릅니다.",
      ],
      tips: [
        "키가 유출되어도 다른 사람이 내 사용량을 쓰지 못하게 막는 설정입니다. 건너뛰어도 뷰어는 작동합니다.",
        "저장 후 실제 반영까지 최대 5분 정도 걸릴 수 있습니다.",
      ],
    },
    { title: "키를 뷰어에 넣고 확인하기", test: true },
  ];
  let guideStep = 0;
  let guideVerifiedKey = "";

  function openGuide() {
    guideStep = Math.min(+(store.get("guide_step") || 0), GUIDE.length - 1);
    renderGuide();
    if (!els.settings.hidden) closeModal(els.settings);
    openModal(els.guide);
  }

  function renderGuide() {
    const g = GUIDE[guideStep];
    store.set("guide_step", String(guideStep));
    $("#gdSteps").innerHTML = GUIDE.map((_, i) =>
      `<li class="${i < guideStep ? "done" : i === guideStep ? "on" : ""}"></li>`).join("");
    let html = `<h2 id="gdTitle">${g.title}</h2><p class="gd-count">${guideStep + 1} / ${GUIDE.length} 단계</p>`;
    if (g.test) {
      html += `<ol>
          <li>앞 단계에서 복사한 키를 아래 칸에 붙여넣습니다. (Ctrl+V)</li>
          <li><b>키 확인</b>을 눌러 실제로 YouTube 데이터를 불러올 수 있는지 시험합니다.</li>
          <li>정상이면 <b>저장하고 시작하기</b>를 누릅니다.</li>
        </ol>
        <div class="gd-test">
          <input id="gdKey" type="text" placeholder="AIza로 시작하는 키" autocomplete="off" spellcheck="false" value="${esc(store.get("api_key") || "")}">
          <button class="ghost-btn" id="gdTestBtn">키 확인</button>
        </div>
        <div class="gd-result" id="gdResult"></div>
        <div class="gd-tip">키는 이 컴퓨터의 브라우저에만 저장됩니다. 나중에 ⚙ 설정에서 바꿀 수 있습니다.</div>`;
    } else {
      html += `<ol>${g.steps.map((s) => `<li>${s}</li>`).join("")}</ol>
        <a class="gd-open" href="${g.link[0]}" target="_blank" rel="noopener">${g.link[1]} ↗</a>
        ${g.tips.map((t) => `<div class="gd-tip">💡 ${t}</div>`).join("")}`;
    }
    $("#gdBody").innerHTML = html;
    $("#gdPrev").disabled = guideStep === 0;
    $("#gdNext").textContent = g.test ? "저장하고 시작하기" : "완료했어요, 다음 →";
    if (g.test) $("#gdTestBtn").addEventListener("click", () => testGuideKey());
  }

  async function testGuideKey() {
    const key = $("#gdKey").value.trim();
    const out = $("#gdResult");
    if (!key) { out.className = "gd-result err"; out.textContent = "키를 먼저 붙여넣어 주세요."; return false; }
    out.className = "gd-result"; out.textContent = "확인 중…";
    try {
      const res = await fetch(`${API}channels?part=snippet&forHandle=@bbcearth&fields=items(snippet/title)&key=${encodeURIComponent(key)}`);
      addQuota(1);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        const err = data.error || {};
        const info = (err.details || []).find((d) => d.reason);
        const reason = (info && info.reason) || (err.errors && err.errors[0] && err.errors[0].reason) || err.status || String(res.status);
        const hints = {
          API_KEY_INVALID: "키가 올바르지 않습니다. 앞뒤 공백 없이 AIza로 시작하는 전체 키를 붙여넣었는지 확인해 주세요.",
          accessNotConfigured: "2단계의 'YouTube Data API v3 사용'이 아직 반영되지 않았습니다. 사용 버튼을 눌렀는지 확인하고, 눌렀다면 1~2분 뒤 다시 확인해 주세요.",
          SERVICE_DISABLED: "2단계의 'YouTube Data API v3 사용'이 아직 반영되지 않았습니다. 1~2분 뒤 다시 확인해 주세요.",
          ipRefererBlocked: `4단계 웹사이트 제한에 걸렸습니다. 키 수정 화면의 웹사이트 제한사항에 ${SITE}/* 를 정확히 입력했는지 확인해 주세요. 방금 저장했다면 몇 분 뒤 다시 시도하세요.`,
          API_KEY_HTTP_REFERRER_BLOCKED: `4단계 웹사이트 제한에 걸렸습니다. 지금 주소(${location.origin})와 제한사항 입력값을 확인해 주세요.`,
          keyInvalid: "키가 올바르지 않습니다. 앞뒤 공백 없이 AIza로 시작하는 전체 키를 붙여넣었는지 확인해 주세요.",
        };
        const invalid = reason === "badRequest" && /API key/i.test(err.message || "");
        throw new Error(hints[reason] || (invalid ? hints.keyInvalid : explainError(reason, err.message)));
      }
      const title = data.items && data.items[0] ? data.items[0].snippet.title : "YouTube";
      out.className = "gd-result ok";
      out.textContent = `✓ 정상 작동합니다. (${title} 채널 정보를 불러왔습니다)`;
      guideVerifiedKey = key;
      return true;
    } catch (e) {
      out.className = "gd-result err";
      out.textContent = e.message === "Failed to fetch" ? "네트워크 오류입니다. 인터넷 연결을 확인해 주세요." : e.message;
      return false;
    }
  }

  async function guideNext() {
    if (!GUIDE[guideStep].test) { guideStep++; renderGuide(); return; }
    const key = $("#gdKey").value.trim();
    if (key !== guideVerifiedKey && !(await testGuideKey())) return;
    store.set("api_key", key);
    store.del("guide_step");
    closeModal(els.guide);
    toast("API 키를 저장했습니다. 영상을 불러옵니다");
    load();
  }

  let toastTimer = 0;
  function toast(msg) {
    els.toast.textContent = msg; els.toast.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2600);
  }

  // ── 이벤트 ──────────────────────────────────────────────
  els.tabs.addEventListener("click", (e) => {
    const b = e.target.closest(".tab"); if (!b || b.dataset.v === state.tab) return;
    state.tab = b.dataset.v; renderTabs(); syncControls(); load();
  });
  for (const [seg, prop] of [[els.segType, "type"], [els.segSort, "sort"]]) {
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b || b.dataset.v === state[prop]) return;
      state[prop] = b.dataset.v; syncControls(); load();
    });
  }
  els.period.addEventListener("change", () => { state.period = els.period.value; syncControls(); load(); });
  $("#btnRefresh").addEventListener("click", () => load({ force: true }));
  els.more.addEventListener("click", () => load({ reset: false }));

  els.grid.addEventListener("click", (e) => {
    const t = e.target.closest("[data-idx]"); if (!t) return;
    const v = state.items[+t.dataset.idx]; if (v) openPlayer(v);
  });

  for (const m of [els.player, els.settings, els.guide]) {
    m.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeModal(m); });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    for (const m of [els.player, els.guide, els.settings]) {
      if (!m.hidden) { closeModal(m); break; }
    }
  });

  els.empty.addEventListener("click", (e) => { if (e.target.closest("[data-open-guide]")) openGuide(); });
  $("#openGuideFromSettings").addEventListener("click", (e) => { e.preventDefault(); openGuide(); });
  $("#gdPrev").addEventListener("click", () => { if (guideStep > 0) { guideStep--; renderGuide(); } });
  $("#gdNext").addEventListener("click", guideNext);
  els.guide.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.id === "gdKey") { e.preventDefault(); testGuideKey(); }
  });

  $("#btnSettings").addEventListener("click", openSettings);
  $("#btnSaveKey").addEventListener("click", () => {
    const k = $("#apiKey").value.trim();
    if (k) store.set("api_key", k); else store.del("api_key");
    closeModal(els.settings); toast("저장했습니다"); load();
  });
  $("#btnClearCache").addEventListener("click", () => {
    purgeCache(); mem.clear(); toast("캐시를 비웠습니다");
  });

  // ── 시작 ────────────────────────────────────────────────
  purgeCache(true);
  if (!ALLOW_ALL_TIME) els.period.querySelector('option[value="all"]').remove();
  restoreUi();
  renderTabs();
  syncControls();
  renderQuota();
  if (location.protocol === "file:") {
    setTimeout(() => toast("영상 재생을 위해 start.bat(로컬 서버)으로 실행해 주세요"), 600);
  }
  load();
  if (!apiKey()) openGuide();
})();
