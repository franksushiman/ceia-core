const EventEmitter = require("events");

// Singleton compartilhado por toda a app
const ceiaEmitter = new EventEmitter();

module.exports = { ceiaEmitter };
