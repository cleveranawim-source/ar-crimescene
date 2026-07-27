/* QR 마커 추적기 — qr.html · logo.html 공용
 *
 *   const tk = new QRTracker({ video, onFrame });
 *   await tk.start();
 *
 * 하는 일
 *   1. 카메라를 열고 매 프레임 QR 을 찾는다 (BarcodeDetector → 없으면 jsQR)
 *   2. 네 모서리를 영상 픽셀 → 화면 픽셀로 옮긴다 (object-fit: cover 크롭 반영)
 *   3. 떨림을 줄이고(지수 평활) 잠깐 놓쳐도 유지한다(missTries)
 *   4. 원하면 그 네 점으로 카메라 자세(R|t)까지 복원한다 (pose: true)
 *
 * onFrame({ found, value, quad, pose }) 이 매 프레임 호출된다.
 *   quad — 화면 좌표 [[x,y]×4], 순서는 좌상·우상·우하·좌하
 *   pose — { R:[r1,r2,r3], t:[x,y,z], f } 마커 한 변을 1 로 보는 카메라 좌표계
 */
(function (global) {
  'use strict';

  // ── 사영변환: 단위정사각형 (0,0)(1,0)(1,1)(0,1) → 임의 사각형 ──
  function unitSquareToQuad(q) {
    const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
    const sx = x0 - x1 + x2 - x3;
    const sy = y0 - y1 + y2 - y3;

    if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
      return { a11: x1 - x0, a21: x3 - x0, a31: x0,
               a12: y1 - y0, a22: y3 - y0, a32: y0, a13: 0, a23: 0 };
    }
    const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
    const den = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(den) < 1e-9) return null;
    const a13 = (sx * dy2 - dx2 * sy) / den;
    const a23 = (dx1 * sy - sx * dy1) / den;
    return {
      a11: x1 - x0 + a13 * x1, a21: x3 - x0 + a23 * x3, a31: x0,
      a12: y1 - y0 + a13 * y1, a22: y3 - y0 + a23 * y3, a32: y0, a13, a23,
    };
  }

  function applyH(h, u, v) {
    const w = h.a13 * u + h.a23 * v + 1;
    return [(h.a11 * u + h.a21 * v + h.a31) / w, (h.a12 * u + h.a22 * v + h.a32) / w];
  }

  // 엘리먼트 박스 [0,W]×[0,H] → 화면 사각형. CSS matrix3d 는 열 우선.
  function matrix3dFor(quad, W, H) {
    const h = unitSquareToQuad(quad);
    if (!h) return null;
    const b11 = h.a11 / W, b21 = h.a21 / H, b31 = h.a31;
    const b12 = h.a12 / W, b22 = h.a22 / H, b32 = h.a32;
    const b13 = h.a13 / W, b23 = h.a23 / H;
    return `matrix3d(${b11},${b12},0,${b13}, ${b21},${b22},0,${b23}, 0,0,1,0, ${b31},${b32},0,1)`;
  }

  // ── 호모그래피 → 카메라 자세 ──────────────────────────────
  // 마커를 한 변 1 의 정사각형(중심 원점, z=0 평면)으로 두고 R|t 를 복원한다.
  // K⁻¹H 의 두 열이 회전의 두 축이라는 성질을 쓴다.
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  const norm = (a) => { const l = len(a) || 1e-12; return mul(a, 1 / l); };
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];

  function poseFromQuad(quad, f, cx, cy) {
    const h = unitSquareToQuad(quad);
    if (!h) return null;

    // 단위정사각형 좌표계(u,v ∈ [0,1]) → 마커 좌표계(중심 원점): u = X + .5
    // H_world = H_unit · [[1,0,.5],[0,1,.5],[0,0,1]]
    const Hu = [
      [h.a11, h.a21, h.a31],
      [h.a12, h.a22, h.a32],
      [h.a13, h.a23, 1],
    ];
    const Hw = Hu.map((r) => [r[0], r[1], r[0] * 0.5 + r[1] * 0.5 + r[2]]);

    // A = K⁻¹ · H_world
    const A = [
      [(Hw[0][0] - cx * Hw[2][0]) / f, (Hw[0][1] - cx * Hw[2][1]) / f, (Hw[0][2] - cx * Hw[2][2]) / f],
      [(Hw[1][0] - cy * Hw[2][0]) / f, (Hw[1][1] - cy * Hw[2][1]) / f, (Hw[1][2] - cy * Hw[2][2]) / f],
      [Hw[2][0], Hw[2][1], Hw[2][2]],
    ];

    let a1 = [A[0][0], A[1][0], A[2][0]];
    let a2 = [A[0][1], A[1][1], A[2][1]];
    let a3 = [A[0][2], A[1][2], A[2][2]];

    const l1 = len(a1), l2 = len(a2);
    if (!l1 || !l2) return null;
    let lambda = 2 / (l1 + l2);
    if (a3[2] < 0) lambda = -lambda;          // 마커는 카메라 앞에 있어야 한다

    a1 = mul(a1, lambda); a2 = mul(a2, lambda);
    const t = mul(a3, lambda);

    // 그람-슈미트로 직교정규화 — 잡음 때문에 r1·r2 가 정확히 직교하지 않는다
    const r1 = norm(a1);
    const r2 = norm(sub(a2, mul(r1, dot(r1, a2))));
    const r3 = cross(r1, r2);

    return { R: [r1, r2, r3], t, f, cx, cy };
  }

  // 마커 좌표(한 변 1, 중심 원점, z=0) → 화면 픽셀. 자세 검증용.
  function projectWithPose(pose, X, Y, Z) {
    const { R, t, f, cx, cy } = pose;
    const xc = R[0][0] * X + R[1][0] * Y + R[2][0] * Z + t[0];
    const yc = R[0][1] * X + R[1][1] * Y + R[2][1] * Z + t[1];
    const zc = R[0][2] * X + R[1][2] * Y + R[2][2] * Z + t[2];
    return [cx + f * xc / zc, cy + f * yc / zc];
  }

  // ══════════════════════════════════════════════════════════
  class QRTracker {
    constructor(opt) {
      this.video = opt.video;
      this.onFrame = opt.onFrame || (() => {});
      this.detectWidth = opt.detectWidth || 640;
      this.missTries = opt.missTries != null ? opt.missTries : 6;
      this.smooth = opt.smooth != null ? opt.smooth : 0.45;
      this.snapDist = opt.snapDist != null ? opt.snapDist : 140;
      this.wantPose = !!opt.pose;
      this.fovDeg = opt.fovDeg || 62;          // 폰 후면 카메라 수평 화각 근사

      this.detector = null;
      this.detectMode = 'jsQR';
      this.track = null;
      this.torchOn = false;

      this._canvas = document.createElement('canvas');
      this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
      this._raw = null;
      this._smoothQuad = null;
      this._miss = 999;
      this._inFlight = false;
      this._running = false;
      this._mapK = 1; this._mapX = 0; this._mapY = 0;

      this.value = '';
      this.detMs = 0;
      this.fps = 0;
      this._frames = 0; this._fpsT = 0;

      this._onResize = () => this.updateMapping();
    }

    async _initDetector() {
      if (!('BarcodeDetector' in global)) return;
      try {
        const fmts = await global.BarcodeDetector.getSupportedFormats();
        if (fmts.includes('qr_code')) {
          this.detector = new global.BarcodeDetector({ formats: ['qr_code'] });
          this.detectMode = 'BarcodeDetector';
        }
      } catch { /* 미지원이면 jsQR */ }
    }

    async start() {
      await this._initDetector();

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      this.video.srcObject = stream;
      this.track = stream.getVideoTracks()[0];

      await this.video.play().catch(() => {});
      if (!this.video.videoWidth) {
        await new Promise((res) => this.video.addEventListener('loadedmetadata', res, { once: true }));
      }

      this.updateMapping();
      global.addEventListener('resize', this._onResize);
      global.addEventListener('orientationchange', () => setTimeout(this._onResize, 300));
      if (global.visualViewport) global.visualViewport.addEventListener('resize', this._onResize);

      this._running = true;
      this._tick();
      return this;
    }

    stop() {
      this._running = false;
      global.removeEventListener('resize', this._onResize);
      if (this.track) this.track.stop();
    }

    get hasTorch() {
      try { return this.track && 'torch' in (this.track.getCapabilities ? this.track.getCapabilities() : {}); }
      catch { return false; }
    }

    async setTorch(on) {
      if (!this.track) return false;
      try {
        await this.track.applyConstraints({ advanced: [{ torch: on }] });
        this.torchOn = on;
        return true;
      } catch { return false; }
    }

    // 영상 픽셀 → 화면 픽셀. object-fit: cover 크롭을 그대로 반영해야 한다.
    updateMapping() {
      const vw = this.video.videoWidth, vh = this.video.videoHeight;
      if (!vw || !vh) return false;
      const sw = global.innerWidth, sh = global.innerHeight;
      const scale = Math.max(sw / vw, sh / vh);
      this._mapK = scale;
      this._mapX = (sw - vw * scale) / 2;
      this._mapY = (sh - vh * scale) / 2;
      return true;
    }

    async _detectOnce() {
      const cam = this.video;
      if (!cam.videoWidth) return null;

      if (this.detector) {
        const codes = await this.detector.detect(cam);
        if (!codes || !codes.length) return null;
        let best = null, bestArea = -1;
        for (const c of codes) {
          const p = c.cornerPoints;
          if (!p || p.length !== 4) continue;
          const area = Math.abs(
            (p[0].x * p[1].y - p[1].x * p[0].y) + (p[1].x * p[2].y - p[2].x * p[1].y) +
            (p[2].x * p[3].y - p[3].x * p[2].y) + (p[3].x * p[0].y - p[0].x * p[3].y)) / 2;
          if (area > bestArea) { bestArea = area; best = c; }
        }
        if (!best) return null;
        return { value: best.rawValue, corners: best.cornerPoints.map((p) => ({ x: p.x, y: p.y })) };
      }

      const vw = cam.videoWidth, vh = cam.videoHeight;
      const dw = Math.min(this.detectWidth, vw);
      const dh = Math.round(vh * dw / vw);
      if (this._canvas.width !== dw || this._canvas.height !== dh) {
        this._canvas.width = dw; this._canvas.height = dh;
      }
      this._ctx.drawImage(cam, 0, 0, dw, dh);
      const img = this._ctx.getImageData(0, 0, dw, dh);
      const r = global.jsQR(img.data, dw, dh, { inversionAttempts: 'dontInvert' });
      if (!r) return null;
      const k = vw / dw;
      const L = r.location;
      return {
        value: r.data,
        corners: [L.topLeftCorner, L.topRightCorner, L.bottomRightCorner, L.bottomLeftCorner]
          .map((p) => ({ x: p.x * k, y: p.y * k })),
      };
    }

    _render() {
      this._frames++;
      const now = performance.now();
      if (now - this._fpsT > 500) {
        this.fps = Math.round(this._frames * 1000 / (now - this._fpsT));
        this._frames = 0; this._fpsT = now;
      }

      let out = { found: false, value: this.value, quad: null, pose: null };

      if (this._raw && this._miss <= this.missTries) {
        if (!this._smoothQuad) {
          this._smoothQuad = this._raw.map((p) => [p[0], p[1]]);
        } else {
          // 다른 마커로 건너뛸 때 보간하면 물체가 날아다닌다 → 크게 튀면 즉시 이동
          const jump = Math.hypot(this._raw[0][0] - this._smoothQuad[0][0],
                                  this._raw[0][1] - this._smoothQuad[0][1]);
          const a = jump > this.snapDist ? 1 : this.smooth;
          for (let i = 0; i < 4; i++) {
            this._smoothQuad[i][0] += (this._raw[i][0] - this._smoothQuad[i][0]) * a;
            this._smoothQuad[i][1] += (this._raw[i][1] - this._smoothQuad[i][1]) * a;
          }
        }
        out.found = true;
        out.quad = this._smoothQuad;

        if (this.wantPose) {
          const vw = this.video.videoWidth || 1280;
          // 화각으로부터 초점거리(영상 픽셀) → 화면 픽셀로 환산
          const fVideo = vw / (2 * Math.tan(this.fovDeg * Math.PI / 360));
          out.pose = poseFromQuad(this._smoothQuad, fVideo * this._mapK,
                                  global.innerWidth / 2, global.innerHeight / 2);
        }
      } else {
        this._smoothQuad = null;
      }

      this.onFrame(out);
    }

    async _tick() {
      if (!this._running) return;
      requestAnimationFrame(() => this._tick());
      this._render();

      if (this._inFlight) return;
      this._inFlight = true;
      const t0 = performance.now();
      try {
        const r = await this._detectOnce();
        this.detMs = performance.now() - t0;
        if (r) {
          this.value = r.value;
          this._raw = r.corners.map((p) => [p.x * this._mapK + this._mapX,
                                            p.y * this._mapK + this._mapY]);
          this._miss = 0;
        } else {
          this._miss++;
        }
      } catch {
        this.detMs = performance.now() - t0;
        this._miss++;
      } finally {
        this._inFlight = false;
      }
    }
  }

  // ── 시작 전 점검 (두 페이지 공통) ────────────────────────
  function detectInApp() {
    const ua = navigator.userAgent;
    if (/KAKAOTALK/i.test(ua)) return '카카오톡';
    if (/Instagram/i.test(ua)) return '인스타그램';
    if (/FBAN|FBAV/i.test(ua)) return '페이스북';
    if (/Line\//i.test(ua)) return '라인';
    if (/NAVER\(inapp/i.test(ua)) return '네이버 앱';
    if (/DaumApps/i.test(ua)) return '다음 앱';
    return null;
  }

  const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  // 인앱 브라우저·http 접속을 걸러 안내 HTML 을 돌려준다. 문제 없으면 null.
  function preflightHTML() {
    const inApp = detectInApp();
    if (inApp) {
      return `<b>${inApp} 내장 브라우저에서는 카메라를 쓸 수 없습니다.</b>` +
        (isIOS()
          ? `<ol><li>오른쪽 아래 <b>···</b> 또는 나침반 아이콘을 누르세요</li>
               <li><b>Safari로 열기</b>를 선택하세요</li></ol>`
          : `<ol><li>오른쪽 위 <b>⋮</b> 를 누르세요</li>
               <li><b>다른 브라우저로 열기</b>(Chrome)를 선택하세요</li></ol>`) +
        `<button id="copy">링크 복사하기</button>`;
    }
    if (!global.isSecureContext) {
      return `<b>https 가 아니어서 카메라를 쓸 수 없습니다.</b>` +
        `<ol><li>맥에서 테스트할 때는 <b>http://localhost:8080</b> 으로 접속하세요</li>
             <li>폰에서 테스트할 때는 <b>https</b> 주소가 필요합니다 (README 참고)</li></ol>`;
    }
    return null;
  }

  function cameraErrorHTML(err) {
    const denied = /denied|NotAllowed/i.test(String(err && (err.name || err.message)));
    return denied
      ? `<b>카메라 권한이 거부되었습니다.</b>
         <ol><li>주소창의 자물쇠/카메라 아이콘을 누르세요</li>
             <li>카메라를 <b>허용</b>으로 바꾸고 새로고침하세요</li></ol>`
      : `<b>카메라를 열지 못했습니다.</b>
         <ol><li>다른 앱이 카메라를 쓰고 있는지 확인하세요</li>
             <li>페이지를 새로고침해 주세요</li></ol>`;
  }

  global.QRTracker = QRTracker;
  global.QRTrackerUtil = {
    unitSquareToQuad, applyH, matrix3dFor, poseFromQuad, projectWithPose,
    detectInApp, isIOS, preflightHTML, cameraErrorHTML,
    vec: { sub, mul, dot, len, norm, cross },
  };
})(window);
