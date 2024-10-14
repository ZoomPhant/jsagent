/**
* This mainly do following
* 1. maintain & scheduling tasks assigned by server
* 2. maintain heartbeat with server
*/
const _ = require('lodash')
const moment = require('moment')

const version = require('libs/version')
const protocol = require('src/protocol')
const format = require('src/format')
const {executeScriptTask}  = require('src/scripts')

const httpd = require('libs/httpd')
const {TimeoutError, ExecutionError} = require('libs/errors');

const Logger = require('libs/logger')
const { reportSDResults, reportMetrics, reportLogs, reportEvents, reportManualTaskResult} = require('src/protocol')
const config = require('libs/config')
const metrics = require('libs/metrics')
const timed = require('libs/timed')

const TaskManager = require('./tasks')
const TaskScheduler = require('./scheduler')
const ChromeWrapper = require('./chrome')

const TASK_TIMEOUT_MS = 120 * 1000; // in millis
const MIN_METRICS_EPOCH = 30 * 1000;// in millis, avoid too frequent metrics processing

/**
* If slaves is null, we are running in single process mode.
* @param slaves - null for non-cluster mode
* @param registry - null for non-cluster mode, used for prometheus
* @returns {Promise<void>}
*/
module.exports = async (slaves) => {
    const logger = Logger.get("main")
    
    const startMoment = moment(Date.now())
    
    metrics.init("master");
    metrics.gauge("scheduler_stalled", "If scheduler is stalled, 1 true 0 false.");
    metrics.counter("task_requested", "Total requests received from master", ["type"]);
    metrics.counter("task_executed", "Total tasks executed locally", ["type"])
    metrics.counter("task_dispatched", "Total tasks dispatched to workers for execution", ["type"])
    metrics.counter("task_success", "Total success task executions", ["type"]);
    metrics.counter("task_failure", "Total failed task executions", ["type"])
    metrics.counter("task_discarded", "Total discard tasks results", ["type"]);
    metrics.counter("task_timeouts", "Total tasks timed out", ["type"])
    
    metrics.histogram("task_queued_time", "Time spent in queue in milliseconds", [100, 1000, 5000, 10000], ["type"]);
    metrics.histogram("task_execute_time", "Time spent in executing in milliseconds", [5000, 15000, 30000, 60000], ["type"]);
    
    metrics.counter("chrome_start", "Number of chrome instance started");
    metrics.counter("chrome_cache", "Number of chrome instance cache hits");
    metrics.counter("chrome_close", "Number of chrome instance closed");
    metrics.counter("chrome_kill", "Number of chrome instance killed");
    metrics.counter("lighthouse_connect", "Number of lighthouse connecting request");
    metrics.counter("lighthouse_disconnect", "Number of lighthouse disconnecting request");
    
    if(config.role === 'slave') {
        logger.info('Starting slave collector ...')
    }
    else if(config.role === 'mock') {
        logger.info('Starting collector in MOCK mode ...')
    }
    else {
        logger.info('Starting collector %s for account %s ....', config.id, config.account)
    }
    
    /**
    * Task state
    *                                           <time to run>
    *     create / update ----> schedules ------------------------>pendings
    *                              ^                                  |
    *                              |      <response or timeout>       |
    *                               ----------------------------------
    * 
    * A task could have following sub-tasks
    *   1. discover sub-task. Optiona. Shall be executed before the below task, and may have 
    *      different scheduling intervals
    *   2. collect sub-task. Must have. for JS collector, shall always be interval-based
    * 
    * When scheduling, we would always schedule on the who task, so if there's discover task
    * and 
    *   1. if it is has not been executed yet
    *   2. if it has a periodic requirement and need be re-run again
    * we would
    *   1. first schedule the discover task to worker
    *   2. when worker done with result, we schedule the collect task
    * 
    * Only when the collect task been done will we remove the task from pending state
    */
    const state = {
        stalled: false,    // if scheduling is stocked due to e.g. no workers?
        metrics: {
            epoch: 0,       // sequence (time in millis)
            pendings: {},   // pending results
            promises: [],   // pending promises from slaves
        },
        
        lastSyncEpoch: 0,
        
        heartbeater: 0,    // keep sync with server
        
        synchronizer: 0,   // sync account information with server, for cloud mode only
        
        // interval ID returned by setInterval
        schedulers: {},      // 
        
        // collector state stuff
        product: '',      // usu. 'mp2'
        instance: '',
        resource: '',
        syncEpoch: 0,     // last time this is synced
        
        startEpoch: Math.floor(Date.now() / 1000),
        
        /**
        * scheduling start index, we use this to create a round-robin algorithm
        * for assigning tasks to workers
        *
        * Can also be used to count the total # of times we have scheduled tasks
        */
        sched: 0,
        
        /**
        * worker uids, so we can iterate here to access stats
        * in below workerStats
        */
        workers: [],
        
        /**
        * Worker stats, map worker uid to a stat object like
        *   {
        *        timedout: xxx,   // # of request timedout
        *        success: xxx,    // # of tasks succeeded
        *        failure: xxx,    // # of tasks failed
        *        pending: xxx,    // pending tasks, # of tasks scheduled without timeout or result
        *        handler: null or function(result, err)
        *   }
        */
        workerStats: {},
        
        /**
        * Tasks scheduled out and waiting for a reply
        * The key is <type>-<taskID>, the value is a schedule object like
        * {
        *    task: taskId,
        *    type: 'collect' || 'discover',
        *    sequence: 0,             // current sequence
        *    scheduleAt: epochMs,     // from above schedule.scheduleAt
        * }
        */
        pendings: {},
        
        /**
        * In active mode, queued tasks waiting workers to fetch
        */
        queued: [],
        
        /** manually executing task, shall be responsive */
        // manualTasks: [],
    }
    
    if(slaves) {
        /**
        * We avoid using 0 as worker id, so starts with 1
        */
        for (let wid = 1; wid <= slaves.count(); wid++) {
            state.workers.push(wid);
            state.workerStats[wid] = {
                timedout: 0,
                success: 0,
                failure: 0,
                pending: 0,
            }
        }
    }
    
    /**
    * Heart beat task is a ping task that runs every minute to
    * 1. check for version? handling collector upgrade info (not used for JS collector?)
    * 2. report stats (major collector metrics)
    */
    const heartbeat_loop = async () => {
        logger.info("Try ping server ...")
        try {
            const response = await protocol.postPing({
                version,
                priviledged: false,
                uptime: process.uptime,
                statistics: {}
            })
            
            // logger.info({response}, "Got server ping response")
        }
        catch(error) {
            logger.error({stack: error.stack}, "Cannot ping server")
        }
    };
    
    const fix_length_string = (string, limit, suffix = '') => {
        if(!string) {
            return ''.padEnd(limit, ' ');
        }
        
        if(string.length < limit) {
            return string.padEnd(limit, ' ');
        }
        else if(string.length === limit) {
            return string;
        }
        
        const suf = suffix || ''
        if(limit > suf.length) {
            return string.substring(0, limit - suf.length) + suf
        }
        
        return string.substring(0, limit)
    }
    
    /**
    * Execute server scheduled task with given parameters
    * {
    *   taskId: string,
    *   timeout: number, // in in seconds
    * }
    * @param {*} worker 
    * @param {*} taskScheduler 
    * @param {*} task 
    */
    const executeServerScheduledTask = async(worker, taskManager, manualTask) => {
        let retCode = 0;
        let response = 'OK';
        try {
            const {taskId, scheduleAt = 0, sequence = 0} = manualTask.parameters
            
            const task = taskManager.getTask(taskId)
            if (!task) {
                throw new Error('Task not found - ' + taskId)
            }
            
            if(task.frequency < 0x7fffffff) {
                // not a server scheduled task
                throw new Error('Not a server scheduled task - ' + taskId)
            }
            
            // time to do
            await dispatch_task(worker, taskManager, task, scheduleAt, sequence)
        }
        catch(error) {
            logger.error({stack: error.stack}, "Cannot execute server scheduled task")
            response = 'Error executing server scheduled task - ' + error.message
            retCode = -1
        }
        
        const result = {
            id: manualTask.id,
            retCode,
            response,
        }
        
        reportManualTaskResult(taskManager.getAccount(), result)
    }
    
    const runDebug = async(taskManager, task) => {
        const retCode = 0;
        
        let response
        
        if("!help" === task.command) {
            const argument = (task.arguments || [''])[0];
            
            if(!argument) {
                response = "Missing command to show help information";
            }
            else if("!list" === argument) {
                response = "Usage:\n\t!list\n\tListing available command";
            }
            else if("!uptime" === argument) {
                response = "Usage:\n\t!uptime\n\tShow collector running time in human readable format";
            }
            else if("!help" === argument) {
                response = "Usage:\n\t!help <command>\n\tDisplay help message for given command";
            }
            else if("!task" === argument) {
                response = "Usage:\n\t!task\n\t!task <taskId>\n\tIf no taskId given, list tasks executing by the collector. Otherwise show the info for given taskId";
            }
            else {
                response = "Command not found or supported: [" + argument + "]";
            }
        }
        else if("!uptime" === task.command) {
            response = "The collector has been running for " + startMoment.fromNow(true)
        }
        else if ("!task" !== task.command) {
            // command not recognized or
            // if("!list" === task.command) {
            response = ("!list" === task.command ? "Supported commands:\n" : "Unknown or not supported debug task!\n");
            response +=
            "!list            - list available commands\n" +
            "!uptime          - show time the collector has been running\n" +
            "!help <command>  - show help for given command\n" +
            "!task [<taskId>] - if taskId given, show detail of given task, otherwise list tasks\n";
        } else {
            const argument = (task.arguments || [''])[0];
            
            if (!argument) {
                //String.format("%-20s %-6s %-15s %-10s %-30s %-20s %-40s\n", "taskId", "period", "mp", "mpi", "script", "resource", "status");
                response =  "Task ID              freq/s mp              mpi        resource             status\n";
                response += "=======================================================================================\n";
                
                const tasks = taskManager.getAllTasks()
                
                for (const task of tasks) {
                    const resource = taskManager.getResource(task.resourceId)
                    
                    const status = taskManager.getStatusDesc(task.id)
                    const line =
                    fix_length_string(task.id, 20) + " " + fix_length_string(task.frequency + "s", 6) + " " +
                    fix_length_string(resource.mpId, 15) + " " + fix_length_string(resource.mpiId, 10) + " " +
                    fix_length_string(resource.name, 20) + " " + status;
                    
                    response += line;
                    response += "\n";
                }
            }
            else {
                const task = taskManager.getTaskStatus(argument)
                if(!task) {
                    response = "No task found with given ID";
                }
                else {
                    if(task.discover) {
                        response = "Task discovering result found:\n";
                        response += "=====================================\n"
                        response += "\tLast executed: " + task.discover.moment.fromNow() + "\n";
                        if(task.discover.success) {
                            response += "\tStatus: Success\n";
                            response += "\tDiscovered Objects:\n";
                            response += "\t" + JSON.stringify(task.discover.result || []) + "\n"
                        }
                        else {
                            response += "\tStatus: Failed\n";
                            response += "\tMessage: " + task.discover.message + "\n";
                        }
                        
                        response += "\n";
                    }
                    else {
                        response = "Task has no discovering yet.\n";
                        response += "\n";
                    }
                    
                    if(task.collect) {
                        response += "Task has collect task execution result:\n";
                        response += "=====================================\n"
                        response += "\tLast executed: " + task.collect.moment.fromNow() + "\n";
                        if(task.collect.success) {
                            response += "\tStatus: Success\n";
                            response += "\tCollected Data:\n";
                            response += "\t" + JSON.stringify(task.collect.result || []) + "\n"
                        }
                        else {
                            response += "\tStatus: Failed\n";
                            response += "\tMessage: " + task.collect.message + "\n";
                        }
                    }
                    else {
                        response += "Task has no collect task execution yet.\n";
                    }
                }
            }
        }
        
        const result = {
            id: task.id,
            retCode,
            response,
        }
        
        reportManualTaskResult(taskManager.getAccount(), result)
    }
    
    /**
    *  Check periodically the tasks from server
    * @param {*} accountId  - the accountID to check
    * @param {*} measurePerformance  - if we shall measure the performance to server.
    */
    const account_task_sync_loop = async (accountId, measurePerformance) => {
        const info = state.schedulers[accountId]
        if(info == null) {
            logger.error('Scheduling for non-existing account - ' + accountId)
            return
        }
        
        if(info.lastSyncEpoch > 0 && (Date.now() - info.lastSyncEpoch) < 1000) {
            logger.info('Skip sync tasks for account - ' + accountId + ' as last sync is too recent');
            return;
        }
        
        const taskManager = info.taskManager
        const taskScheduler = info.taskScheduler
        
        try {
            const startTime = Date.now()   // milliseconds
            
            let meta;
            if(!measurePerformance || state.product) {
                meta = await protocol.getTasksMeta(accountId, false);
            }
            else {
                meta = await protocol.getTasksMeta(accountId, true);
                /**
                * meta shall contains stuff like
                * {
                *     ...
                *     product: 'mp2',
                *     instance: 'xxx',
                *     resource: 'xxx'
                * }
                */
                
                state.product = meta.product;
                state.instance = meta.instance;
                state.resource = meta.resource;
            }
            
            if(measurePerformance && state.product && (startTime - state.syncEpoch) > 30 * 1000) {
                // report every 30 seconds
                // we have product info now, let's generate some special metric to measure the
                // RTT, time delta, etc
                const endTime = Date.now()
                const serverTime = meta.serverTimeInMillis;
                
                await protocol.reportMetrics(accountId, {
                    labels: {
                        '_product': state.product,
                        '_instance': state.instance,
                        '_resource': state.resource,
                    },
                    dataEntries: [
                        format.metric("zoomphant.collector.ttl", endTime - startTime).get(),
                        format.metric("zoomphant.collector.timedelta", (endTime + startTime) / 2 - serverTime).get()
                    ]
                });
                
                state.syncEpoch = startTime;
            }
            
            const version = taskManager.getVersion()
            if (version !== meta.taskUpdatedEpoch) {
                logger.info("Detect tasks changing from " + version + " to " + meta.taskUpdatedEpoch + ", try syncing changes ...")
                
                const feed = await protocol.getTasksFeed(accountId)
                
                logger.info("Got task feed with %d tasks for %d resources and %d scripts", Object.keys(feed.taskInstances).length, Object.keys(feed.resources).length, Object.keys(feed.scripts).length)
                
                taskManager.update(feed)
                
                const tasks = taskManager.getAllTasks()
                
                taskScheduler.scheduleAll(tasks)
                
                logger.info("Update task version from %s to %s", taskManager.getVersion(), meta.taskUpdatedEpoch)
                
                // update the version
                taskManager.updateVersion(meta.taskUpdatedEpoch)
            }
            
            // check for other tasks
            // state.manualTasks.push(...(meta.tasks || []))
            for(const task of (meta.tasks || [])) {
                if(task.scriptType === "debugCommand") {
                    runDebug(taskManager, task)
                }
                else if(task.scriptType === "serverSchedule") {
                    info.serverTasks.push(task);
                    
                    logger.info({task: task.parameters}, "Adding server scheduled task to queue, total queued: %d", info.serverTasks.length);
                }
                else {
                    logger.warn({task}, "Ignore manual task");
                }
            }
        }
        catch(error) {
            logger.error({stack: error.stack}, "Cannot sync tasks with server")
        }
        finally {
            info.lastSyncEpoch = Date.now();
        }
    }
    
    const process_discover_result = async (taskManager, taskId, scheduleAt, sequence, result, error) => {
        const task = taskManager.getTask(taskId);
        if(!task) {
            // task no longer exists ???
            metrics.count('task_discarded', 1, {type: 'discover'})
            return;
        }
        
        if(error) {
            if(error instanceof TimeoutError) {
                metrics.count("task_timeouts", 1, {type: 'discover'})
            }
            else {
                metrics.count('tasks_failure', 1, {type: 'discover'})
            }
            
            // found error
            taskManager.setTaskStatus(taskId, 'discover', {
                success: false,
                message: error,
            })
        }
        else {
            metrics.count('task_success', 1, {type: 'discover'})
            /**
            * Result is an array of object. The keys will be saved as labels of the found monitor objects
            */
            if (Array.isArray(result)) {
                taskManager.setTaskStatus(taskId, 'discover', {
                    success: true,
                    result,
                })
                
                taskManager.setTaskDiscovered(taskId, result)
                
                const resource = taskManager.getResource(task.resourceId)
                
                // if have tag, create an object with tag as name and taskId as value
                const tags = (resource.tags || []).reduce((map, tag) => {
                    map[tag] = task.id
                    return map
                }, {})
                
                const sdResults = result.map(obj => {
                    return {
                        ...tags, ...obj, ...taskManager.getTaskLabels(taskId)
                    }
                })
                
                await reportSDResults(taskManager.getAccount(), sdResults)
            } else {
                logger.warn('Ignore invalid non-array discover result for task %s', taskId)
                
                taskManager.setTaskStatus(taskId, 'discover', {
                    success: false,
                    message: 'Discover task returns non-array result'
                })
            }
        }
    }
    
    const process_collect_result = async (taskManager, taskId, scheduleAt, sequence, result, error) => {
        const task = taskManager.getTask(taskId);
        if (!task) {
            metrics.count('task_discarded', 1, {type: 'collect'})
            // task no longer exists ???
            return;
        }
        
        if (error) {
            if(error instanceof TimeoutError) {
                metrics.count("task_timeouts", 1, {type: 'discover'})
            }
            else {
                metrics.count('tasks_failure', 1, {type: 'discover'})
            }
            
            taskManager.setTaskStatus(taskId, 'collect', {
                success: false,
                message: error,
            })
        } else {
            metrics.count('task_success', 1, {type: 'collect'})
            taskManager.setTaskStatus(taskId, 'collect', {
                success: true,
                result,
            })
            
            const labels = taskManager.getTaskLabels(taskId) || {}
            if (Array.isArray(result)) {
                // metrics are an array of object with metricName and labels ...
                if (result.length > 0) {
                    const reportData = {
                        labels,
                        dataEntries: result
                    }
                    
                    await reportMetrics(taskManager.getAccount(), reportData)
                } else {
                    logger.info('Got empty result for task %s from worker %d (type=%s): %s', taskId, uid, type, result)
                }
            } else {
                // assume data already in correct format, we just add labels
                const dataEntries = result.dataEntries || []
                if (dataEntries.length > 0) {
                    await reportMetrics(taskManager.getAccount(), {
                        labels,
                        dataEntries
                    })
                }
                
                const logEntries = result.logEntries || []
                if (logEntries.length > 0) {
                    logEntries.array.forEach(chunk => {
                        chunk.tags = {...labels, ...(chunk.tags || {})}
                    });
                    
                    await reportLogs(taskManager.getAccount(), logEntries)
                }
                
                const eventEntries = result.eventEntries || []
                if (eventEntries.length > 0) {
                    eventEntries.forEach(event => {
                        event.tags = {...labels, ...(event.tags || {})}
                    })
                    
                    await reportEvents(taskManager.getAccount(), eventEntries)
                }
            }
        }
    }
    
    const execute_local_task = async (taskId, type, scheduleAt, sequence, task) => {
        logger.info("Try executing %s task %s locally ...", type, taskId)
        
        metrics.count("task_executed", 1, {type})
        
        const clock = metrics.clock();
        const result = await executeScriptTask(type, task, new ChromeWrapper());
        metrics.observe("task_execute_time", clock(), {type})
        
        return result;
        /*
        logger.info("Processing %s result for locally executed task %s ...", type, taskId)
        
        if(type === 'discover') {
        await process_discover_result(taskManager, taskId, scheduleAt, sequence, result, null)
        }
        else {
        await process_collect_result(taskManager, taskId, scheduleAt, sequence, result, null)
        }
        */
    }
    
    /**
    * Find an idle worker to use for next request. We would try not schedule concurrent
    * tasks to a worker
    *
    * @param taskId
    * @returns {number}
    */
    const find_idle_worker = () => {
        let rr = state.sched;
        for (let idx = 0; idx < state.workers.length; idx++) {
            const wid = state.workers[(rr + idx) % state.workers.length];
            const info = state.workerStats[wid]
            if(info.pending === 0) {
                state.sched++;
                info.pending++
                return wid;
            }
        }
        
        state.stalled = true;
        metrics.peg("scheduler_stalled", 1);
        
        logger.error("No IDLE worker to service task");
        
        return 0;
    }
    
    const free_worker = (worker) => {
        const info = state.workerStats[worker];
        if(info) {// for active, uid is set to 0
            if(info.pending <= 0) {
                logger.error("Worker %d has no pending tasks", worker);
            }
            else {
                info.pending--;
                logger.info("Worker %d has pending tasks: %d", worker, info.pending);
                
                if(state.stalled && info.pending === 0) {
                    state.stalled = false;
                    metrics.peg("scheduler_stalled", 0);
                }
            }
        }
    }
    
    /**
    * helper execute a task. The task could be
    * 1. executed locally if there's no worker configured (non-clustering mode)
    * 2. execute remotely by dispatching it to a worker (clustering and passive mode)
    * 3. put to a scheduling queue and wait one worker to execute it (clustering and active mode)
    *
    * @param worker - worker to use. If active mode, set to 0
    * @param taskId  - id of task. Unique cross accounts
    * @param type    - type of task
    * @param scheduleAt
    * @param sequence
    * @param task    - task to execute
    * @returns Promise resolve to the task execution result
    */
    const execute_task = async (worker, taskId, type, scheduleAt, sequence, task) => {
        if(state.workers.length === 0) {
            return execute_local_task(taskId, type, scheduleAt, sequence, task)
        }
        
        const pendingKey = type + "-" + taskId
        
        // see if the task is pending? (still running?)
        const sched = state.pendings[pendingKey]
        if(!sched) {
            if(config.isWorkerPassive()) {
                metrics.count("task_dispatched", 1, {type});
                logger.debug("Dispatching %s task for task %s to worker %d ...", type, taskId, worker)
                slaves.send(worker, "execute", task)
            }
            else {
                metrics.count("task_queued", 1, {type});            
                logger.info("Queue task %d for execution ...", taskId)
                state.queued.push({taskId, type, scheduleAt, sequence, task, clock: metrics.clock()});
            }
        } 
        else {
            logger.warn('Find %s task %s still running. Ignore current running cycle', type, taskId);
            metrics.count("task_duplicated", 1, {type});                        
        }
        
        /**
        * If it is duplicated in above else branch, we would replace pending info with new
        * promise, so previous promise will eventually timeout as it won't receive notification
        */
        return new Promise((resolve, reject) => {            
            state.pendings[pendingKey] = {
                taskId,
                type,
                scheduleAt,
                sequence,
                uid: worker,
                promise: timed(
                    resolve, reject,
                    task.timeout || TASK_TIMEOUT_MS,
                    () => {
                        delete state.pendings[pendingKey];
                    },
                    "Task timed out - " + taskId + " (timeout=" + task.timeout + ", sequence=" + sequence + ")"
                )
            };
        });
    }
    
    /**
    * Dispatch a task for execution.
    *
    * Dispatching a task actually trigger a small state machine, it has two cases:
    *  1. only collect task
    *  2. with discover task
    * 
    * 1. collect task only
    *    dispatching will put the task to pending, and send 'collect' command to worker, 
    *    on receiving collect-result from worker, the statemachine is done
    * 2. with discover task
    *    If current time no need to run discover task, it is the same as above, otherwise,
    *    dispatching will put the task to pending, and send 'discover' command to a worker,
    *    on receiving 'discover-result' from worker, it would try to send 'collect' command
    *    to worker and waiting for 'collect-result' to terminate the state machine
    * 
    * Return true if we queue it to one of the worker for execution, false otherwise
    */
    const dispatch_task = async (worker, taskManager, taskInfo, scheduleAt, sequence) => {
        const environs = taskManager.getTaskEnvirons(taskInfo.id)
        const params = taskManager.getScriptParams(taskInfo.id, taskInfo.scriptId)
        
        const resource = taskManager.getResource(taskInfo.resourceId)
        const taskId = taskInfo.id
        
        // the task to be executed
        const task = {
            resource,
            environs, // environments variables, like taskId, resourceId, etc.
            params,   // params to pass to script
            scheduleAt,   // schedule time, default to 0 (one time execution?)
            sequence,     // sequence #, default to 0 (not care)
        }
        
        const script = taskManager.getScript(taskInfo.scriptId, true)
        if(!script) {
            logger.warn('Try schedule task %s with empty collect script %s', taskId, taskInfo.scriptId)
            return;
        }
        
        const now = Date.now()
        
        const discoverScript = taskManager.getScript(taskInfo.scriptId, false)
        if (discoverScript) {
            // this task has discover， if this discover task has not been run or
            // it has expired its interval, let's do it again before scheduling collect task
            const discovered = taskManager.getTaskDiscovered(taskId)
            
            if (!discovered || ((now - discovered.scheduleAt) > discoverScript.interval)) {
                // schedule discover task first
                logger.info("Try scheduling discover task for task %s ...", taskId);
                task.script = discoverScript;
                try {
                    const result = await execute_task(worker, taskId, 'discover', scheduleAt, sequence, {type: "discover", ...task});
                    await process_discover_result(taskManager, taskId, scheduleAt, sequence, result, null);
                }
                catch(err) {
                    // warn here but we continue to schedule collect task
                    logger.warn(err, "Executing discover task failed for task %s", taskId);
                    await process_discover_result(taskManager, taskId, scheduleAt, sequence, null, err);
                }
            }
            else {
                logger.info("Skip scheduling discover task for task %s ...", taskId);
            }
        }
        
        logger.info("Try schedule collect task for task %s ...", taskId);
        task.script = script;
        task.discovered = taskManager.getTaskDiscovered(taskId);
        
        try {
            const result = await execute_task(worker, taskId, 'collect', scheduleAt, sequence, {type: 'collect', ...task});
            await process_collect_result(taskManager, taskId, scheduleAt, sequence, result, null)
        }
        catch(err) {
            logger.warn(err, "Executing collect task failed for task %s", taskId);
            await process_collect_result(taskManager, taskId, scheduleAt, sequence, null, err)
        }
    }
    
    /**
    * Main loop
    * 1. timing out existing pending tasks
    * 2. scheduling new tasks for execution, now in a RR fashion
    * 
    * for now, let's set task maximum execution time to 2 min, if during
    * this time, the task is scheduled to run again, the schedule will not
    * be done.
    */
    const account_task_schedule_loop = (accountId) => {
        if(state.stalled) {
            return;
        }
        
        const info = state.schedulers[accountId]
        if(info == null) {
            logger.error('Scheduling for non-existing account - ' + accountId)
            return
        }
        
        if(info.lastScheduleEpoch > 0 && (Date.now() - info.lastScheduleEpoch) < 500) {
            // logger.info('Skip scheduling tasks for account - ' + accountId + ' as last scheduling is too recent');
            return;
        }
        
        const taskManager = info.taskManager
        const taskScheduler = info.taskScheduler
        
        //
        // step 2: round-robin task scheduling
        while (true) {
            if(info.serverTasks.length > 0 || taskScheduler.hasNextRunnable()) {
                // logger.info("Try dispatching tasks for account %s...", accountId);
            }
            else {
                // no task to run
                // logger.info("No task to scheduled for account %s...", accountId);                
                break;
            }
            
            
            let worker = 0
            if(state.workers.length > 0) {
                worker = find_idle_worker();
                
                if (!worker) {
                    // logger.info("No idle worker for dispatching tasks for account %s", accountId);
                    
                    // no idle worker, wait next time
                    break;
                }
            }
            
            // logger.info("Try dispatching task for account %s to worker %d...", accountId, worker);
            
            new Promise(async (resolve, reject) => {
                try {
                    // do we have any server scheduled tasks to execute? let's favor them first
                    if(info.serverTasks.length > 0) {
                        const serverTask = info.serverTasks.shift();
                        logger.info("Try dispatching server scheduled task %s for account %s to worker %d...", serverTask.id, accountId, worker);
                        await executeServerScheduledTask(worker, taskManager, serverTask)
                    }
                    else {
                        const sched = taskScheduler.nextRunnable()
                        if(sched) {
                            logger.info("Try dispatching task %s for account %s to worker %d...", sched.task, accountId, worker);
                            const taskId = sched.task;
                            
                            // see if the task schedule exists
                            const task = taskManager.getTask(taskId)
                            if (!task) {
                                throw new Error("Try execute non-existing task - " + accountId + ":" + taskId);
                            }
                            
                            logger.info("Try dispatching task %s:%s for execution (scheduleAt=%d, sequence=%d) ...", accountId, taskId, sched.scheduleAt, sched.sequence);
                            
                            await dispatch_task(worker, taskManager, task, sched.scheduleAt, sched.sequence)
                        }
                    }
                    
                    resolve()
                }
                catch(err) {
                    logger.error(err, "Error processing task for account %s", accountId);
                    reject(err)
                }
            }).finally(() => {
                if(worker > 0) {
                    free_worker(worker);
                }
            })
        }
        
        info.lastScheduleEpoch = Date.now();
    }
    
    /**
    * Run main loop to do task scheduling, etc. for an account
    */
    const start_scheduler = async(account, measurePerformance) => {
        const info = state.schedulers[account] = {
            account: config.account,
            lastScheduleEpoch: 0,
            scheduler: 0,
            lastSyncEpoch: 0,
            synchronizer: 0,
            serverTasks: [],
            taskManager: TaskManager(account),
            taskScheduler: TaskScheduler(account)
        }
        
        logger.info("Try starting scheduler for account - " + account)
        info.scheduler = setInterval(() => account_task_schedule_loop(account), 500);
        
        logger.info("Try starting task synchronizer for account - " + account)
        info.synchronizer = setInterval(() => account_task_sync_loop(account, measurePerformance), 2000);
    }
    
    /**
    * For cloud mode, synchronize accounts and create account schedulers
    */
    const account_synchronizer  = async () => {
        if(state.lastSyncEpoch > 0 && (Date.now() - state.lastSyncEpoch) < 2000) {
            logger.info('Skip syncing account IDs as last sync is too recent');
            return;
        }
        
        try {
            // logger.info('Try syncing account IDs');
            const response = await protocol.getAccountIDs();
            
            const accounts = response.data || []
            const existing = Object.keys(state.schedulers);
            
            const diffs = _.xor(accounts, existing)
            
            // if diff in existing, it is disappearing
            // if diff in accounts, it is newly found
            for (const account of diffs) {
                if(accounts.indexOf(account) >= 0) {
                    logger.info("Start scheduler for new account - " + account);
                    
                    start_scheduler(account, false)
                }
                else {
                    logger.warn("Stop scheduler for disappearing account - " + account);
                    const info = state.schedulers[account] || {}
                    delete state.schedulers[account];
                    
                    if(info.scheduler > 0) {
                        logger.info("Stop and clear scheduler for account - " + account)
                        clearInterval(info.scheduler)
                    }
                    
                    if(info.synchronizer > 0) {
                        logger.info("Stop and clear synchronizer for account - " + account)
                        clearInterval(info.synchronizer)
                    }
                }
            }
        }
        catch(error) {
            logger.error
        }
        finally {
            state.lastSyncEpoch = Date.now();
        }
    }
    
    if(slaves != null) {
        /**
        * When a worker try to get next task to execute, return one
        * @param uid
        * @param request
        * @param ignored
        */
        const handle_poll_task = (uid, request, ignored) => {
            while(true) {
                const queued = state.queued.shift();
                
                if (!queued) {
                    logger.info("No task for execution, send dummy task to worker %d (pending=%d)", uid, state.workerStats[uid].pending);
                    slaves.send(uid, request + "-response", {type: "dummy"});
                    return;
                }
                
                const {type, task, taskId, clock, scheduleAt, sequence} = queued;
                metrics.observe("task_queued_time", clock(), {type})
                
                if (scheduleAt - Date.now() > TASK_TIMEOUT_MS) {
                    logger.warn("Ignore timedout %s task (taskId=%s, sequence=%d)", type, taskId, sequence);
                    continue;
                }
                
                break;
            }
            
            logger.info("Dispatch %s task to worker %d (taskId=%s, pending=%d)", type, uid, queued.taskId, state.workerStats[uid].pending);
            slaves.send(uid, "poll-task-response", {type, task})
            
            state.workerStats[uid].pending++;
        }
        
        const handle_execute_response = (worker, ignored, payload) => {
            const {type, taskId, result, error} = payload
            
            const pendingKey = type + "-" + taskId;
            const task = state.pendings[pendingKey];
            delete state.pendings[pendingKey]
            
            if(!task) {
                logger.error("Got task response from worker %d for unknown task %s", worker, taskId);
                return;
            }
            
            const {uid, sequence, promise} = task;
            
            if(error) {
                logger.info('Got task error from worker %d (type=%s, sequence=%d): %s', worker, type, sequence, error.message)
                promise.reject(error)
            }
            else {
                logger.info('Got task result from worker %d (type=%s, sequence=%d)', worker, type, sequence)
                promise.resolve(result);
            }
        }
        
        /**
        * Connect a chrome instance from a worker
        * @param uid
        * @param type
        * @param payload - uuid and options
        */
        const handle_chrome_open = async (uid, type, payload) => {
            const {uuid, options} = payload;
            
            try {
                logger.info("Try connect chrome instance for worker %d with uuid %s", uid, uuid);
                const chromeOptions = await ChromeWrapper.do_connect(options)
                
                logger.info("Connected chrome instance with port %d", chromeOptions.port)
                slaves.send(uid, type + "-response", {uuid, options: chromeOptions});
            }
            catch(err) {
                logger.error(err, 'Cannot connect chrome instance due to error - ' + err.message)
                slaves.send(uuid, type + "-response", {uuid, err})
            }
        }
        
        /**
        * Disconnect a chrome instance from a worker
        * @param uid
        * @param type
        * @param payload - uuid, options, port
        */
        const handle_chrome_close = async (uid, type, payload) => {
            const {uuid, options, port} = payload;
            
            try {
                logger.info("Try disconnect chrome instance for worker %d with uuid %s and port %d", uid, uuid, port);
                await ChromeWrapper.do_disconnect(options, port)
                
                logger.info("Disconnected chrome instance with port %d", port)
                slaves.send(uid, type + "-response", {uuid, result: true});
            }
            catch(err) {
                logger.error('Cannot disconnect chrome instance due to error - ' + err.message)
                slaves.send(uuid, type + "-response", {uuid, result: false, err})
            }
        }
        
        slaves.on('execute-response', handle_execute_response)
        
        // slave is polling for task execution
        slaves.on('poll-task', handle_poll_task);
        
        /**
        * Help to manage chrome instances
        */
        slaves.on('chrome-open', handle_chrome_open);
        slaves.on('chrome-close', handle_chrome_close);
        
        /**
        * for metrics collection
        */
        const handle_slave_metrics = async (uid, type, payload) => {
            const {sequence, metrics, error} = payload;
            if(sequence !== state.metrics.epoch) {
                logger.error("Ignore metrics unexpected results for sequence " + state.metrics.epoch + " from worker - " + uid + " with sequence " + sequence);
                return;
            }
            
            const promise = state.metrics.pendings[uid]
            if(promise) {
                if(error) {
                    logger.error(error, "Error collect metrics from worker - " + uid);
                    // promise.reject(error);
                    promise.resolve(null)
                }
                else {
                    promise.resolve(metrics)
                }
            }
        }
        
        slaves.on('collect-metrics-response', handle_slave_metrics);
    }
    
    logger.info("Starting HTTPd ...");
    httpd.start();
    
    httpd.register('/metrics', async (req, res) => {
        res.setHeader('Content-Type', metrics.contentType());
        
        if(slaves && state.workers.length === 0) {
            res.body = await metrics.collect([]);
        }
        else {
            const now = Date.now();
            if(state.metrics.epoch < (now - MIN_METRICS_EPOCH)) {
                // collect metrics for each worker and aggregate
                // use current time as sequence
                const sequence = now;
                slaves.broadcast("collect-metrics", {sequence});
                state.metrics.epoch = sequence;
                state.metrics.pendings = {};
                state.metrics.promises = state.workers.map(worker => new Promise((resolve, reject) => {
                    state.metrics.pendings[worker] = timed(resolve, reject, 3000, () => {}, "Cannot collect metrics from worker " + worker)
                }));
            }
            
            const results = await Promise.all(state.metrics.promises);
            res.body = await metrics.collect(results.filter(e => e))
        }
    });
    
    if(config.role !== 'slave') {
        if(config.server?.cloudMode) {
            // working in cloud mode
            state.synchronizer = setInterval(account_synchronizer, 5000)
        }
        else {
            logger.info("Starting main loop to synchronizing with server ...")
            
            start_scheduler(config.account, true)
            // state.schedulers[config.account] = setInterval(main_loop, 500);
            // state.synchronizers[config.account] = setInterval(meta_sync_loop, 2000);
        }
        
        state.heartbeater = setInterval(heartbeat_loop, 60000);
        // make a ping right away to activate the collector if newly installed
        heartbeat_loop();
    }
    else {
        /**
        * If the slave work in sync mode or not. If in sync mode, it shall return
        * all results back to caller in same execute API request. Otherwise, it
        * can choose to return the results back in polling request.
        */
        const syncMode = config.technology?.sync || false
        
        /**
        * Slave mode will only accept requests from master for now.
        */
        logger.info("JS Agent working in slave mode (sync=" + syncMode + ")!")
        
        /**
        * Cache results received from worker.
        * Results are saved per type (collect or discover),
        */
        const pendingResults = [];
        
        /**
        * Handling direct request as a task execution
        * The request is a JSON object like
        * {
        *     tasks: [{
        *        taskId: xxxx,
        *        type: 'discover' || 'collect',
        *        environs: {
        *            taskId: xxx,
        *            scriptId: xxx,
        *            resourceId: xxx,
        *            taskVersion: xxx,
        *        },
        *        params: {
        *            foo: xxx
        *            bar: xxx
        *        },
        *        script: '....'
        *     }, ...],
        *     ...
        * }
        *
        * @param task
        */
        const create_result_entry = (result, error) => {
            const {taskId, type, sequence, output} = result;
            
            const entry = {
                taskId,
                type,
                sequence,
                output,
                code: 0
            };
            
            if (!error) {
                // task finish successfully
                logger.info('Receiving result for technology request %s of type %s with sequence %s ....', taskId, type, sequence);
                entry.output = output;
            } else {
                logger.error(error, 'Encountering error for processing technology request %s of type %s with sequence %s ....', taskId, type, sequence);
                
                if (error instanceof ExecutionError) {
                    entry.output = error.message;
                    entry.code = error.code;
                } else {
                    entry.output = error.message || 'unknown error';
                    entry.code = -1;
                }
            }
            
            return entry;
        }
        
        const handle_requested_task = async (task, results) => {
            const {taskId, type, sequence, scheduleAt, environs, params, script, resource, discovered} = task;
            
            metrics.count("task_requested", 1, {type})
            
            const taskInfo = {
                type,
                script,   // script to execute
                resource,
                environs, // environments variables, like taskId, resourceId, etc.
                params,   // params to pass to script
                scheduleAt,   // schedule time, default to 0 (one time execution?)
                sequence,     // sequence #, default to 0 (not care)
                discovered    // discovered instances
            }
            
            const response = {
                taskId, type, sequence,
            };
            
            try {
                if(state.workers.length === 0) {
                    response.output = await execute_task(0, taskId, type, scheduleAt, sequence, taskInfo);
                }
                else {
                    let worker = 0;
                    let retries = 0;
                    while(retries < 3) {
                        worker = find_idle_worker();
                        if(worker) {
                            break;
                        }
                        
                        logger.info("No idle worker available for task %s, waiting 15s and retry", taskId);
                        
                        // wait 15 seconds and retry
                        await new Promise((resolve) => setTimeout(resolve, 15000));
                        
                        retries++;
                    }
                    
                    try {
                        response.output = await execute_task(worker, taskId, type, scheduleAt, sequence, taskInfo);
                    } finally {
                        free_worker(worker);
                    }
                }
                
                results.push(create_result_entry(response, null))
            }
            catch (err) {
                results.push(create_result_entry(response, err))
            }
        }
        
        const requestHandler = async (req, res) => {
            const reqData = JSON.parse(req.body);
            const tasks = reqData.tasks || [];
            
            // receive the results
            const results = [];
            const promises = [];
            for (const task of tasks) {
                promises.push(handle_requested_task(task, syncMode ? results : pendingResults))
            }
            
            // return results in a json object like
            // {
            //    status: 200,
            //    message: "OK",
            //    results: [{                  -- optional, if any results to report
            //        taskId: xxx,
            //        code: exitCode or zero    -- optional, missing taking as 0 (success)
            //        output: xxxx              -- required if result presents, a string representation of the output
            //        ...
            //    }, ....]
            // }
            
            if(syncMode) {
                await Promise.all(promises);
            }
            
            res.body = JSON.stringify({
                status: 200,
                message: "OK",
                results,
            }, null, 3);
        }
        
        const resultHandler = (req, res) => {
            // TODO: now we remove just limited # of entries to avoid problem
            const results = pendingResults.splice(0, 50)
            
            if(results.length > 0) {
                logger.info('Sending back %d results ...', results.length);
            }
            
            res.body = JSON.stringify({
                status: 200,
                message: "OK",
                results,
            }, null, 3);
        }
        
        /**
        * For each active servicing technology, it provides two APIs
        * 1. one for receiving requests and
        * 2. the other for polling results
        *
        * It is up to the technology's implementation to support sync or async
        * semantics:
        * 1. If it always returns results in same request API, it is synchronous
        * 2. Otherwise, it is asynchronous since the results would be retrieved in result API
        *
        * For JS Agent, we support  asynchronous way. When requests received, it will be
        * scheduled to workers and return 200. For worker results, it is cached and returned
        * in next received result API
        */
        httpd.register('/api/technology/request', requestHandler);
        httpd.register('/api/technology/result', resultHandler);
    }
}
