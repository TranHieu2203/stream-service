const mediasoup = require('mediasoup');
const clc = require('cli-color');
const config = require('../../config');


console.log('MDS loaded [version:%s]', mediasoup.version);


let workers = [];
let routers = [];
let nextRouterIndex = 0;

// Start the mediasoup workers
module.exports.initializeWorkers = async () => {
  const { logLevel, logTags, rtcMinPort, rtcMaxPort } = config.worker;

  console.log(clc.bgGreen.black(`initializeWorkers() creating ${config.numWorkers} mediasoup workers`));
  console.log("----------------------------------------------------------------------------")
  for (let i = 0; i < config.numWorkers; ++i) {
    const worker = await mediasoup.createWorker({
      logLevel, logTags, rtcMinPort, rtcMaxPort
    });
    const router = await worker.createRouter({ mediaCodecs: config.router.mediaCodecs });
    console.log("Create new worker ", i, worker.pid)
    worker.once('died', () => {
      console.error('worker::died worker has died exiting in 2 seconds... [pid:%d]', worker.pid);
      setTimeout(() => process.exit(1), 2000);
    });
    routers.push(router)
    workers.push(worker);
  }
};

module.exports.getRouter = async (router_index) => {
  return routers[router_index];
};

module.exports.createTransport = async (transportType, router, options) => {
  // console.log('createTransport() [type:%s. options:%o]', transportType, options);
  switch (transportType) {
    case 'webRtc':
      return await router.createWebRtcTransport(config.webRtcTransport);
    case 'plain':
      return await router.createPlainTransport(config.plainRtpTransport);
  }
};

module.exports.getNextRouterIndex = () => {
  if (++nextRouterIndex === routers.length) {
    nextRouterIndex = 0;
  }
  return nextRouterIndex;
};