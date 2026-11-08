# AGENTS.md

AES67 네트워크 오디오를 모니터링하는 macOS 데스크톱 앱(Electron + Vue 3).
[philhartung/aes67-monitor](https://github.com/philhartung/aes67-monitor)(MIT)를 포크해서 개발한다.
프로젝트 배경, 구조, 명령어는 `CLAUDE.md`와 `docs/ROADMAP.md`를 따른다.

## 개발 환경
- Node는 `.nvmrc` 기준(22). 의존성은 `npm ci`로 설치한다.
- 린트: `npm run lint`, 포맷: `npm run format` (탭 들여쓰기).
- 오디오 출력과 멀티캐스트 수신은 클라우드 환경에서 검증할 수 없다. 맥 실기기에서 확인한 것만 "동작함"으로 적는다.

## Review guidelines
- RTP 헤더 파싱, 시퀀스 처리, 지터 버퍼(`src/lib/audio.js`)를 바꾸는 변경은 AES67 또는 RFC 3550 근거가 주석이나 PR 설명에 없으면 P1로 지적한다.
- 패킷 길이·채널 매핑·L16/L24 변환의 경계 조건(시퀀스 롤오버, 빈 패킷, 채널 수 불일치)을 확인하고, 처리 누락은 P1로 지적한다.
- Electron, Audify 같은 의존성 업그레이드가 기능 변경과 같은 PR에 섞여 있으면 P1로 지적한다.
- 의존성 변경이 있으면 `package-lock.json`이 함께 갱신되었는지 확인한다.
- PR 설명에 "맥에서 확인한 것 / 확인하지 못한 것"이 없으면 P1로 지적한다.
- 오디오 스레드나 UDP 수신 콜백 안의 블로킹 작업(동기 파일 I/O, 큰 할당 반복)은 P1로 지적한다.
- 문서의 오타는 P1이 아니라 낮은 우선순위로 취급한다.
