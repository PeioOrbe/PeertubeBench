const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const vmId = process.env.VM_ID || 'unknown';
const viewerId = process.env.VIEWER_ID || '0';

async function runViewer() {
const browser = await chromium.launch({
    headless: true, 
    args: [
      '--ignore-certificate-errors', // 🔥 Obliga a WebRTC a confiar en tu IP
      '--ignore-certificate-errors-spki-list', // 🔥 Desactiva la paranoia de WebRTC
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--enforce-webrtc-ip-permission-check=false',
      '--allow-file-access-from-files'
    ]
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true
  });

  const page = await context.newPage();

  // ------------------------------------------------------
  // Network throttling (CDP)
  // ------------------------------------------------------

  if (config.networkThrottle) {
    const client = await page.context().newCDPSession(page);

    await client.send('Network.enable');

    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      downloadThroughput:
        (config.networkThrottle.download * 1024) / 8,
      uploadThroughput:
        (config.networkThrottle.upload * 1024) / 8,
      latency: config.networkThrottle.latency
    });
  }

  // ------------------------------------------------------
  // HTTP traffic tracking
  // ------------------------------------------------------

  let httpBytes = 0;
  let requestCount = 0;

  page.on('requestfinished', async request => {
    try {
      const url = request.url();

      if (
        url.includes('.mp4') ||
        url.includes('.ts') ||
        url.includes('.m3u8') ||
        url.includes('/static/')
      ) {
        const sizes = await request.sizes();

        httpBytes += sizes.responseBodySize || 0;
        requestCount++;
      }
    } catch (_) {}
  });

  // ------------------------------------------------------
  // QoE + WebRTC tracker
  // ------------------------------------------------------

  await page.addInitScript(() => {
    // ======================================================
    // EARLY WEBRTC HOOK
    // ======================================================

    window.webrtcPeers = [];

    const NativeRTCPeerConnection =
      window.RTCPeerConnection ||
      window.webkitRTCPeerConnection;

    if (
      NativeRTCPeerConnection &&
      !window.__peerHookInstalled
    ) {
      window.__peerHookInstalled = true;

      function HookedRTCPeerConnection(...args) {
        const pc = new NativeRTCPeerConnection(...args);

        window.webrtcPeers.push(pc);

        pc.addEventListener('connectionstatechange', () => {
          const state = pc.connectionState;
          window.qoeStats.webrtc.peerChurnEvents.push({
            state,
            timestamp: performance.now()
          });
          if (state === 'failed' || state === 'disconnected') {
            window.qoeStats.webrtc.iceReconnects++;
          }
        });

        pc.addEventListener('iceconnectionstatechange', () => {
          const state = pc.iceConnectionState;
          window.qoeStats.webrtc.peerChurnEvents.push({
            iceState: state,
            timestamp: performance.now()
          });
        });

        return pc;
      }

      HookedRTCPeerConnection.prototype =
        NativeRTCPeerConnection.prototype;

      window.RTCPeerConnection =
        HookedRTCPeerConnection;

      if (window.webkitRTCPeerConnection) {
        window.webkitRTCPeerConnection =
          HookedRTCPeerConnection;
      }
    }

    // ======================================================
    // QoE STATE
    // ======================================================

    window.qoeTrackerAttached = false;

    window.qoeStats = {
      navStartTime: performance.now(),

      // Startup
      startupDelayMs: null,
      startupFailure: true,
      manifestLoadedMs: null,
      firstSegmentMs: null,
      autoplayBlocked: false,

      // Buffering
      stallCount: 0,
      totalStallDurationMs: 0,
      stallEvents: [],

      // Playback
      playbackEndedUnexpectedly: false,
      playbackErrors: [],

      // Resolution / ABR
      resolutionsSeen: [],
      bitrateSamples: [],

      // Playback rate
      playbackRates: [],

      // Video quality
      droppedFrames: 0,
      totalFrames: 0,
      corruptedVideoFrames: 0,
      hwDecoding: 'unknown',

      // WebRTC
      webrtc: {
        peerConnectionsDetected: 0,
        inboundBitrateKbps: 0,
        outboundBitrateKbps: 0,
        packetLoss: 0,
        jitterMs: 0,
        currentRoundTripTimeMs: 0,
        iceReconnects: 0,
        peerChurnEvents: [],
        _lastInboundBytes: 0,
        _lastOutboundBytes: 0,
        _lastWebrtcTimestamp: 0
      },

      // Internals
      _lastCurrentTime: -1,
      _stallActive: false,
      _lastStallTime: null,
      _firstFrameRendered: false,

      _lastDecodedBytes: 0,
      _lastQualityTime: 0,

      _ghostInterval: null,
      _qualityInterval: null,
      _webrtcInterval: null
    };

    // ======================================================
    // GPU / HW Decoding detection
    // ======================================================

    if (navigator.mediaCapabilities && navigator.mediaCapabilities.decodingInfo) {
      navigator.mediaCapabilities.decodingInfo({
        type: 'file',
        video: {
          contentType: 'video/mp4; codecs="avc1.42E01E"',
          width: 1920,
          height: 1080,
          bitrate: 1200000,
          framerate: 30
        }
      }).then(info => {
        window.qoeStats.hwDecoding = info.supported ? 'supported' : 'unsupported';
      }).catch(() => {
        window.qoeStats.hwDecoding = 'unavailable';
      });
    } else {
      window.qoeStats.hwDecoding = 'unavailable';
    }

    // ======================================================
    // Video detection
    // ======================================================

    const observer = new MutationObserver(() => {
      const video = document.querySelector('video');

      if (video && !window.qoeTrackerAttached) {
        window.qoeTrackerAttached = true;

        // Manifest / first segment detection via Resource Timing
        const perfObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const name = entry.name.toLowerCase();
            if (name.includes('.m3u8') && !window.qoeStats.manifestLoadedMs) {
              window.qoeStats.manifestLoadedMs = performance.now() - window.qoeStats.navStartTime;
            }
            if ((name.includes('.ts') || name.includes('.mp4')) && !window.qoeStats.firstSegmentMs) {
              window.qoeStats.firstSegmentMs = performance.now() - window.qoeStats.navStartTime;
            }
          }
        });
        perfObserver.observe({ type: 'resource', buffered: true });

        attachQoE(video);
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    // ======================================================
    // QoE attachment
    // ======================================================

    function attachQoE(video) {
      const qoe = window.qoeStats;

      // --------------------------------------------------
      // Startup delay
      // --------------------------------------------------

      video.addEventListener('timeupdate', () => {
        if (
          !qoe._firstFrameRendered &&
          video.currentTime > 0
        ) {
          qoe._firstFrameRendered = true;

          qoe.startupFailure = false;

          qoe.startupDelayMs =
            performance.now() - qoe.navStartTime;
        }

        // Resolution tracking

        if (video.videoWidth && video.videoHeight) {
          const res =
            `${video.videoWidth}x${video.videoHeight}`;

          if (!qoe.resolutionsSeen.includes(res)) {
            qoe.resolutionsSeen.push(res);
          }
        }
      });

      // --------------------------------------------------
      // Stall helpers
      // --------------------------------------------------

      function startStall(reason) {
        if (!qoe._stallActive) {
          qoe._stallActive = true;

          qoe.stallCount++;

          qoe._lastStallTime = performance.now();

          qoe.stallEvents.push({
            type: reason,
            start: qoe._lastStallTime
          });
        }
      }

      function resolveStall() {
        if (qoe._stallActive) {
          const now = performance.now();

          const duration =
            now - qoe._lastStallTime;

          qoe.totalStallDurationMs += duration;

          const last =
            qoe.stallEvents[qoe.stallEvents.length - 1];

          if (last) {
            last.end = now;
            last.durationMs = duration;
          }

          qoe._stallActive = false;
          qoe._lastStallTime = null;
        }
      }

      // --------------------------------------------------
      // Native buffering events
      // --------------------------------------------------

      ['waiting', 'stalled'].forEach(evt => {
        video.addEventListener(evt, () => {
          if (
            !video.paused &&
            !video.seeking &&
            qoe.startupDelayMs !== null &&
            video.readyState < 3
          ) {
            startStall(evt);
          }
        });
      });

      ['playing', 'canplay'].forEach(evt => {
        video.addEventListener(evt, resolveStall);
      });

      // --------------------------------------------------
      // Ghost stall detector
      // --------------------------------------------------

      qoe._ghostInterval = setInterval(() => {
        if (
          !video.paused &&
          !video.seeking &&
          qoe.startupDelayMs !== null
        ) {
          const delta = Math.abs(
            video.currentTime -
              qoe._lastCurrentTime
          );

          if (
            delta < 0.01 &&
            video.readyState < 3
          ) {
            startStall('ghost');
          } else {
            resolveStall();
          }
        }

        qoe._lastCurrentTime =
          video.currentTime;
      }, 500);

      // --------------------------------------------------
      // Playback errors
      // --------------------------------------------------

      video.addEventListener('error', () => {
        if (video.error) {
          qoe.playbackErrors.push({
            code: video.error.code,
            message:
              video.error.message || 'unknown',
            timestamp: performance.now()
          });
        }
      });

      // --------------------------------------------------
      // Unexpected end
      // --------------------------------------------------

      video.addEventListener('ended', () => {
        if (
          video.duration &&
          video.currentTime <
            video.duration - 1
        ) {
          qoe.playbackEndedUnexpectedly = true;
        }
      });

      // --------------------------------------------------
      // Quality metrics
      // --------------------------------------------------

      qoe._qualityInterval = setInterval(() => {
        try {
          // Dropped frames

          if (
            typeof video.getVideoPlaybackQuality ===
            'function'
          ) {
            const quality =
              video.getVideoPlaybackQuality();

            qoe.droppedFrames =
              quality.droppedVideoFrames || 0;

            qoe.totalFrames =
              quality.totalVideoFrames || 0;

            qoe.corruptedVideoFrames =
              quality.corruptedVideoFrames || 0;
          }

          // Playback rate tracking

          qoe.playbackRates.push({
            ts: performance.now(),
            rate: video.playbackRate
          });

          // Instant bitrate

          if (
            typeof video.webkitVideoDecodedByteCount ===
              'number' &&
            video.currentTime > 0
          ) {
            const currentBytes =
              video.webkitVideoDecodedByteCount;

            const now = performance.now();

            if (
              qoe._lastDecodedBytes > 0 &&
              qoe._lastQualityTime > 0
            ) {
              const deltaBytes =
                currentBytes -
                qoe._lastDecodedBytes;

              const deltaSeconds =
                (now - qoe._lastQualityTime) /
                1000;

              if (deltaSeconds > 0) {
                const instantBitrateKbps =
                  ((deltaBytes * 8) /
                    deltaSeconds) /
                  1000;

                if (
                  instantBitrateKbps > 0 &&
                  instantBitrateKbps < 100000
                ) {
                  qoe.bitrateSamples.push({
                    ts: now,
                    kbps: Math.round(
                      instantBitrateKbps
                    )
                  });
                }
              }
            }

            qoe._lastDecodedBytes =
              currentBytes;

            qoe._lastQualityTime = now;
          }
        } catch (_) {}
      }, 2000);

      // --------------------------------------------------
      // WebRTC metrics
      // --------------------------------------------------

      qoe._webrtcInterval = setInterval(async () => {
        try {
          const peers =
            window.webrtcPeers || [];

          qoe.webrtc.peerConnectionsDetected =
            peers.length;

          for (const pc of peers) {
            if (
              pc.connectionState === 'closed'
            ) {
              continue;
            }

            const stats =
              await pc.getStats();

            stats.forEach(report => {
              // Inbound RTP
              if (
                report.type === 'inbound-rtp' &&
                report.kind === 'video'
              ) {
                if (
                  typeof report.bytesReceived ===
                    'number' &&
                  qoe.webrtc._lastInboundBytes > 0 &&
                  qoe.webrtc._lastWebrtcTimestamp > 0
                ) {
                  const deltaBytes =
                    report.bytesReceived -
                    qoe.webrtc._lastInboundBytes;
                  const deltaMs =
                    performance.now() -
                    qoe.webrtc._lastWebrtcTimestamp;
                  if (deltaMs > 0 && deltaBytes > 0) {
                    qoe.webrtc.inboundBitrateKbps =
                      Math.round(
                        ((deltaBytes * 8) /
                          deltaMs) *
                          1000 /
                          1000
                      );
                  }
                }
                qoe.webrtc._lastInboundBytes =
                  report.bytesReceived;

                if (
                  typeof report.packetsLost ===
                  'number'
                ) {
                  qoe.webrtc.packetLoss =
                    report.packetsLost;
                }

                if (
                  typeof report.jitter ===
                  'number'
                ) {
                  qoe.webrtc.jitterMs =
                    Math.round(
                      report.jitter * 1000
                    );
                }
              }

              // Outbound RTP
              if (
                report.type === 'outbound-rtp' &&
                report.kind === 'video'
              ) {
                if (
                  typeof report.bytesSent ===
                    'number' &&
                  qoe.webrtc._lastOutboundBytes > 0 &&
                  qoe.webrtc._lastWebrtcTimestamp > 0
                ) {
                  const deltaBytes =
                    report.bytesSent -
                    qoe.webrtc._lastOutboundBytes;
                  const deltaMs =
                    performance.now() -
                    qoe.webrtc._lastWebrtcTimestamp;
                  if (deltaMs > 0 && deltaBytes > 0) {
                    qoe.webrtc.outboundBitrateKbps =
                      Math.round(
                        ((deltaBytes * 8) /
                          deltaMs) *
                          1000 /
                          1000
                      );
                  }
                }
                qoe.webrtc._lastOutboundBytes =
                  report.bytesSent;
              }

              // Candidate pair RTT
              if (
                report.type === 'candidate-pair'
              ) {
                if (
                  typeof report.currentRoundTripTime ===
                  'number'
                ) {
                  qoe.webrtc.currentRoundTripTimeMs =
                    Math.round(
                      report.currentRoundTripTime *
                        1000
                    );
                }
              }
            });
            qoe.webrtc._lastWebrtcTimestamp =
              performance.now();
          }
        } catch (_) {}
      }, 5000);
    }
  });

  // ------------------------------------------------------
  // 🚦 RAMP-UP (Escalonamiento) y P2P Toggle
  // ------------------------------------------------------

  // 1. Detectar si estamos en la prueba sin P2P (50% viewers pares)
  const isHalfP2PTest = process.env.HALF_P2P === 'true';
  const isEvenViewer = parseInt(viewerId, 10) % 2 === 0;
  const disableP2P = isHalfP2PTest && isEvenViewer;

  if (disableP2P) {
    // Matar las APIs de WebRTC antes de cargar la web
    await page.addInitScript(() => {
      window.RTCPeerConnection = undefined;
      window.webkitRTCPeerConnection = undefined;
      window.RTCDataChannel = undefined;
    });
    console.log(`[${vmId}/${viewerId}] 🛑 P2P DESACTIVADO para este espectador.`);
  }

  // 2. Random delay between 1s and 5min to simulate users joining at different times
  const randomDelay = 1000 + Math.floor(Math.random() * 299000);
  console.log(`[${vmId}/${viewerId}] Waiting ${(randomDelay / 1000).toFixed(1)}s before joining...`);
  await new Promise(resolve => setTimeout(resolve, randomDelay));

  // ------------------------------------------------------
  // Navigation
  // ------------------------------------------------------

  // Añadimos el parámetro p2p=0 a la URL si el P2P está desactivado
  const p2pParam = disableP2P ? '?p2p=0' : '';
  const url = `${config.peertubeUrl}/w/${config.videoSlug}${p2pParam}`;

  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 120000
  });

  // Esperar a que el botón exista en el código HTML (sin importar si es visible o no)
  await page.waitForSelector('.vjs-big-play-button', {
    state: 'attached',
    timeout: 120000
  });

  // Inyectar JavaScript puro para forzar el clic internamente
  await page.evaluate(() => {
    const video = document.querySelector('video');
    
    // Si por casualidad el navegador ya lo arrancó automáticamente, lo dejamos en paz
    if (video && !video.paused) {
      return;
    }
    
    // Si está pausado, obligamos al botón a recibir un clic
    const playBtn = document.querySelector('.vjs-big-play-button');
    if (playBtn) {
      playBtn.click();
    }
  });

  await page.evaluate(async () => {
    window.qoeStats.autoplayBlocked = false;
  });

  // ------------------------------------------------------
  // Execute benchmark
  // ------------------------------------------------------

  await page.waitForTimeout(
    config.testDuration * 1000
  );

  // ------------------------------------------------------
  // Extract final QoE
  // ------------------------------------------------------

  const finalQoe = await page.evaluate(() => {
    const qoe = window.qoeStats;

    const now = performance.now();

    if (
      qoe._stallActive &&
      qoe._lastStallTime
    ) {
      qoe.totalStallDurationMs +=
        now - qoe._lastStallTime;
    }

    if (qoe._ghostInterval) {
      clearInterval(qoe._ghostInterval);
    }

    if (qoe._qualityInterval) {
      clearInterval(qoe._qualityInterval);
    }

    if (qoe._webrtcInterval) {
      clearInterval(qoe._webrtcInterval);
    }

    return qoe;
  });

  // ------------------------------------------------------
  // Aggregate metrics
  // ------------------------------------------------------

  const testDurationMs =
    config.testDuration * 1000;

  const bufferingRatioPercent =
    finalQoe.startupFailure
      ? 100
      : Number(
          (
            (finalQoe.totalStallDurationMs /
              testDurationMs) *
            100
          ).toFixed(2)
        );

  const avgBitrateKbps =
    finalQoe.bitrateSamples.length > 0
      ? Math.round(
          finalQoe.bitrateSamples.reduce(
            (acc, s) => acc + s.kbps,
            0
          ) /
            finalQoe.bitrateSamples.length
        )
      : 0;

  const bitrateVariance =
    finalQoe.bitrateSamples.length > 1
      ? (() => {
          const values =
            finalQoe.bitrateSamples.map(
              s => s.kbps
            );

          const mean =
            values.reduce(
              (a, b) => a + b,
              0
            ) / values.length;

          const variance =
            values.reduce(
              (acc, v) =>
                acc + Math.pow(v - mean, 2),
              0
            ) / values.length;

          return Math.round(
            Math.sqrt(variance)
          );
        })()
      : 0;

  const droppedFrameRatioPercent =
    finalQoe.totalFrames > 0
      ? Number(
          (
            (finalQoe.droppedFrames /
              finalQoe.totalFrames) *
            100
          ).toFixed(2)
        )
      : 0;

  const playbackContinuityScore =
    finalQoe.startupFailure
      ? 0
      : Math.max(
          0,
          Number(
            (
              100 -
              bufferingRatioPercent -
              droppedFrameRatioPercent
            ).toFixed(2)
          )
        );

  // QoE Score global: startup + stalls + frames + RTT
  let qoeScore = 100;
  if (finalQoe.startupFailure) {
    qoeScore -= 30;
  } else if (finalQoe.startupDelayMs > 10000) {
    qoeScore -= 20;
  } else if (finalQoe.startupDelayMs > 5000) {
    qoeScore -= 10;
  }
  qoeScore -= Math.min(finalQoe.stallCount * 2, 20);
  if (finalQoe.totalStallDurationMs > 10000) qoeScore -= 10;
  if (droppedFrameRatioPercent > 5) qoeScore -= 15;
  else if (droppedFrameRatioPercent > 1) qoeScore -= 5;
  if (bitrateVariance > 500) qoeScore -= 5;
  if (finalQoe.webrtc.currentRoundTripTimeMs > 500) qoeScore -= 10;
  else if (finalQoe.webrtc.currentRoundTripTimeMs > 200) qoeScore -= 5;
  qoeScore = Math.max(0, Math.round(qoeScore));

  // ------------------------------------------------------
  // Final metrics object
  // ------------------------------------------------------

  const metrics = {
    vmId,
    viewerId,

    traffic: {
      httpBytes,
      httpMegabytes: Number(
        (
          httpBytes /
          1024 /
          1024
        ).toFixed(2)
      ),
      requestCount
    },

    qoe: {
      startupFailure:
        finalQoe.startupFailure,

      startupDelayMs:
        finalQoe.startupDelayMs,

      manifestLoadedMs:
        finalQoe.manifestLoadedMs,

      firstSegmentMs:
        finalQoe.firstSegmentMs,

      autoplayBlocked:
        finalQoe.autoplayBlocked,

      stallCount:
        finalQoe.stallCount,

      totalStallDurationMs:
        finalQoe.totalStallDurationMs,

      bufferingRatioPercent,

      playbackContinuityScore,

      droppedFrames:
        finalQoe.droppedFrames,

      totalFrames:
        finalQoe.totalFrames,

      corruptedVideoFrames:
        finalQoe.corruptedVideoFrames,

      hwDecoding:
        finalQoe.hwDecoding,

      droppedFrameRatioPercent,

      avgBitrateKbps,

      bitrateVariance,

      bitrateSamples:
        finalQoe.bitrateSamples,

      playbackRates:
        finalQoe.playbackRates,

      resolutionsSeen:
        finalQoe.resolutionsSeen,

      playbackErrors:
        finalQoe.playbackErrors,

      playbackEndedUnexpectedly:
        finalQoe.playbackEndedUnexpectedly,

      qoeScore
    },

    webrtc: finalQoe.webrtc,

    timestamp: Date.now()
  };

  // ------------------------------------------------------
  // Save metrics
  // ------------------------------------------------------

  const resultsDir =
    path.join(__dirname, 'results');

  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, {
      recursive: true
    });
  }

  const outputFile = path.join(
    resultsDir,
    `metrics-${vmId}-${viewerId}.json`
  );

  fs.writeFileSync(
    outputFile,
    JSON.stringify(metrics, null, 2)
  );

  console.log(
    `[${vmId}/${viewerId}] Completed -> ${outputFile}`
  );

  await browser.close();
}

runViewer().catch(err => {
  console.error(err);
  process.exit(1);
});
