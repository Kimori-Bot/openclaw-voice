/**
 * Logger module - Unified logging with file + console output
 */
function setupLogging() {
    const LOG_FILE = '/tmp/openclaw-voice.log';
    
    const formatLog = (level, ...args) => {
        const timestamp = new Date().toISOString();
        const message = args.join(' ');
        const logEntry = JSON.stringify({ timestamp, level, message }) + '\n';
        
        if (level === 'ERROR') {
            console.error(`[${timestamp}] ERROR:`, ...args);
        } else {
            console.log(`[${timestamp}]`, ...args);
        }
        
        try {
            fs.appendFileSync(LOG_FILE, logEntry);
        } catch (e) {
            // Ignore file write errors
        }
        
        return logEntry;
    };
    
    const logger = {
        info: (...args) => formatLog('INFO', ...args),
        warn: (...args) => formatLog('WARN', ...args),
        error: (...args) => formatLog('ERROR', ...args),
        debug: (...args) => {
            if (process.env.DEBUG) formatLog('DEBUG', ...args);
        }
    };
    
    return logger;
}

module.exports = { setupLogging };
