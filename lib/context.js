var crypto = require('crypto');

var Context = function () {};

Context.prototype.attach = function (req, res, callback) {
	var This = this;
	This._req = req;
	This._res = res;
	req._ctx = This;
	res._ctx = This;

	var ctxGetter = function () {
		return this._ctx;
	};

	req.ctx = res.ctx = ctxGetter;
	
	This.date = new Date();
	This.startTime = process.hrtime();
	crypto.randomBytes(48, function (err, bytes) {
		This.requestId = bytes.toString('base64');
		res.header('X-Request-Id', This.requestId);
		return callback();
	});
};

Context.prototype.req = function () {
	return this._req;
};

Context.prototype.res = function () {
	return this._res;
};

Context.prototype.detach = function (callback) {
	var This = this;
	var req = This.req();
	var res = This.res();
	delete req._ctx;
	delete res._ctx;
	delete This._req;
	delete This._res;

	This.stopTime = process.hrtime();
	var deltaTNS = Math.round(1e+6 * (This.stopTime[0] - This.startTime[0]) + 1e-3 * (This.stopTime[1] - This.startTime[1]));

	console.log(This.requestId, deltaTNS, "µS");
	return callback();
};

exports.initializer = function (req, res, callback) {
	var ctx = new Context();
	return ctx.attach(req, res, callback);
};

exports.finalizer = function (req, res, callback) {
	req.ctx().detach(callback);
};