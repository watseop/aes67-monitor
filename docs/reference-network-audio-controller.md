# 참고 분석: chris-ritsen/network-audio-controller

- 대상: https://github.com/chris-ritsen/network-audio-controller (Unlicense). 포크 zip(master) 스냅샷을 읽고 정리했다.
- 목적: ROADMAP M4(Dante 장비 제어)와 M2(레벨 미터·통계) 구현 시 참고.
- 주의: 아래 내용은 소스를 읽고 정리한 것이며 **맥/실장비에서 검증하지 않았다**. 구현 시 반드시 실제 Dante 장비와 패킷 캡처로 확인한다. Dante 프로토콜은 Audinate의 비공개 규격을 리버스 엔지니어링한 것이다(저장소도 "독립 상호운용 프로젝트"라고 밝힌다). 코드는 가져오지 않고 동작만 참고해 JS로 다시 구현한다.

## 1. 구조
- `packages/netaudio-core` (Rust): 패킷 인코딩·파싱 코어. 탐지, 프로토콜 상수, 미터링 디코딩, SAP/SDP, 하트비트, 구독 상태 등. C ABI로 노출.
- `packages/netaudio` (Python): CLI, 장비 모델, 서비스(`dante/services/cmc.py` 등).
- `packages/netaudio-daemon` (Rust): 탐지·인벤토리·모니터링을 유지하는 데몬 + HTTP API(SSE).
- `docs/audio-endpoint.md`: Linux 오디오 엔드포인트(PTPv1 클럭 추종 등). 우리 범위(M0~M2, M4)와는 거리가 있다.

## 2. 탐지 (mDNS)
`packages/netaudio-core/src/protocol.rs`, `discovery.rs`
- 서비스 타입: `_netaudio-arc._udp.local.`, `_netaudio-cmc._udp.local.`, `_netaudio-chan._udp.local.`, `_netaudio-dbc._udp.local.` (영상은 `_dantevideo._udp.local.`).
- ARC 서비스의 TXT 속성에 `arcp_vers`, `router_vers`, `router_info`, `mf`(제조사), `model`이 있다. CMC 서비스에는 `id`, `process`, `cmcp_vers`가 있다.
- Electron에서는 `bonjour`/`multicast-dns` 계열 라이브러리로 같은 서비스를 브라우즈하면 된다(구현 시 라이브러리 선택 필요).

## 3. 포트와 멀티캐스트
`protocol.rs`
| 용도 | 값 |
|---|---|
| ARC(제어·라우팅) | UDP 4440, 보조 4455 |
| 설정(Settings) | 8700 |
| 정보(Info) | 8702 |
| 하트비트 | 8708 |
| CMC(제어) | 8800 |
| 미터링 | 컨트롤러 8751, 멀티캐스트 8752 |
| 하트비트 멀티캐스트 | 224.0.0.233 |
| 제어·모니터링 멀티캐스트 | 224.0.0.231 |
| SAP | 239.255.255.255:9875 (`sap.rs`) |

## 4. ARC 요청
- 프로토콜 ID: 기본 `0x27FF`, 그 외 `0x2729`, `0x2801`, `0x2809`, `0x280C`, `0x280F`(장비·펌웨어에 따라 다름). CMC `0x1200`, Settings `0xFFFF`.
- 응답 헤더 10바이트. 결과 코드: 성공 `0x0001`, 오류 `0x0022`, 프론트엔드 불가 `0x0030`, 다음 페이지 있음 `0x8112`(페이지네이션).
- 확인된 opcode: 채널 수 `0x1000`, 장비 이름 설정 `0x1001`, TX 채널 정보 `0x2000`, TX 채널 이름 `0x2010`, RX 채널 `0x3000`. 구독 추가·삭제는 별도 상수(`commands`)이며 이번에 값까지는 확인하지 못했다.
- 장비 이름 최대 31자.
- 구독 상태는 RX 레코드의 상태 코드(`subscription_status.rs`)로 해석한다.

## 5. 레벨 미터 (M2 참고)
- 시작/중지: CMC 서비스가 `metering_start`/`metering_stop` 명령을 장비에 보낸다(`dante/services/cmc.py`). 호스트 MAC과 수신 포트가 필요하다. 미터링 데이터는 UDP로 수신한다.
- 값은 채널당 1바이트(`metering.rs`):
  - 상세(detailed): `0`=클리핑, `1..=253`이면 dBFS = −(값−1)/2, `254`=뮤트, `255`=프레이밍 마커.
  - 신호 유무(signal presence, 수동): `1..=252`이면 dBFS = −(값)/2, `253` 이상=뮤트 또는 바닥.
  - dBFS ≥ −60이면 "신호 있음"으로 분류.
- 수동 신호 유무는 하트비트 레코드 타입 `0x8002`(`signal_presence.rs`)로 TX/RX 레벨 벡터를 보낸다. 레코드에 시퀀스, 채널 시작 인덱스, 개수, 레벨 벡터 오프셋이 있고 4바이트 정렬 규칙이 있다.
- 우리 앱의 AES67 수신 레벨 미터는 이것과 별개로 `audio.js`에서 PCM으로 직접 계산하는 방식이다. Dante 장비 쪽 미터는 장비가 보고하는 값을 표시하는 용도로 쓴다.

## 6. 클럭·통계 (M2 참고)
- 하트비트(포트 8708 / 224.0.0.233) 레코드에서 클럭 주파수 오프셋(타입 `0x8001`, ppb 단위 int32), 연결 상태, 인터페이스 트래픽을 읽는다(`heartbeat_clock.rs`, `heartbeat_connection_health.rs`, `heartbeat_interface_traffic.rs`).
- 레코드 공통 구조: 총 길이(2), 확장 길이(+4), 페이로드 길이(+6), 시퀀스(+8). 길이 검증을 엄격히 한다(`heartbeat.rs::monitoring_payload`).
- 인터페이스 오류 카운터는 기준선(baseline)을 두고 증가분을 계산한다(`interface_statistics.py`).
- 클럭 소스·서브도메인 설정은 `clock_config.py`/`clock_configuration.rs`. 엔드포인트 문서는 PTPv1(UDP 319/320) 기반이고 PTPv2는 구현하지 않았다고 명시한다.
- PTP 상태 표시(M2)는 AES67 쪽 PTPv2와 Dante 쪽 PTPv1을 구분해서 설계해야 한다.

## 7. AES67 관련
- 장비 AES67 지원 여부·활성화 상태 읽기, 활성화/비활성화(`enable_aes67`), 탐지(`probe_aes67`), 멀티캐스트 프리픽스 설정(`set_aes67_multicast_prefix`)이 `dante/commands.py`에 있다. 상태는 `NOTIFICATION_AES67_STATUS` 알림으로 온다.
- SAP 파싱(`sap.rs`): 버전 1만 지원, IPv6 출처·암호화 패킷은 거부, `application/sdp` 페이로드를 SDP 파서(`sdp.rs`)로 넘긴다. 같은 message hash로 삭제를 구분하고, 내용 동일 여부로 Added/Refreshed/Replaced/Deleted를 판정한다. 우리 `src/lib/sdp.js`의 SAP 처리에 같은 전이 로직을 적용해 볼 만하다.

## 8. 우리 앱에 적용할 제안 (M4 항목 순서)
1. Dante 장비 탐지·목록(읽기 전용): mDNS 서비스 브라우즈 + ARC로 채널 수·이름 읽기. 가장 위험이 낮다.
2. 구독(라우팅) 추가·삭제: 장비 상태를 바꾸므로 읽기 전용 단계가 맥에서 확인된 뒤에 한다.
3. 장비 설정(이름, 샘플레이트, 레이턴시, AES67 모드): 잘못 쓰면 실서비스에 영향이 있으니 확인 대화상자를 둔다.
4. 레벨 미터·통계는 M2에서 AES67 스트림 기준으로 먼저 만들고, Dante 미터는 그 후에 추가한다.
- 구조: Dante 제어는 오디오 프로세스와 분리된 별도 자식 프로세스(UDP 소켓 담당)로 두고 IPC로 렌더러에 연결한다.

## 9. 추가 분석: 구독·미터링 패킷 (`netaudio-core/src/commands/`)
모든 정수는 big-endian. 위치는 `subscriptions.rs`, `metering.rs`, `mod.rs` 기준.

**구독 opcode**
- 레거시 추가 `0x3010`, 레거시 삭제 `0x3014`, 현대 ARC 구독 페이지 `0x3410`(`OPCODE_MODERN_ARC_SUBSCRIPTION`).
- 현대 ARC(프로토콜 ID `0x2809`, `0x280C`, `0x280F`)는 한 패킷에 최대 32개 RX 채널을 설정·해제하는 "페이지" 방식(`SUBSCRIPTION_PAGE_CAPACITY=32`). 레거시는 배치 16개.
- 페이지 페이로드: 8바이트 0 → `0x0800` → 페이지 용량(1) → 레코드 수(1) → 레코드 N개 → 0 패딩 → 문자열 테이블. 레코드 8바이트 = RX 채널 번호(2), 미디어 타입(2; 오디오 3, 영상 4), TX 채널 이름 포인터(2), TX 장비 이름 포인터(2). 포인터는 패킷 내 문자열 테이블 오프셋(문자열은 NUL 종료). 해제(Clear)는 포인터 둘 다 0.
- 문자열 테이블 시작 오프셋 = 20 + 페이지 용량 × 8. 같은 문자열은 `0x280F`에서만 포인터를 재사용(다른 프로토콜은 매번 추가).
- 같은 장비 내 구독은 TX 장비 이름 `"."`로 표현하지만 `0x2809`에서는 거부된다.
- 검증 규칙: RX 채널 번호 0 불가·중복 불가, 이름 길이 제한(31자), 채널 이름 규칙 검사.
- 즉 라우팅 구현은 (1) 장비가 쓰는 ARC 프로토콜 ID 확인 → (2) 해당 방식으로 페이지 생성 → (3) 응답 결과 코드와 RX 레코드의 구독 상태 코드로 확인 순서가 된다.

**미터링 시작(`build_metering_start`)**
- CMC(프로토콜 `0x1200`) 요청, opcode `0x3010`(구독 opcode와 같은 값이지만 CMC 프로토콜 안의 별개 명령). 본문: opcode, 0, 0, 호스트 MAC(6), 0, 4, 오프셋1, 2, 오프셋2, `0x000A`, 장비 이름(NUL, 2바이트 정렬), 1, 1, tail 오프셋, 1, **수신 UDP 포트**, 1.
- 장비는 이 요청의 목적지(호스트 IPv4 + 포트)로 미터링 프레임을 보낸다. 중지는 `metering_stop`.
- 미터링 프레임(`build_metering_frame`, 프로토콜 `0xFFFF`): 0(2), 소스 EUI-64(8), ASCII `Audinate`(8), 버전 `2`(1), TX 채널 수(1), RX 채널 수(1), TX 레벨(N), RX 레벨(M), 0(1). 레벨 값 해석은 5절. 시퀀스는 헤더의 message id에 담긴다.
- 주의: 이 코드는 장비 흉내(에뮬레이터)용 빌더 성격이 강해 수신 쪽 파서(`parse_response("metering")`, `conmon_common.rs`)와 함께 읽어야 한다. 실장비 캡처로 필드 위치를 확인할 것.

## 10. 확인하지 못한 것
- 위 패킷 레이아웃은 소스상 정의이며 실장비 캡처와 대조하지 않았다.
- 구독 응답에서 상태 코드(`subscription_status.rs`)가 각 값에 대해 의미하는 전체 표.
- 장비 설정(샘플레이트·레이턴시 등)의 opcode와 레이아웃(`commands/settings.rs`, `device.rs`).
- 문서 내용 전부의 실장비 동작.
