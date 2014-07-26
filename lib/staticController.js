var fs = require('fs');
var path = require('path');

var mime = require('mime');

var StaticController = function (dirReal, dirVirtual) {
	this._dirReal = path.normalize(dirReal);
	this._dirVirtual = path.normalize(dirVirtual);
};

StaticController.prototype.get = function(req, res, callback) {
	var This = this;
	var ctx = req.ctx();
	var logger = ctx.logger();

	var notfound = function () {
		ctx.setModel({statusCode: 200, body: "Cannot find resource"});
		return callback();
	};

	if (req.url.indexOf(This._dirVirtual) !== 0) {
		return notfound();
	}

	var finalPath = req.url.replace(This._dirVirtual, This._dirReal);
	var mimeType = mime.lookup(finalPath);
	logger.info("StaticController, file rewrite", finalPath, "type", mimeType);

	return fs.exists(finalPath, function (exists) {
		if (!exists) {
			return notfound();
		}
		ctx.setModel({
			statusCode: 200,
			body: fs.createReadStream(finalPath),
			headers: {
				"Content-Type": mimeType
			}
		});

		return callback();
	});
};

exports.Controller = StaticController;