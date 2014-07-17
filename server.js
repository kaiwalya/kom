var logger = require('bunyan').createLogger({name: "web", level: "debug"});

var initLogger = logger.child({phase: "init"});
initLogger.info("start");

var express = require('express');
var App = require('./lib/app.js').App;

var app = new App({
	router: express(),
	logger: initLogger
});

var port = process.env.PORT || 8000;
app.serve(port, function (err) {
	if (err) {
		initLogger.info("stop", err);
		return;
	}
	initLogger.info("stop");
	app.setLogger(logger);
	logger.info("ready");
});
