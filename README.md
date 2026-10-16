# 글로벌 다큐멘터리 레퍼런스 뷰어

다큐멘터리 제작 PD가 해외·국내 주요 다큐 채널의 최신 YouTube 콘텐츠 흐름을 한눈에 리서치하기 위한 뷰어입니다.

**▶ 바로 사용하기: https://rapidleee-bit.github.io/global-docu-viewer/**

## 주요 기능

| 항목 | 내용 |
|---|---|
| 채널 탭 | 전체 · BBC · BBC Earth · NOVA PBS · Nature PBS · KBS · MBC · EBS |
| 콘텐츠 유형 | 동영상 / 쇼츠 (YouTube 채널의 업로드 목록 기준으로 정확히 구분) |
| 정렬 | 최신순 / 조회수순 (최근 7일 · 30일 · 90일 · 1년) |
| 썸네일 그리드 | 4열 × 10행 = 40개, **더보기**로 40개씩 아래에 추가 |
| 재생 | 썸네일 클릭 → 화면 안 플레이어(조회수·좋아요·댓글·설명 표시) / `YouTube ↗` → 유튜브 새 탭 |

## 연동 채널

| 탭 | YouTube 채널 |
|---|---|
| BBC | [@BBC](https://www.youtube.com/@BBC) — 다큐멘터리만 자동 선별, [@bbcdeepwatch](https://www.youtube.com/@bbcdeepwatch) — BBC 청년층 다큐 채널(BBC Three 계열) |
| BBC Earth | [@bbcearth](https://www.youtube.com/@bbcearth), [@BBCEarthScience](https://www.youtube.com/@BBCEarthScience) |
| NOVA PBS | [@novapbs](https://www.youtube.com/@novapbs) |
| Nature PBS | [@naturepbs](https://www.youtube.com/@naturepbs) |
| KBS | [@KBSDocumentary](https://www.youtube.com/@KBSDocumentary) |
| MBC | [@MBCPDnote](https://www.youtube.com/@MBCPDnote), [@MBC_special](https://www.youtube.com/@MBC_special) |
| EBS | [@EBSDocumentary](https://www.youtube.com/@EBSDocumentary), [@ebs.science](https://www.youtube.com/@ebs.science) |

**BBC 다큐 선별 방식:** @BBC 채널에는 토크쇼·예능·애니메이션도 함께 올라오므로, 제목·설명·태그에 다큐 키워드(documentary, docuseries, docudrama 등)가 있고 예능·토크쇼 키워드가 없는 영상만 보여줍니다. 짧은 홍보 스팟도 포함됩니다. 설명란의 구독 안내·링크 같은 채널 공통 문구는 판별에서 제외합니다.

## 구성

정적 웹앱(HTML · CSS · JavaScript)이며 별도 서버나 빌드 과정이 없습니다. 영상 목록은 [YouTube Data API v3](https://developers.google.com/youtube/v3)로 불러오고, 재생은 YouTube 임베드 플레이어를 사용합니다.

| 파일 | 역할 |
|---|---|
| `index.html` · `style.css` | 화면 구성 |
| `app.js` | 채널 조회, 정렬·병합, 다큐 필터, 플레이어, API 키 발급 가이드 |
| `config.js` | API 키, 채널 목록, 필터 키워드 설정 |
| `server.js` · `start.bat` | 내 PC에서 실행할 때 쓰는 로컬 서버 (Node.js) |

- 동영상/쇼츠 구분: 채널별 업로드 재생목록(`UULF…` 일반 영상, `UUSH…` 쇼츠)을 사용
- 여러 채널을 묶은 탭은 채널별 결과를 정렬 기준에 맞춰 병합
- API 응답은 브라우저에 30분간 캐시해 사용량을 절약

## 설정 바꾸기 (`config.js`)

```js
CHANNELS: [
  { name: "BBC Earth", channels: ["@bbcearth", "@BBCEarthScience"] },
  {
    name: "BBC", channels: ["@BBC"],
    filter: {
      include: "documentary|documentaries|docuseries|docu-series|docudrama", // 하나라도 있어야 표시
      exclude: "graham norton|golden cobra|comedy|...",                     // 하나라도 있으면 제외
      minMinutes: 0,          // 최소 길이(분), 0 = 홍보 스팟 포함
      matchDescription: true, // 제목뿐 아니라 설명·태그에서도 키워드 검색
    },
  },
]
```

- 채널은 `@핸들` 또는 `UC…` 채널 ID로 지정합니다.
- `ALLOW_ALL_TIME_VIEWS: true`로 바꾸면 '조회수순 · 전체 기간' 옵션이 생깁니다. YouTube 검색을 사용해 요청당 100유닛을 쓰므로 기본은 꺼져 있습니다.

## 내 PC에서 실행하기

1. [Node.js](https://nodejs.org) 설치
2. `start.bat` 실행 → 브라우저에서 `http://localhost:8080` 이 열림
3. 처음 열면 나오는 **API 키 발급 가이드**를 따라 키를 만들고 입력

## API 사용량

YouTube Data API는 하루 10,000유닛까지 무료이며, 이 뷰어는 40개를 불러올 때 약 2~4유닛을 씁니다. 사용량은 한국시간 오후 4~5시경 초기화됩니다.
