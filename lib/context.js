var crypto = require('crypto');
var URI = require('url');
var QUERY = require('querystring');


var RequestContext = function (globalContext) {
	this._globalContext = globalContext;
	this._logger = globalContext.app().logger();
	this._requestIndex = globalContext.requestIndex();
};

RequestContext.prototype.logger = function () {
	return this._logger;
};

RequestContext.prototype._setLogger = function (logger) {
	this._logger = logger;
};

RequestContext.prototype.requestId = function () {
	return this._requestId;
};

RequestContext.prototype.req = function () {
	return this._req;
};

RequestContext.prototype.res = function () {
	return this._res;
};

RequestContext.prototype.parsedUrl = function () {
	var This = this;
	var req = This.req();
	if (!This._parsedUrl) {
		This._parsedUrl = URI.parse(req.path); 
		if (This._parsedUrl.query) {
			This._parsedUrl.query = QUERY.parse(This._parsedUrl.query);
		}
	}
	return This._parsedUrl;
};

RequestContext.prototype.requestIndex = function () {
	return this._requestIndex;
};

RequestContext.prototype.app = function () {
	return this._globalContext.app();
};

RequestContext.prototype._logStart = function () {
	var This = this;
	var req = This._req;
	var reqInfo = {
		method: req.method,
		url: req.url
	};
	if (This.logger().level() <= 20) {
		reqInfo.tick = This._startTick;
		reqInfo.url = This.parsedUrl();
		reqInfo.headers = req.headers;
	}
	This.logger().info("start", reqInfo);
};

RequestContext.prototype._logStop = function (req, res) {
	var This = this;

	var deltaNS = "" + (This._stopTick - This._startTick) * 1e-6 + " ms";

	var resInfo = {
		statusCode: res.statusCode,
		deltaT: deltaNS,
	};

	if (This.logger().level() <= This.logger().DEBUG) {
		resInfo.tick = This._stopTick;
		resInfo.headers = res._headers;
	}

	This.logger().info("stop", resInfo);
};

RequestContext.prototype.attach = function (req, res, callback) {
	var This = this;

	var startTick = process.hrtime();
	This._startTick = startTick[0] * 1e+9 + startTick[1];

	var bytes = crypto.randomBytes(24);
	This._requestId = bytes.toString('base64');
	This._setLogger(This.app().childLogger(This.logger(), {
		reqId: This.requestId(),
		reqIdx: This.requestIndex()
	}));
	
	This._req = req;
	This._res = res;

	This._logStart();
	
	
	req._ctx = This;
	res._ctx = This;

	var ctxGetter = function () {
		return this._ctx;
	};

	req.ctx = res.ctx = ctxGetter;
	
	res.setHeader('X-Request-Id', This._requestId);
	return callback();
};

RequestContext.prototype.detach = function (callback) {
	var This = this;
	var req = This.req();
	var res = This.res();
	delete req._ctx;
	delete res._ctx;
	delete This._req;
	delete This._res;

	var stopTick = process.hrtime();
	This._stopTick = stopTick[0] * 1e+9 + stopTick[1];
	This._logStop(req, res);
	return callback();
};

RequestContext.prototype.setModel = function (model) {
	var This = this;
	This._model = model;

	if (!This._model.statusCode) {
		This._model.statusCode = 200;
	}

	if (!This._model.headers) {
		This._model.headers = {};
	}
};

RequestContext.prototype.getModel = function () {
	var This = this;
	return This._model;
};

var GlobalContext = function (app) {
	var This = this;
	This._app = app;
	This._requestIndex = 0;

	This.initializer = function (req, res, callback) {
		This._requestIndex++;
		var ctx = new RequestContext(This);
		return ctx.attach(req, res, callback);
	};

	This.finalizer = function (req, res, callback) {
		req.ctx().detach(callback);
	};
};

GlobalContext.prototype.requestIndex = function () {
	var This = this;
	return This._requestIndex;
};

GlobalContext.prototype.app = function() {
	return this._app;
};

exports.Context = GlobalContext;
