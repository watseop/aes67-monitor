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

## 10. 전체 검토 결과와 필요 여부
전체 저장소(코어 Rust, Python 레이어, 데몬, 웹 UI, 문서)를 3개 영역으로 나눠 읽고 판정했다. 아래 오프셋·opcode 중 `0x8020/0x8204/0x8060/0x0063`(장치 설정 info code), 하트비트 `0x8000/0x8003/0x8004`, 오프라인 임계값 15초, `0x3201`(외부 구독), `0x2601`(TX flow 생성)은 소스에서 다시 확인했다. 나머지는 읽기 담당이 정리한 것이라 구현 전에 소스와 캡처로 재확인한다.

### NEEDED (M4 / M2에 직접 필요)
- **장치 설정 읽기**: ARC `0x1100`, info code 표 — 샘플레이트 `0x8020`, 기본 지연 `0x8204`, 설정 지연 `0x8205`, 활성 지연 `0x8301`, 최대/최소 `0x8302`/`0x8306`, AES67 multicast prefix `0x8060`, AES67 configured `0x0063`(3=켜짐, 1=꺼짐). 응답은 [0]=용량 [1]=개수 뒤에 4바이트 레코드이며, 최상위 비트가 켜진 코드는 패킷 시작 기준 포인터다(`responses/device.rs`).
- **채널·장치 정보 파싱**: `0x1000` 채널 수, `0x1003` 장치 정보, RX 레코드(20바이트, 페이지당 16개), TX 레코드(8바이트, 페이지당 32개)(`parser.rs`).
- **구독 상태 코드표**: `subscription_status.rs`의 코드→라벨·설명 표(동적 연결, 자기 구독, 포맷·자원·QoS·지연·클럭 도메인 오류, 접근 제어 등). UI에 그대로 쓸 가치가 있어 이식 후보 1순위.
- **장치 모델·기능 마스크**: 요청으로 모델 조회 후 기능 비트로 게이팅(AES67 지원, 잠금, 상세 미터링, 이중화 등). 지원하지 않는 장치에 쓰기를 보내지 않기 위해 필요.
- **AES67 모드 제어**: 읽기는 `probe_aes67` 알림(`0x1007`, 비트0=현재, 비트1=설정). 현재≠설정이면 "재부팅 필요"로 표시. AES67 상태가 바뀌면 샘플레이트·인코딩을 다시 조회하는 연쇄가 필요. multicast prefix 쓰기는 ARC `0x1101`.
- **구독 변경 절차**(`subscription_operations.py`): 현재 상태 재조회 → 변경 계획 → 장치별 잠금 → 페이지 전송과 ACK 확인 → 알림 최대 2초 대기 → 0.5초 간격 최대 5초 폴링으로 일치 확인. 결과를 verified/failures/unconfirmed로 구분한다. 롤백은 없다.
- **외부 AES67 소스 구독**(`external_subscription.rs`, ARC `0x3201`, 기본 포트 4321): SAP로 본 AES67 소스를 Dante 수신기에 구독시킨다. 우리 앱의 SAP 목록과 직접 연결되는 기능.
- **생존 판정**: mDNS는 발견용이고 online/offline은 하트비트(포트 8708)로 판정한다. 오프라인 임계값 15초, 점검 주기 5초. CMC 등록을 약 10초마다 갱신한다(등록해야 알림·하트비트가 계속 온다고 보이나 코드로 확정하지 못함).
- **하트비트 통계(M2/PTP 패널 참고)**: `0x8000` 인터페이스 트래픽(엔트리 16바이트: tx·rx B/s, tx·rx 오류 누적), `0x8003` flow 지연, `0x8004` late packet, `0x8001` 클럭 오프셋(ppb). 클럭 상태 읽기는 ConMon `0x0020`(동기 상태, 소스, ppb 등).
- **SDP/SAP 처리**: `sdp.rs`의 routable 판정(audio, RTP/AVP, IPv4 `c=` 1~2개, L16/L24/L32, ptime, `mediaclk direct`, `ts-refclk` PTP 도메인)과 `sap.rs`의 Added/Refreshed/Replaced/Deleted 전이를 `src/lib/sdp.js` 개선에 참고.
- **장치 이름·채널 이름 변경**: 장치 `0x1001`, TX 채널 `0x2013`, RX 채널 `0x3001`(`0x2809`는 `0x3401`). 규칙: 최대 31자, `[A-Za-z0-9-]`, 하이픈으로 시작·끝 불가(채널 이름은 `:`·`_` 허용).
- **잠금 상태 읽기**: 쓰기 전에 장치가 잠겼는지 확인(ConMon `0x1008`/`0x1009`).
- **identify**: 장치 LED 점멸. 무해한 편의 기능.

### OPTIONAL (참고 가치는 있으나 1차 범위 밖)
- **이슈 판정 임계값**(`monitoring/issues.py`): 클럭 이상은 즉시, 복구는 정상 5초 연속. flow 지연은 설정 지연의 80%에서 경고·60%에서 복구, late packet 증가는 즉시 이슈, 인터페이스 사용률 80% 경고·60% 복구(히스테리시스). 클럭 오프셋은 최근 11~20 샘플 표준편차 10000ppb 초과 시 경고, 5초 안정 시 복구. 우리가 RTP에서 직접 계산하는 지표와는 소스가 다르다(Dante 수신기의 자체 보고). Dante 수신기 상태를 보여줄 때 채택.
- **UI 레벨 미터 로직**(`scripts/webapp/peak-meter.js`): 하강 20dB/s, peak hold 2초 후 20dB/s 하강, over 표시 2초 유지(횟수 상한 999), 영역 구분(−18 미만/−18~−6/−6 이상), 숫자 갱신 0.25초. `meter-animation.js`는 requestAnimationFrame에 프레임 간격 상한 0.1초, 화면 밖 미터는 갱신 생략. Vue 3 composable로 옮길 만하다.
- **지연 쓰기**: ARC `0x1101` + 고정 22바이트 preamble + 지연(ns, u32)을 두 번. 영구 저장 `0x1F01`. 표준 지연값 0.15/0.25/0.5/1/2/5ms.
- **샘플레이트·인코딩 쓰기**: 코드상 합성된 형식이라 실기기 검증 근거가 없다. 변경하면 유니캐스트 flow가 끊길 수 있다.
- **게인(아날로그 코덱)**, **프리셋**(Dante Controller XML 호환; 적용은 계획→실행→검증), **레벨 이력**(초 단위 900슬롯·분 단위 1440슬롯 링버퍼), **AES67 TX 멀티캐스트 flow 생성**(ARC 2809 `0x2601`, 삭제 `0x2602`, 조회 `0x2600`)은 후속 단계에서 필요할 때 검토.
- **로컬 데몬의 이벤트 모델**: "연결 직후 snapshot, 이후 필드 단위 patch, 큐 초과 시 재동기화 요구" 설계는 Electron 메인↔렌더러 IPC에 차용 가능. 고빈도 미터 데이터는 SSE보다 MessagePort가 적합하다고 판단.
- **테스트 자료**: `tests/webapp/fixtures/metering-scale.json`(raw→dBFS 표)을 미터 변환 단위 테스트의 기준표로 사용 가능. pcap 같은 패킷 캡처 파일은 없다.
- **DDM 감지**: 장치가 DDM에 enroll되어 있으면 직접 ARC 제어가 거부될 수 있다. 감지해서 "DDM 관리 중, 읽기 전용"으로 표시하는 정도만 권장.

### NOT NEEDED (이번 범위에서는 가져오지 않음)
- 장치 에뮬레이션 전용 코드: `publications.rs`, `discovery.rs`(가상 장치 광고), `device_requests.rs`, `parse_set_*_request`류.
- DDM 연동 전체(`dapi.rs`, `controller_api.rs`, `managed_*`, `ddm/*`): 계정·인증·권한 모델이 필요해 범위가 크다.
- 잠금/해제 명령: 암호화 키를 호스트가 공급해야 하는데 출처를 확인하지 못했다.
- 클럭 쓰기, 네트워크(정적 IP·이중화) 쓰기: 잘못 쓰면 네트워크 동기가 깨지거나 장치에 접속할 수 없게 된다.
- **재부팅, 공장 초기화, 설정 삭제 명령**: 구현하지 않는다.
- 이벤트 저널 영속화·작업 감사 기록, 웹 UI 코드(Preact), 데몬의 인증·TLS·SQLite·Redis·MCP, Shure·영상(Dante AV)·호스트 오디오 어댑터.
- `netaudio-endpoint`(Linux 가상 Dante 송수신 endpoint): PTPv1만 구현하고 소프트웨어 타임스탬프를 쓴다. PTPv2를 구현하지 않아 AES67 모니터링에는 쓸 수 없다. M3(Send/Return)는 시작하지 않으며, 나중에 송수신 설계 참고용으로만 기록한다(clock transport 분리, 포트 재사용 격리 대기, 지터·버퍼 설정 모델).

### 구현 시 주의
- 쓰기 명령(구독, 이름, 지연, AES67, 샘플레이트)은 오디오 경로를 즉시 바꾼다. 확인 대화상자와 읽기 전용 모드를 두고, 쓰기 전 capability·잠금·DDM 관리 여부를 점검한다.
- AES67 on/off, multicast prefix, 샘플레이트 변경은 재부팅이나 flow 단절이 따를 수 있다.
- 법적: Dante는 Audinate의 상표이고 프로토콜은 비공개 규격을 역공학한 것이다. 참고 저장소도 "독립 상호운용 프로젝트, Audinate와 무관"이라고 밝힌다. 우리 앱에도 같은 취지의 비제휴 고지를 넣는다. 참고 저장소 라이선스는 Unlicense이지만 웹 UI 아이콘은 별도 라이선스 파일이 있어 쓰지 않는다.
- 제안 구현 순서: ① 탐지·목록(읽기 전용) → ② 채널·구독 상태 표시(상태 코드표 포함) → ③ AES67 상태 표시 → ④ 구독 변경 → ⑤ 이름·AES67·지연 설정.

## 11. 확인하지 못한 것
- 모든 오프셋과 opcode는 소스상 정의이며 실장비·패킷 캡처와 대조하지 않았다. 샘플레이트 쓰기처럼 코드상 합성된 것으로 보이는 형식은 특히 그렇다.
- 읽기 요약 담당이 일부만 읽은 파일: `responses/clock.rs`, `parser/audio.rs`, `parser.rs`의 RX/TX 페이지 파서. 오프셋 상수만 본 파일: `responses/channel_status.rs`, `flows.rs`, `receiver_flow_status.rs`, `receiver_ranges.rs`, `pointer_table.rs`. 훑거나 읽지 못한 파일: `spec/*`, `flow_plan.rs`, `flow_readback.rs`, `subscription_reconciliation.rs`, `netif/*`, `client.rs`, 데몬 내부(미터링 갱신 주기, 패킷 손실 판정), `routing.js` 렌더링 상세, Playwright 스펙, `capture/`.
- 상세 미터링이 start 한 번으로 얼마나 지속되는지(갱신 로직은 Rust 데몬 쪽).
- 기능 마스크 비트가 어느 word에 속하는지.
- 웹 UI의 한국어 지원 여부, vendor 라이브러리 라이선스.
