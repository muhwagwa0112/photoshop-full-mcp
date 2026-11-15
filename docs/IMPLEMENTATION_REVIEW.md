# 구현 검사 결과

**IMPLEMENTATION REVIEW PASS**

승인된 34개 task와 고정 기준 R1–R10에 따른 변경 구현 및 반환 수정 사항을 검토했다. 남은 구현 blocker는 **0건**이다. 이번 판정의 범위는 변경 소스와 현재 환경에서 보고된 직접 검사이며, 실제 Adobe 장비·모델 qualification은 아래에 별도로 구분한다.

## 대상

- Photoshop: `photoshop-full-mcp`, 기준 커밋 `caeebb6567cd33c3984a8f82865736eaff55bfa7` 이후 작업트리 변경.
- Premiere: `premiere-pro-full-mcp`, 기준 커밋 `aa561604379cda21e1772251358b9397ec6d7bd7` 이후 작업트리 변경.
- 승인 계획: `00_README.md`부터 `06_PROVIDERS_AND_PROFILE.md`, `04_IMPLEMENTATION_BACKLOG.json`, 계약 자료 및 기존 `REVIEW_RESULT.md`.
- 최종 공유 코드 동기화는 root가 보고했다. automation 27개 파일 manifest SHA-256: `e8a004fdcc516c4bf038b264dbddfbe9f0457ea8a193e2ff7426ceae61aac128`. workers/peer/test를 포함한 공유 37개 파일 manifest SHA-256: `eba9fcad8b2f11507ea1ab53a83aeba3000ebdd0e761e1d5875183d328b9a42c`.

## 고정 기준 판정

| 기준 | 결과 | 확인 범위 |
|---|---|---|
| R1 범위·추적 | PASS | 승인된 34개 task의 구현 경로와 반환 수정 범위. 새 완료 기준은 추가하지 않았다. |
| R2 전체 호출 연결 | PASS | recipe/compiler → owner/runtime → native adapter 또는 worker → 실제 결과 receipt → 검토·출력 경로. 장비별 미지원 경로는 capability 상태로 구분한다. |
| R3 대상·스키마·단위 | PASS | 정확한 문서·레이어·클립·epoch, typed 결과, tick/frame/좌표 변환, photo 원본 SHA와 placement affine, 색상·정밀도 조건. |
| R4 내구성·복구 | PASS | durable intent/receipt, UNKNOWN 비재실행, batch 개별 항목 재개, checkpoint 재구성, 외부 수정 기준 보존, I/O 실패 후 writer 중단, 실제 본문 정리와 영구 ID tombstone. |
| R5 capability 정직성 | PASS | native API·qualified profile·로컬 의존성 유무에 따른 사용 가능 상태. 관측할 수 없는 native 자막·문단·parameter 상태를 성공으로 대체하지 않는다. |
| R6 근거·수정 예산 | PASS | 실제 assertion/evidence projection, 초기 role/subject/color 판단의 근거 요구, disabled review의 필수 assertion, controller deadline·현재 revision·예산 authority와 실제 image pixel 집계. |
| R7 출력·revision | PASS | 실제 published output 확인, 필수 납품 누락 시 실패, 변경 revision의 native materialization과 저장된 prefix 사용, 관측된 출력 metadata. |
| R8 호환·마이그레이션 | PASS | 기존 public 경로 연결, Photoshop 인증된 discovery/execution generation, 구 bridge가 활성 상태이면 migration 중단, Premiere legacy batch의 owner 연결. |
| R9 집중 검증 | PASS | 변경 지점의 L1 및 직접 case 결과를 사용했다. 통과 범위에 새 검사 기준이나 전체 검사를 추가하지 않았다. |
| R10 실제 부작용 | PASS | 실제 native/worker 동작과 readback, 실패·취소·부분 적용·UNKNOWN 구분. 요청 인자나 임의 파일을 실행 증거로 취급하던 반환 사항을 수정했다. |

## 반환 blocker 종결

- **Photoshop text·migration:** 실제 rendered line count/overset/frame 관측을 사용하는 paragraph fit 경로, point 전용 capability, 인증된 generation 및 legacy executor 차단을 확인했다.
- **Premiere 기존 도구:** native 자막 미관측의 정직한 오류, 정확한 inactive-project epoch, audio UNKNOWN 전파, durable per-item effect batch 및 명시적 안전 재개를 확인했다.
- **내구성·외부 수정:** PS/PR/common의 bounded terminal body와 tombstone, pending/UNKNOWN 보존, 공통 I/O poison, receipt fsync 뒤 native baseline 갱신과 재시작 gap 복구를 확인했다. `image.geometry`의 operation owner 연결 누락도 수정 후 닫았다.
- **Premiere 마지막 R4 수정:** `semantic-ops.cjs`의 실제 component/parameter/start value/key tick·value·temporal mode baseline, immutable handle 발급과 dispatch 비교를 확인했다. 관측 불가 parameter를 덮는 set/reset/remove는 차단하며, adapter는 검증된 자체 변경 결과의 새 handle만 연속 parameter 변경에 사용한다.
- **이미지·사진:** capture source-state의 worker→native apply 연결, 원본 photo SHA/affine와 ROI 경계 변환, clone 크기·정렬 조건, `preserve_input`의 실제 ICC/depth 및 local restore 정밀도 제한을 확인했다.
- **판정·controller:** 실제 assertion/evidence와 출력에 기반한 완료 판정, role/subject/color의 uncertain 거절, child verification·부분 적용 보존, 늦은 응답 거절과 client usage authority 고정을 확인했다.
- **계약·worker:** 정규화 rect/rate/curve 조건, B-roll import 중복 제거, multicam fallback 권한과 `hold_previous`, 실제 audio stream origin을 반영한 sync, image verifier의 의존성 상태를 확인했다.

## 검증 근거

검사역은 변경 소스 및 반환 직접 case의 내용을 검토했으며, 이미 통과한 명령을 다시 실행하지 않았다. 다음 실행 결과는 root와 구현 담당자의 보고다. 수정 후 재실행된 같은 case를 합산하지 않는다.

| 범위 | 보고된 결과 |
|---|---|
| Photoshop text fit | `node --import tsx --test --test-reporter=spec tests/photoshop-text-fit.test.ts` — 대상 2/2 PASS. |
| Photoshop migration·retention·raster state | `node --import tsx --test --test-concurrency=1 --test-name-pattern='legacy migration|terminal receipt retention|raster source-state' --test-reporter=spec tests/photoshop-runtime.test.ts` — 대상 3/3 PASS. |
| Photoshop native state·placement | canonical receipt/publication 직접 2 case와 actual placement 직접 1 case PASS. 관련 TS/UXP L1 PASS. |
| Premiere 반환 수정 | `tests/premiere-review-fixes.test.ts`의 해당 6 case, ducking 실제 readback 해당 1 case PASS. |
| Premiere 마지막 external-edit 수정 | `./node_modules/.bin/vitest run tests/premiere-semantic.test.ts -t 'guards preserved editable|advances only successful own' --reporter=dot` — 대상 2 PASS, 나머지는 필터 범위 밖. `node --check uxp-plugin/semantic-ops.cjs` 및 adapter/test에 한정한 strict TypeScript L1 PASS. |
| 공통 실행기·보존·결과 projection | `tests/automation-runtime.test.ts` 5/5 PASS, `tests/automation-durability.test.ts` 4 case PASS, `tests/automation-review-projections.test.ts` 최종 8 case PASS. geometry 보존 수정 후에는 영향받는 기존 retention case만 재실행하여 PASS. |
| 로컬 worker·최종 타입 연결 | 실제 FFmpeg/ffprobe/Pillow 기반 변경 case, MOV/DF timecode 및 지연 audio origin case PASS. 두 저장소의 변경 entrypoint와 관련 test에 한정한 strict TypeScript L1 PASS. |

## 미실행·제약

- **Live/device qualification 미실행:** Photoshop/Premiere 실제 호스트, Windows 실행·설치, 실제 qualified Action JSON/profile fixture와 SAM2·faster-whisper 등 미설치 모델의 실기 실행은 확인하지 않았다. 해당 capability는 실제 환경과 등록된 qualification 자료가 갖춰져야 사용 가능하다.
- Photoshop runtime의 Unix socket listen 직접 case 하나는 현재 환경의 `EPERM`으로 차단됐다. 같은 환경에서 재시도하거나 skip으로 성공 처리하지 않았다.
- **L4 미실행:** 전체 테스트·워크스페이스 전체 빌드·E2E·벤치마크·coverage·CI는 실행하지 않았다.
- 이 기록은 코드 구현 검사 완료를 나타낸다. 실제 Adobe 결과의 품질과 장비별 API 동작은 위 실기 qualification 범위에 남아 있다.
