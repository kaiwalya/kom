var bunyan = require('bunyan');
var stream = require('stream');
var util = require('util');
var loggly = require('loggly');

var LogglyStream = function (config) {
	this._loggly = loggly.createClient(config);
	stream.Writable.call(this);
};

util.inherits(LogglyStream, stream.Writable);

LogglyStream.prototype.write = function (chunk) {
	this._loggly.log(chunk);	
};

var Logger = function (config, inBunyan) {
	this._config = config;
	this._bunyan = inBunyan;
	if (!this._bunyan) {
		this._bunyan = bunyan.createLogger({
			name: "web",
			streams: [{
				type: "raw",
				stream: new LogglyStream(config)
			},{
				stream: process.stdout
			}],
			level: "debug"
		});
	}
};

Logger.prototype._preProcess = function () {
	if (!arguments || arguments.length === 0) {
		return [];
	}
	if (arguments.length === 1) {
		return [{
			message: arguments[0]
		}];
	}
	else {
		return [{
			message: arguments
		}];
	}
};

Logger.prototype.child = function (obj) {return new Logger(this._config, this._bunyan.child(obj));};
Logger.prototype.trace = function () {this._bunyan.trace.apply(this._bunyan, this._preProcess(arguments));};
Logger.prototype.debug = function () {this._bunyan.debug.apply(this._bunyan, this._preProcess(arguments));};
Logger.prototype.info = function () {this._bunyan.info.apply(this._bunyan, this._preProcess(arguments));};
Logger.prototype.warn = function () {this._bunyan.warn.apply(this._bunyan, this._preProcess(arguments));};
Logger.prototype.error = function () {this._bunyan.error.apply(this._bunyan, this._preProcess(arguments));};
Logger.prototype.level = function () {return this._bunyan.level();};

exports.Logger = Logger;
