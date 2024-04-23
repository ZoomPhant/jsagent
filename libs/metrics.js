const client = require('prom-client')
const logger = require('libs/logger').get('metrics');

// Always using global register for easer operations
const register = client.register;

client.collectDefaultMetrics({ register })

/**
 * Metrics used in system.
 * Here we will have just gauge metrics in our system, counters are special gauges
 * that always increasing
 *
 * Histogram is not supported for now
 */
const metrics = {
}

const createMetric = (type, name, help, options) => {
    if(metrics.hasOwnProperty(name)) {
        throw new Error(`Metric with name ${name} already exists. Please use another name`);
    }

    let metric;
    switch (type) {
        case 'counter':
            metric = new client.Counter({name, help, ...options});
            break;
        case 'gauge':
            metric = new client.Gauge({name, help, ...options});
            break;
        case 'histogram':
            metric = new client.Histogram({name, help, ...options});
            break;
        default:
            throw new Error(`Unsupported metric type: ${type}`);
    }

    metrics[name] = metric;
    return metric;
};

/**
 * Peg a counter with given names
 * @param name - name of counter
 * @param value - value of counter, default to 1 (increase)
 * @param labels - extra labels
 */
const count = (name, value, labels) => {
    const counter = metrics[name];
    if(!counter || counter.type !== 'counter') {
        logger.error('Metric ' + name + ' is not a counter');
        return;
    }

    if(labels) {
        counter.inc(labels, value);
    }
    else {
        counter.inc(value);
    }
}

/**
 * Like counter but create gauge
 * @param name
 * @param value
 * @param labels
 */
const peg = (name, value, labels) => {
    const gauge = metrics[name];
    if(!gauge || gauge.type !== 'gauge') {
        logger.error('Metric ' + name + ' is not a gauge');
        return;
    }

    if(labels) {
        gauge.set(labels, value)
    }
    else {
        gauge.set(value);
    }
}

/**
 * Histogram
 * @param name
 * @param value
 * @param labels
 */
const observe = (name, value, labels) => {
    const histogram = metrics[name];
    if(!histogram || histogram.type !== 'histogram') {
        logger.error('Metric ' + name + ' is not a histogram');
        return;
    }

    if(labels) {
        histogram.observe(labels, value);
    }
    else {
        histogram.observe(value);
    }
}

/**
 * Start a timer and on call, return the elapsed time in milliseconds
 * @returns {function(): *}
 */
const clock = (asSeconds) => {
    const start = process.hrtime();

    return () => {
        const delta = process.hrtime(start)
        if(asSeconds) {
            // seconds
            return delta[0] + delta[1] / 1e9;
        }
        else {
            // milliseconds
            return delta[0] * 1000 + delta[1] / 1e6;
        }
    }
}

/**
 * Called at master side
 * Give workers, collect all metrics
 */
const collect = async (workers) => {
    if(!workers || workers.length === 0) {
        // no workers
        return await register.metrics();
    }

    // add in master
    const arr = [await register.getMetricsAsJSON(), ...workers]

    return await client.AggregatorRegistry.aggregate(arr).metrics();
}

/**
 * Initialize a metrics with given name and collect default metrics
 * @param name
 * @returns {Registry}
 */
module.exports = {
    init: (name) => {
        register.setDefaultLabels({
            pid: process.pid, name
        })
    },

    contentType: () => {
        return register.contentType;
    },

    asJson: async () => {
        return register.getMetricsAsJSON();
    },

    counter: (name, help, labelNames = []) => createMetric('counter', name, help, {labelNames}),

    gauge: (name, help, labelNames = []) => createMetric('gauge', name, help, {labelNames}),

    histogram: (name, help, buckets, labelNames = []) => createMetric('histogram', name, help, {buckets, labelNames}),

    collect, clock, count, peg, observe,
};
