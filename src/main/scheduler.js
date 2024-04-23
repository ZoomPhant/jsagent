/**
* Manage task scheduling, etc.
*/
const _ = require('lodash')
const version = require('libs/version')
const config = require('libs/config')
const protocol = require('src/protocol')

const logger = require('libs/logger').get('scheduler')


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
    /** 
    * task schedules, a sorted list so we always remove tasks from top and put it back 
    * Element in the array is an schedule object like
    *   {
    *      task: taskId,
    *      uid: workerId,          // which worker this task is scheduled to
    *      sequence: 0,            // starting from 0
    *      scheduleAt: epochMs,
    *      interval: intervalMs
    *   }
    */
    schedules: [],
}

/**
* Get a random start time for new task
*/
const getRandomStart = (interval) => {
    return Math.floor(Math.random() * interval);
}

/**
* Sync tasks info from server
*/
const scheduleAll = tasks => {
    logger.info("Try scheduling %d tasks ...", tasks.length)
    
    // 
    // existing task schedules. A task is either in schedules or in pendings
    // If it is in pendings, we just ignore re-calculating the schedules,
    // since the task's next schedule epoch will be calculated automatically
    // when current pending execution timedout or finish
    const existing = (state.schedules || []).reduce((map, item) => {
        map[item.task] = item
        return map
    }, {});
    
    state.tasks = {};
    
    // If there's any task is new or need update, we just do the reschedule
    const schedules = []
    tasks.forEach(task => {
        if (!task) {
            // cannot happen
            return;
        }
        
        /**
        * JS collector not support one time task ...
        */
        if (task.frequency <= 0) {
            logger.warn("Ignore task %s with zero or negative frequency %d!", task.id, task.frequency)
        }
        else {
            const collect = existing[task.id] || {};
            
            logger.info('Try scheduling task %s with resource %s and script %s', task.id, task.resourceId, task.scriptId)

            const interval = task.frequency * 1000

            // if the task has been scheduled before, we try to keep the scheduleAt and sequence information
            schedules.push({
                task: task.id,
                scheduleAt: collect.scheduleAt || Date.now() + getRandomStart(interval),
                sequence: collect.sequence || 0,
                interval
            });
        }
    })
    

    // we have new tasks, so let's resort existing schedules to add in the new tasks
    // for task in pending, it will be done when the task execution timeout or finish
    state.schedules = _.sortBy(schedules, 'scheduleAt')
}

/**
* Put the task to the schedules for next execution
*/
const SCHEDULE_TOLERANCE = 15 * 1000; // in milliseconds
const scheduleNext = (taskId, lastScheduleAt, lastSequence, interval) => {
    logger.info('Try schedule task %s for next execution (lastScheduleAt=%d, lastSequence=%d, interval=%d', taskId, lastScheduleAt, lastSequence, interval)
    const now = Date.now()
    let scheduleAt = lastScheduleAt + interval;
    let sequence = lastSequence + 1
    while (true) {
        const sched = { task: taskId, scheduleAt, sequence, interval };
        
        if (scheduleAt >= now) {
            logger.info("Schedule task for next execution at %d (task=%s, sequence=%d)", scheduleAt, taskId, sequence);
            // not time to execute yet, let's put into queue
            state.schedules.splice(_.sortedIndexBy(state.schedules, sched, 'scheduleAt'), 0, sched);
            return;
        }
        
        // scheduleAt is at past!!! But if we don't lag for too long, let's try to execute it by put it on top directly
        if (scheduleAt > (now - SCHEDULE_TOLERANCE)) {
            logger.info("Schedule task for immediate execution (task=%s, sequence=%d, missed=%d)", taskId, sequence, (now - scheduleAt));
            state.schedules.unshift(sched);
            return;
        }
        
        logger.warn('Find task %s missed one execution at %d (sequence=%d, missed=%d). Reschedule for next time.', taskId, scheduleAt, sequence, (now - scheduleAt))

        // else, task has missed too much, skip current execution
        scheduleAt = scheduleAt + interval;
        sequence = sequence + 1;
    }
}

/**
 * Get next runnable task (i.e. scheduleAt <= now), return null if none
 */
const nextRunnable = () => {
    if(state.schedules.length <= 0) {
        return null
    }

    const now = Date.now()
    const sched = state.schedules[0]
    if (sched.scheduleAt > now) {
        return null
    }

    logger.info('Found runnable task %s (total=%d)', sched.task, state.schedules.length)

    // get rid of this one as it will be execute and reschedue it
    state.schedules.shift();

    // re-schedule for next check
    scheduleNext(sched.task, sched.scheduleAt, sched.sequence, sched.interval)

    return sched;
}

module.exports = {
    scheduleAll, nextRunnable
}