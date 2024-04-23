/**
 * A helper class to help report data in correct format
 *
 * Note: we differentiate value not exist and value is NaN, since JSON won't serialize
 *       a NaN field, we do this by adding isNaN:
 *       value = NaN & isNaN = false: this sample has missing value
 *       value = NaN & isNaN = true:  this sample has a NaN value
 */

/**
 * Decide if the value is NaN.
 *
 * If the value has value (not NaN), return false, otherwise check if missing
 * is set, if set, return false, otherwise the value is really NaN value
 *
 * @param value
 * @param missing
 * @returns {boolean|*}
 */
const isValueNaN = (value, missing) => {
    return isNaN(value) && !missing;
}

/**
 * The reverse of above. If value is not NaN, this value is not missing. Otherwise
 * if the isNaN is false, it is missing (otherwise it is a real NaN value)
 * @param value
 * @param valueIsNaN
 * @returns {boolean}
 */
const isValueMissing = (value, valueIsNaN) => {
    return isNaN(value) && !valueIsNaN
}

/**
 * A helper to generate metric to be added to metrics of reportMetrics API
 * 
 * const metrics = []
 * 
 * metrics.push(metric(cpuUsage, 1.0).label('host', 'foo').label('service', 'xxx').get());
 *
 * One entry in dataEntry of JsonFormationData, refer to Java agent JsonFormationData
 */
const metric = (name, value, missing, epoch) => {
    const metricData = {
        metricName: name,
        epoch: epoch || Date.now(),
        labels: {},
        isNaN: isValueNaN(value, missing),
        value,
    }

    const wrapper = {
        get: () => metricData,

        label: (name, value) => {
            metricData.labels[name] = value
            return wrapper;
        },

        value: (value, missing) => {
            metricData.value = value
            metricData.isNaN = missing === 'undefined' ? isNaN(value) : missing
            return wrapper
        },

        timestamp: (epoch) => {
            metricData.epoch = epoch;
            return wrapper;
        }
    }

    return wrapper;
}

/**
 * a log chunk, with one or more lines
 *
 * One entry of logEntries in JsonFormationData
 */
const chunk = () => {
    const chunkData = {
        tags: {},
        logs: [],
    }

    const wrapper = {
        get: () => chunkData,

        label: (name, value) => {
            chunkData.tags[name] = value
            return wrapper
        },

        append: (timestamp, line) => {
            chunkData.logs.push({timestamp, line});
            return wrapper;
        },
    }

    return wrapper;
}

/**
 * A event
 */
const event = (eid, stateful, manual) => {
    const evData = {
        eid,
        data: '',
        level: 'info',
        stateful: stateful || false,
        manual: manual || false,
        state: 0,
        timestamp: Date.now(),
        category: '',
        catalogs: [],
        tags: {}
    }

    const wrapper = {
        get: () => evData,

        data: (data) => {
            evData.data = data
            return wrapper
        },

        state: (state) => {
            evData.state = (state === undefined) ? 0 : state
            return wrapper
        },

        category: (category) => {
            evData.category = category;
            return wrapper
        },

        /**
         * We may pass EventLevel object in, thus let's try calling Object.toString
         * @param level
         * @returns {any}
         */
        level: (level) => {
            evData.level = level?.toString()
            return wrapper
        },

        timestamp: (epoch) => {
            evData.timestamp = epoch
            return wrapper
        },

        label: (name, value) => {
            evData.tags[name] = value
            return wrapper
        },

        catalogs: (cats) => {
            if(Array.isArray(cats)) {
                evData.catalogs.push(...cats)
            }
            else {
                evData.catalogs.push(cats)
            }

            return wrapper

        }
    }

    return wrapper;
}

class ReportFormatter {
    /**
     * Same format as JsonFormationData in Java collector
     */
    constructor() {
        this.metricPrefix = '';       // metric prefix, prepend to all metrics added
        this.labels = {}        // common labels, add to all metrics or logs or events if that tag not exists
        this.dataEntries = [];
        this.eventEntries = [];
        this.logEntries = [];
        this.outputParams = {}
    }

    // add common labels
    label(k, v) {
        this.labels[k] = v;
    }

    prefix(p) {
        this.metricPrefix = p || ''
    }

    addMetric(m) {
        m.labels = {
            ...this.labels,
            ...m.labels
        }

        this.dataEntries.push({
            ...m,
            metricName: this.metricPrefix + m.metricName,
            labels: {
                ...this.labels,
                ...m.labels
            }
        });
    }

    /**
     * If metric already exists, try to update it. Assume the metric with same
     * name shall always have the same labels!!!!
     *
     * This only update metric value & epoch, etc.
     */
    updateMetric(metric, epoch) {
        if(this.updateMetric(metric.metricName, metric.value, isValueMissing(metric.value, metric.isNaN), epoch)) {
            return;
        }

        this.addMetric(metric)
    }

    /**
     * return true if updated, false otherwise
     * @param metricName
     * @param value
     * @param missing
     * @param epoch
     */
    updateMetric(metricName, value, missing, epoch) {
        for(let i = 0; i < this.dataEntries.length; i++) {
            if(this.dataEntries[i].metricName === this.metricPrefix + metricName) {
                this.dataEntries[i].value = value
                this.dataEntries[i].isNaN = isValueNaN(value, missing)
                if(epoch !== undefined) {
                    this.dataEntries[i].epoch = epoch || Date.now()
                }

                return true
            }
        }

        return false
    }

    addEvent(e) {
        e.tags = {
            ...this.labels, ...e.tags
        }

        this.eventEntries.push(e);
    }

    /**
     * Like above updateMetric, but for event
     * Only update event's level, data & state
     */
    updateEvent(e) {
        for(let i = 0; i < this.eventEntries.length; i++) {
            if(this.eventEntries[i].eid === e.eid) {
                this.eventEntries[i].level = e.level
                this.eventEntries[i].data = e.data
                this.eventEntries[i].state = e.state;
                this.eventEntries[i].timestamp = e.timestamp;

                return;
            }
        }

        this.addEvent(e)
    }

    addChunk(c) {
        c.tags = {
            ...this.labels, ...c.tags
        }

        this.logEntries.push(c)
    }

    setParam(k, v) {
        this.outputParams[k] = v;
    }

    json() {
        return {
            dataEntries: this.dataEntries,
            eventEntries: this.eventEntries,
            logEntries: this.logEntries,
            outputParams: this.outputParams
        }
    }
}

const formatter = () => {
    return new ReportFormatter();
}

module.exports = {
    formatter, metric, chunk, event
}