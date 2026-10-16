// ─────────────────────────────────────────────────────────────
//  글로벌 다큐멘터리 레퍼런스 뷰어 — 설정 파일
// ─────────────────────────────────────────────────────────────
//  1) API_KEY : YouTube Data API v3 키 (화면 우측 상단 ⚙ 설정에서 입력해도 됨)
//  2) CHANNELS: 카테고리(탭)별로 연동할 유튜브 채널 목록
//     - "@핸들" 또는 "UC로 시작하는 채널 ID" 둘 다 가능
//     - 한 카테고리에 여러 채널을 넣으면 자동으로 합쳐서 정렬됨
//     - filter: 다큐만 골라내는 조건 (없으면 전체 표시). 키워드는 "|"로 구분, 대소문자 무시
//         include    : 이 중 하나가 있어야 표시
//         exclude    : 제목·설명·태그에 이 중 하나라도 있으면 제외 (토크쇼·예능 등)
//         minMinutes : 이 길이(분) 미만은 제외 — 동영상 탭에만 적용 (0 = 길이 무관)
//         matchDescription: true면 include를 제목뿐 아니라 설명·태그에서도 찾음
//                           (구독 안내·링크 같은 채널 공통 문구 줄은 자동으로 무시)
// ─────────────────────────────────────────────────────────────

window.VIEWER_CONFIG = {
  API_KEY: "AIzaSyCx0B29aivCuVsb0aRBCVzuR6GY7CrJ1ps",

  CHANNELS: [
    {
      name: "BBC",
      channels: ["@BBC"],
      filter: {
        include: [
          // 다큐 명시
          "documentary|documentaries|docuseries|docu-series|docudrama|panorama|storyville",
          // 시사·탐사·실화 범죄 (BBC 다큐 클립은 제목에 'documentary'가 없는 경우가 많음)
          "murder|murdered|killer|killing|crime|criminal|investigat|police|officers|detective|vanish|missing|justice|death",
          "true story|real story|untold|inside the|uncover|exposed",
          // 다큐 진행자
          "stacey dooley|louis theroux|reggie yates|ashley cain",
        ].join("|"),
        exclude: [
          // 토크쇼·예능
          "graham norton|norton show|claudia winkleman|traitors|strictly|live lounge|bake off|the one show|question time",
          "have i got news|would i lie to you|mock the week|gladiators|the apprentice|dragons' den|eurovision|match of the day|gogglebox",
          // 코미디·애니메이션
          "sitcom|stand-up|sketch|skit|comedy|cunk|adult animation|animated series|cartoon|golden cobra",
          // 드라마 (범죄 키워드에 걸리기 쉬운 작품)
          "eastenders|doctor who|blue lights|night manager|good girl's guide|good girl’s guide|vigil|dci silva|waterloo road|the capture|boarders",
          "ludwig|the jetty|the tourist|wolf hall|riot women|death in paradise|bbc drama|drama trailer|agggtm",
          // 시상식·공연
          "bafta|performs|murder on the dancefloor|funniest|most searched",
          // 홍보·비하인드
          "new drama|first look|gangster granny|bloopers|cast reveal|cast of|with the cast|stars play|recap|opening scenes|suranne jones|series 1 –|series 2 –|series 3",
        ].join("|"),
        minMinutes: 0,
        matchDescription: true,
      },
    },
    { name: "BBC Earth",  channels: ["@bbcearth", "@BBCEarthScience"] },
    { name: "NOVA PBS",   channels: ["@novapbs"] },
    { name: "Nature PBS", channels: ["@naturepbs"] },
    { name: "KBS",        channels: ["@KBSDocumentary"] },
    { name: "MBC",        channels: ["@MBCPDnote", "@MBC_special"] },
    { name: "EBS",        channels: ["@EBSDocumentary", "@ebs.science"] },
  ],

  // '조회수순 · 전체 기간' 옵션 (YouTube 검색 사용, 채널당 요청 1회에 100 유닛 소모)
  // 공개 배포 시 하루 무료 사용량이 빨리 바닥나므로 기본은 꺼둠
  ALLOW_ALL_TIME_VIEWS: false,

  PAGE_SIZE: 40,          // 한 번에 보여줄 개수 (4열 × 10행)
  CACHE_MINUTES: 30,      // API 응답 캐시 시간 (쿼터 절약)
};
