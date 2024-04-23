// credit to https://github.com/hunterloftis/throng, with some changes for our purpose
const cluster = require('cluster')
const os = require('os')
const defaultsDeep = require('lodash').defaultsDeep
const logger = require('./logger').get('cluster')

const defaults = {
  master: () => { },
  count: os.cpus().length,
  lifetime: Infinity,
  grace: 5000,
  signals: ['SIGTERM', 'SIGINT'],
}

// 
// Queue the disconnect for a short time in the future.
// Node has some edge-cases with child processes that this helps with -
// Unlike main processes, child processes do not exit immediately once no async ops are pending.
// However, calling process.exit() exits immediately, even if async I/O (like console.log/stdout/piping to a file) is pending.
// Instead of using process.exit(), you can disconnect the worker, after which it will die just like a normal process.
// In practice, disconnecting directly after I/O can cause EPIPE errors (https://github.com/nodejs/node/issues/29341)
// I dislike adding arbitrary delays to the system, but 50ms here has eliminated flappy test failures.
function disconnect() {
  setTimeout(() => cluster.worker.disconnect(), 50)
}


//
// Note: global variable only available in mastre process context!
// It helps to manage workers created. In case one worker is dead, newly created
// worker process will be put to correct position.
//
// the workerMap maintains the mapping of underlying worker.id (which is changing if restarted)
// to it's index
//
// When new worker started, master will try to send the new worker'er info (saved in workers)
// to the worker process via 'init' message
const global = {
  workerMap: {},     // map Cluster.worker.id to worker info
  workers: {},       // map worker uid to worker info. worker UID is like index but start from 1.
  handlers: {},      // master registered handlers for messages from workers
}

/**
 * Cluster main loop. After setting up necessary housekeeping stuff, it will call
 * user provided main_loop
 * 
 * User main loop will accept one param: workers, the workers object will provide following intervace
 *    count: get # of workers
 *    send(msgType, msgObject): send all work the same message, return false on failure, true on success
 *    send(uid, msgType, msgObject): send msg to given worker, return false on failure, true on success
 *    on(msgType, handler): register a message handler for given message type, the handler has signature as
 *                          function(workeruid, msgType, msgBody)
 */
const master_loop = async (main_loop) => {
  process.on('beforeExit', () => {
    logger.info("Master quitting")
  })

  const sendToWorker = (info, type, payload) => {
    // get worker process
    const worker = cluster.workers[info.id]

    if (worker) {
      // logger.info("Sending message %s to worker %d (uid=%d) with seq %d", type, info.id, worker.uid, payload.seq)
      worker.send({ type, payload })
      return true;
    }

    return false;
  }

  //
  // worker process proxy
  const proxy = {
    count: () => Object.keys(global.workers).length,
    send: (uid, type, payload) => {
      const worker = global.workers[uid];
      if (!worker) {
        logger.error('Cannot send message %s to non-existing worker %d', type, uid)
        return false;
      }

      logger.debug('Sending message %s to worker %d (uid=%d) ...', type, worker.id, uid)
      return sendToWorker(worker, type, payload)
    },
    broadcast: (type, payload) => {
      logger.info('Broadcasting message %s to %d workers ...', type, Object.keys(global.workers).length)
      Object.values(global.workers).forEach(worker => sendToWorker(worker, type, payload))
    },
    on: (msgType, handler) => {
      if (global.handlers.hasOwnProperty(msgType)) {
        global.handlers[msgType].push(handler)
      }
      else {
        global.handlers[msgType] = [handler];
      }
    }
  }

  cluster.on('message', async function (worker, msg) {
    const info = global.workerMap[worker.id]

    if (!info) {
      logger.info("Ignore message from unknown worker %d (uid=%d)", worker.id, uid)
      return
    }

    const { uid } = info;

    // we find the worker info, let's try do the msg
    if (typeof msg !== 'object' || !msg.type) {
      // we expect an object!!!
      logger.info("Ignore invalid message or message without type from worker %d (uid=%d, type=%s (%s))", worker.id, uid, (msg || {}).type, typeof (msg))
      return
    }

    if (msg.type === '$ready') {
      // handle framework message $ready, worker send this when it is ready to process tasks
      const tmp = msg.payload;
      logger.info("Worker %d claim to be ready (id=%d, uid=%d)", uid, tmp.id, tmp.uid)
      return;
    }

    const handlers = global.handlers[msg.type] || []
    if (handlers.length === 0) {
      logger.info("Ignore message from worker %d (uid=%d, type=%s): no handlers", worker.id, uid, msg.type)
      return
    }

    handlers.forEach(handler => handler(uid, msg.type, msg.payload));
  })

  logger.info("Start master main loop ...")
  main_loop(proxy);
}

/**
 * Worker process main loop. After setting up necessary housekeeping stuff, it will
 * call user provided worker's main_loop
 * 
 * The mainloop will accept one param: runtime, the runtime provides following info
 *    self(): return worker info like worker ID, uid, etc.
 *    send(msgType, payload): send a message to master
 *    on(msgType, handler): when receive a message of given type, call handler, handler signature is function(msgType, payload)
 */
const worker_loop = async (main_loop, disconnect) => {
  const runtime = {
    uid: 0, // set in init message
    info: null, // worker info
    handlers: {},
    cleaners: [], // finalizers to be called when process quit unexpectedly??
    self: () => runtime.info,
    send: (type, payload) => {
      return process.send({ type, payload })
    },
    on: (type, handler) => {
      if (runtime.handlers.hasOwnProperty(type)) {
        runtime.handlers[type].push(handler)
      }
      else {
        runtime.handlers[type] = [handler];
      }
    }
  }

  let exited = false

  async function shutdown() {
    if (exited) return
    exited = true

    await new Promise(r => setTimeout(r, 300))  // simulate async cleanup work

    disconnect()
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  process.on('uncaughtExceptionMonitor', async (err, origin) => {
    logger.error("Caught unexpected exception from " + origin + ": " + err.message +", calling " + runtime.cleaners.length + " finalizer(s) ...")
    for(const idx in runtime.cleaners) {
      const cleaner = runtime.cleaners[idx];
      try {
        logger.info("Execute cleaner at position " + idx)
        const ret = cleaner()
        await Promise.resolve(ret);
        logger.info("Cleaner at position " + idx + " executed successfully")
      }
      catch (err) {
        logger.error(err, "Failed to call cleaner at position " + idx);
      }
    }
  });

  process.on('message', async function (msg) {
    // we find the worker info, let's try do the msg
    if (typeof msg !== 'object' || !msg.type) {
      // we expect an object!!!
      logger.info("Worker %d ignore invalid message or message without type from master type=%s (%s)", uid, (msg || {}).type, typeof (msg))
      return
    }

    if (msg.type === '$init') {
      if (runtime.uid > 0) {
        logger.warn('Worker %d already initialized but receive $init again!', runtime.uid)
      }

      // this is the init message, the param is worker info object
      const info = msg.payload || {}
      if (!info.uid || info.uid <= 0) {
        logger.warn("Receive invalid INIT message from maseter: %s", JSON.stringify(info));
      }
      else {
        const { uid } = info;
        runtime.info = info;
        runtime.uid = info.uid;

        logger.info("Init worker %d with %s ...", uid, JSON.stringify(info))
        main_loop(runtime)

        // let master know this is alive
        process.send({ type: '$ready', payload: info })
      }

      return;
    }

    const handlers = runtime.handlers[msg.type] || []
    if (handlers.length === 0) {
      logger.info("Worker %d ignore message %s with sequence %d from master: no handlers", runtime.uid, msg.type, msg.payload?.seq)
      return
    }

    handlers.forEach(handler => handler(msg.type, msg.payload));
  })
}

/**
 * Start master along with a throng of workers processes.
 *
 * For each worker process,
 * 1. server spawn it
 * 2. server send $init message to it with it's runtime information (like worker id)
 * 3. worker on receiving $init, start worker main loop
 * 4. worker send $ready message to master
 * 5. master on receiving $ready marks the worker as active (for accepting tasks)
 *
 * @param options
 * @returns {Promise<void>}
 */
module.exports = async function throng(options) {
  const config = defaultsDeep({}, options, defaults)
  const worker = config.worker
  const master = config.master

  if (typeof worker !== 'function') {
    throw new Error('Start function required');
  }

  if (cluster.isWorker) {
    return await worker_loop(worker, disconnect)
  }

  const reviveUntil = Date.now() + config.lifetime
  let running = true

  // install event listeners
  cluster.on('fork', (worker) => {
    logger.info(`The worker #${worker.id} is active`);
  })

  cluster.on('disconnect', (worker) => {
    logger.warn(`The worker #${worker.id} has disconnected`);
    revive(worker.id)
  })

  // install killing signals
  config.signals.forEach(signal => process.on(signal, shutdown(signal)))

  // start workers
  logger.info(`Try starting ${config.count} workers processes ...`)
  for (var i = 0; i < config.count; i++) {
    const uid = i + 1;
    const w = cluster.fork()
    const info = {
      id: w.id,
      uid,  // set uid to idx + 1 to avoid 0
    };

    // send init message to get worker initialized up
    w.send({ type: '$init', payload: info });

    global.workers[uid] = info;
    global.workerMap[w.id] = info;
    logger.info("Create worker %d with uid %d", w.id, info.uid);
  }

  // start master loop after workers created
  await master_loop(master)

  function shutdown(signal) {
    return () => {
      running = false

      setTimeout(() => forceKill(signal), config.grace).unref()

      Object.values(cluster.workers).forEach(w => {
        w.process.kill(signal)
      })
    }
  }

  function revive(id) {
    if (!running) {
      return
    }

    if (Date.now() >= reviveUntil) {
      return
    }

    // destroy old mapping
    const uid = global.workerMap[id].uid
    delete global.workerMap[id]

    logger.info('Try revive worker %d with uid %d ...', id, uid)

    const w = cluster.fork()

    const info = {
      id: w.id,
      uid,
    }

    // send init message to get worker initialized up
    w.send({ type: '$init', payload: info });

    // create new mapping
    global.workers[uid] = info;
    global.workerMap[w.id] = info;

    logger.info("Revive worker with uid %d (old worker id %d, new worker id %d)", uid, id, w.id)
  }

  function forceKill(signal) {
    Object.values(cluster.workers).forEach(w => w.kill(signal))
    process.exit()
  }
}
