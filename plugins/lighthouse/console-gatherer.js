const Logger = require('libs/logger')

module.exports = import('lighthouse').then(({Gatherer}) => {
    const logger = Logger.get("audit")

    /**
     * @param {LH.Crdp.Runtime.RemoteObject} obj
     * @return {string}
     */
    function remoteObjectToString(obj) {
        if (typeof obj.value !== 'undefined' || obj.type === 'undefined') {
            return String(obj.value);
        }
        if (typeof obj.description === 'string' && obj.description !== obj.className) {
            return obj.description;
        }
        const type = obj.subtype || obj.type;
        const className = obj.className || 'Object';
        // Simulate calling String() on the object.
        return `[${type} ${className}]`;
    }

    class ConsoleMessages extends Gatherer {
        /** @type {LH.Gatherer.GathererMeta} */
        meta = {
            supportedModes: ['timespan', 'navigation'],
        };

        constructor() {
            super();
            /** @type {LH.Artifacts.ConsoleMessage[]} */
            this._logEntries = [];
            this._hasDebugOrTrace = false;

            this._onConsoleAPICalled = this.onConsoleAPICalled.bind(this);
            this._onExceptionThrown = this.onExceptionThrown.bind(this);
            this._onLogEntryAdded = this.onLogEntry.bind(this);
        }

        /**
         * Handles events for when a script invokes a console API.
         * @param {LH.Crdp.Runtime.ConsoleAPICalledEvent} event
         */
        onConsoleAPICalled(event) {
            const {type} = event;

            if(type === 'verbose' || type === 'trace' || type === 'debug') {
                // let's skip debug, but give some kind of warning
                this._hasDebugOrTrace = true;
                return;
            }

            /** @type {LH.Crdp.Runtime.RemoteObject[]} */
            const args = event.args || [];

            const text = args.map(remoteObjectToString).join(' ');
            if (!text && !event.stackTrace) {
                // No useful information from Chrome. Skip.
                return;
            }

            const {url, lineNumber, columnNumber} =
            event.stackTrace?.callFrames[0] || {};

            logger.debug("Found console log for url - " + url)

            /** @type {LH.Artifacts.ConsoleMessage} */
            const consoleMessage = {
                eventType: 'consoleAPI',
                source: 'console.' + type,
                level: type === 'log' ? 'info' : type,
                text,
                timestamp: event.timestamp,
                url,
                lineNumber,
                columnNumber,
            };
            this._logEntries.push(consoleMessage);
        }

        /**
         * Handles exception thrown events.
         * @param {LH.Crdp.Runtime.ExceptionThrownEvent} event
         */
        onExceptionThrown(event) {
            const text = event.exceptionDetails.exception ?
                event.exceptionDetails.exception.description : event.exceptionDetails.text;
            if (!text) {
                return;
            }

            logger.debug("Found exception log for url - " + event.exceptionDetails.url)

            /** @type {LH.Artifacts.ConsoleMessage} */
            const consoleMessage = {
                eventType: 'exception',
                source: 'exception',
                level: 'error',
                text,
                stackTrace: event.exceptionDetails.stackTrace,
                timestamp: event.timestamp,
                url: event.exceptionDetails.url,
                scriptId: event.exceptionDetails.scriptId,
                lineNumber: event.exceptionDetails.lineNumber,
                columnNumber: event.exceptionDetails.columnNumber,
            };
            this._logEntries.push(consoleMessage);
        }

        /**
         * Handles browser reports logged to the console, including interventions,
         * deprecations, violations, and more.
         * @param {LH.Crdp.Log.EntryAddedEvent} event
         */
        onLogEntry(event) {
            const {source, level, text, stackTrace, timestamp, url, lineNumber} = event.entry;

            if(level === 'verbose' || level === 'trace' || level === 'debug') {
                // ignore verbose
                return;
            }

            logger.debug("Found browser log for url - " + url)

            // JS events have a stack trace, which we use to get the column.
            // CSS/HTML events only expose a line number.
            const firstStackFrame = event.entry.stackTrace?.callFrames[0];

            this._logEntries.push({
                eventType: 'protocolLog',
                source,
                level: level === 'warning' ? 'warn' : level,
                text,
                stackTrace,
                timestamp,
                url,
                scriptId: firstStackFrame?.scriptId,
                lineNumber,
                columnNumber: firstStackFrame?.columnNumber,
            });
        }

        /**
         * @param {LH.Gatherer.Context} passContext
         */
        async startInstrumentation({driver, page}) {
            const session = driver.defaultSession;

            session.on('Log.entryAdded', this._onLogEntryAdded);
            await session.sendCommand('Log.enable');
            await session.sendCommand('Log.startViolationsReport', {
                config: [{name: 'discouragedAPIUse', threshold: -1}],
            });

            session.on('Runtime.consoleAPICalled', this._onConsoleAPICalled);
            session.on('Runtime.exceptionThrown', this._onExceptionThrown);
            await session.sendCommand('Runtime.enable');
        }

        /**
         * @param {LH.Gatherer.Context} passContext
         * @return {Promise<void>}
         */
        async stopInstrumentation({driver, page}) {
            logger.info("######## Stop log instrumentation ...")
            await driver.defaultSession.sendCommand('Log.stopViolationsReport');
            await driver.defaultSession.off('Log.entryAdded', this._onLogEntryAdded);
            await driver.defaultSession.sendCommand('Log.disable');
            await driver.defaultSession.off('Runtime.consoleAPICalled', this._onConsoleAPICalled);
            await driver.defaultSession.off('Runtime.exceptionThrown', this._onExceptionThrown);
            await driver.defaultSession.sendCommand('Runtime.disable');
        }

        /**
         * @return {Promise<LH.Artifacts['ConsoleMessages']>}
         */
        async getArtifact() {
            return {
                hasDebug: this._hasDebugOrTrace,
                entries: this._logEntries
            };
        }
    }

    return ConsoleMessages;
})
