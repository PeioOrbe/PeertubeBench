module.exports = {
  peertubeUrl: 'https://TU-INSTANCIA',
  videoSlug: 'SLUG-DEL-VIDEO-O-LIVE',
  viewersPerVM: 10,
  launchRate: 2,
  networkThrottle: {
    download: 2000,
    upload: 300,
    latency: 500
  },
  testDuration: 600,
  p2pDisabledRatio: 0,
  metricsInterval: 10,
  prometheusUrl: 'http://TU-INSTANCIA_PROMETHEUS:9090'
};
