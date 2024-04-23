// Add the root project directory to the app module search path:
require('app-module-path').addPath(__dirname);

var SegfaultHandler = require('segfault-handler');
const config = require('libs/config')
const chrome = require('libs/chrome')
const throng = require('libs/throng.js')
const master_main = require('src/main')
const logger = require('libs/logger').get('main');

// With no argument, SegfaultHandler will generate a generic log file name
SegfaultHandler.registerHandler("crash.log");

if(config.cluster) {
    logger.info("Starting JSAGENT as cluster ...")
    const worker_main = require('src/worker')

    /**
     * Start the master and worker processes
     */
    throng({master: master_main, worker: worker_main, count: config.workers?.count || 4})
}
else {
    logger.info("Starting JSAGENT as standalone ...")
    master_main(null)
}

/**
 * Release possible resources hsere
 */
process.on('uncaughtExceptionMonitor', async (err, origin) => {
    logger.error("Caught unexpected exception from " + origin + ": " + err.message +", cleanup chrome instances ...")
    try {
        await chrome.cleanup()
        logger.info("Chrome instances cleaned successfully")
    }
    catch (err) {
        logger.error(err, "Failed to clean chrome instances")
    }
});