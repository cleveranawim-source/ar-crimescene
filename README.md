# 웹 AR — 명지대학교교회 중등부 여름수련회

앱 설치 없이 브라우저만으로 동작하는 AR. 두 페이지가 있다.

| 페이지 | 하는 일 |
|---|---|
| **[logo.html](https://cleveranawim-source.github.io/ar-crimescene/logo.html)** | QR 을 비추면 **password: JESUS 로고가 입체로 떠오른다** |
| [index.html](https://cleveranawim-source.github.io/ar-crimescene/) | 증거물을 비추면 영상이 재생된다 (크라임씬용) |

- 폰 브라우저(Safari / Chrome)로 열어야 한다. **카카오톡 등 인앱 브라우저는 카메라가 차단**되며, 감지되면 안내가 표시된다.
- `?debug=1` 을 붙이면 진단 정보가 표시된다.

## logo.html

명찰에 붙인 QR 스티커를 비추면 로고가 3D 로 뜬다. QR 에 이 페이지 주소가 담겨 있어
폰 기본 카메라로 찍으면 페이지가 바로 열리고, 그대로 그 QR 이 AR 마커가 된다.

3D 라이브러리를 쓰지 않는다. QR 네 모서리 → 호모그래피 → 카메라 자세(R|t) → CSS `matrix3d` 로
브라우저가 직접 원근을 그린다. 입체감은 같은 이미지를 여러 장 겹쳐 두께를 만드는 방식.
검출은 `BarcodeDetector` API, 없으면 `jsQR` 로 폴백한다(아이폰 사파리).

## 이 저장소에 없는 것

배포용 최소 구성만 담았다. 증거물 원본 이미지와 개발 도구(타겟 컴파일·타겟 표시 페이지)는
게임 내용이 새지 않도록 제외했다. 전체 소스는 로컬 `~/Claude/ar-crimescene` 에 있다.

`public/targets.mind` 는 이미지가 아니라 특징점 데이터라 내용을 볼 수 없다.
