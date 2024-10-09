/**
* Worker is dummy. It would
* 1. wait for "tasks" notification
* 2. race for task assignment
* 3. execute the task
* 4. report data, and then loop back
*/
const _ = require('lodash')
const timed = require('libs/timed')
const config = require('libs/config');
const Logger = require('libs/logger')
const metrics = require('libs/metrics')
const {executeScriptTask}  = require('src/scripts')
const ChromeWrapper = require('./chrome')

module.exports = (runtime) => {
    const logger = Logger.get('worker-' + runtime.uid)

    metrics.init("worker");
    metrics.counter("task_requested", "Total requests received from master", ["type"]);
    metrics.counter("task_success", "Total success task executions", ["type"]);
    metrics.counter("task_failure", "Total failed task executions", ["type"])

    metrics.histogram("task_execute_time", "Time spent in executing in milliseconds", [5000, 15000, 30000, 60000], ["type"]);

    logger.info('Worker started')

    /**
     * Payload is a JSON object like
     *   {
     *       script,   // script to execute
     *       environs, // environments variables, like taskId, resourceId, etc.
     *       params,   // params to pass to script
     *       scheduleAt,   // schedule time, default to 0 (one time execution?)
     *       sequence,     // sequence #, default to 0 (not care)
     *       discovered    // discovered instances
     *   }
     * @param type
     * @param payload
     * @returns {Promise<void>}
     */
    const handle_task = async (ignored, payload) => {
        const {environs: {taskId}, type, sequence} = payload

        metrics.count("task_requested", 1, {type});
        logger.info('Try handle %s task %s with sequence %s ...', type, taskId, sequence)

        const clock = metrics.clock();
        try {
            const result = await executeScriptTask(type, payload, new ChromeWrapper(runtime), {logger});

            metrics.count("task_success", 1, {type});
            logger.info('Report execution success for %s task %s with sequence %s', type, taskId, sequence)
            runtime.send('execute-response', {type, taskId, result})
        }
        catch(error) {
            logger.error('Report execution error for %s task %s with sequence %s: %s', type, taskId, sequence, error.message)
            metrics.count("task_failure", 1, {type});
            runtime.send('execute-response', {type, taskId, error})
        }
        finally {
            metrics.observe("task_execute_time", clock(), {type})
        }
    }

    runtime.on('execute', handle_task)
    runtime.on('chrome-open-response', ChromeWrapper.on_open_response);
    runtime.on('chrome-close-response', ChromeWrapper.on_close_response);
    runtime.on('collect-metrics', async (ignored, payload) => {
        const {sequence} = payload;

        logger.info('Try get metrics with sequence - ' + sequence);

        try {
            const json = await metrics.asJson();
            runtime.send('collect-metrics-response', {sequence, metrics: json});
        }
        catch(error) {
            runtime.send('collect-metrics-response', {sequence, error});
        }
    })

    if(config.isWorkerPassive()) {
        logger.info("Worker started in passive mode");
    }
    else {
        /**
         * Scheduling with worker poll:
         *
         * Workers working in active mode to poll for tasks for execution instead of waiting master
         * to assign a task
         */

        const state = {
            retries: 0,
            promise: null,
        }

        /**
         * Send poll-task to master and expect to receive poll-task-response
         *   poll-task: param empty for now
         *   poll-task-response: {type, payload}
         */
        const fetch_task = async () => {
            runtime.send("poll-task", {})

            return new Promise((resolve, reject) => {
                // don't wait too long
                state.promise = timed(resolve, reject, 3000, () => {}, "Timeout polling task");
            })
        }

        const handle_poll_task_response = async (ignored, response) => {
            const {err} = response;

            const promise = state.promise;
            state.promise = null;
            if (!promise) {
                // no promise? this cannot happen!!!
                logger.error("Worker got poll task response without promise!!!")
                process.exit(1);
            }

            if (err) {
                logger.info("Error fetching task from server - " + err.message)
                promise.reject(err);
                return;
            }

            promise.resolve(response)
        }

        runtime.on('poll-task-response', handle_poll_task_response);

        const main_loop = async () => {
            while (state.retries < 3) {
                try {
                    const response = await fetch_task();
                    const {type, task} = response;

                    if (type === 'dummy') {
                        // no task to execute
                        logger.info("Worker idle, sleep 15 seconds to retry");
                        await new Promise(r => setTimeout(r, 15000));
                        continue
                    }

                    logger.info("Got %s task from master, execute task", type)

                    await handle_task(type, task);

                    state.retries = 0;
                } catch (err) {
                    logger.error(err, "Got unexpected error, retries - " + state.retries);
                    state.retries++;
                }
            }

            logger.error("Worker failed with too many retries!");

            process.exit(255)
        }

        // start main loop a little bit later to give time for worker warming up
        setTimeout(() => {
            logger.info("Worker start polling for tasks ...")
            main_loop();
        }, 3000);
    }
}