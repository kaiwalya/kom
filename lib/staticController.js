var fs = require('fs');
var path = require('path');

var mime = require('mime');

var StaticController = function (dirReal, dirVirtual, defaultPostfix) {
	if (!dirReal) {
		dirReal = "./";
	}
	if (!dirVirtual) {
		dirVirtual = "/";
	}
	this._dirReal = path.normalize(dirReal);
	this._dirVirtual = dirVirtual;
	this._defaultPostfix = path.normalize(defaultPostfix);
};

StaticController.prototype._serveNotFound = function (ctx, callback) {
	ctx.setModel({statusCode: 404, body: "Cannot find resource"});
	return callback();
};

StaticController.prototype._serve = function (ctx, finalPath, callback) {
	var logger = ctx.logger();
	var mimeType = mime.lookup(finalPath);
	logger.debug("StaticController, looking up mimetype for ", finalPath, "=", mimeType);

	ctx.setModel({
		statusCode: 200,
		body: fs.createReadStream(finalPath),
		headers: {
			"Content-Type": mimeType
		}
	});
	return callback();	
};

StaticController.prototype._resolveAndServe = function (ctx, finalPath, callback) {
	var This = this;
	var logger = ctx.logger();
	return fs.exists(finalPath, function (exists) {
		if (!exists) {
			return This._serveNotFound(ctx, callback);
		}
		return fs.stat(finalPath, function (err, stat) {
			if (err) {
				logger.error("StaticController, error getting stat", err);	
				return This._serveNotFound(ctx, callback);
			}
			logger.debug("StaticController, stat", stat);	
			if (stat.isFile()) {
				return This._serve(ctx, finalPath, callback);
			}
			else if (stat.isDirectory()) {
				return This._resolveAndServe(ctx, path.join(finalPath, This._defaultPostfix), callback);
			}
			else {
				return This._serveNotFound(ctx, callback);
			}
			
		});
	});
};

StaticController.prototype.get = function(req, res, callback) {
	var This = this;
	var ctx = req.ctx();
	var logger = ctx.logger();

	logger.debug("StaticController", "wanted:", req.url, "mount:", This._dirVirtual);
	if (req.url.indexOf(This._dirVirtual) !== 0) {
		return This._serveNotFound(ctx, callback);
	}

	var finalPath = req.url.replace(This._dirVirtual, "");
	finalPath = finalPath.replace("/", path.sep);
	logger.debug("StaticController removed virtual mount point", finalPath);
	finalPath = path.normalize(path.join(This._dirReal, finalPath));
	logger.debug("StaticController, file rewrite", finalPath);
	if (finalPath.indexOf(This._dirReal) !== 0) {
		logger.warn("StaticController, file out of scope");
		return This._serveNotFound(ctx, callback);
	}
	if (finalPath === This._dirReal) {
		finalPath = path.normalize(path.join(finalPath, This._defaultPostfix));
	}
	
	return This._resolveAndServe(ctx, finalPath, callback);
};

exports.Controller = StaticController;