var AppController = function () {};

AppController.prototype.get = function (req, res, callback) {
	var ctx = req.ctx();

	var redirectUrl = '/#' + req.url;
	ctx.setModel({
		statusCode: 302,
		headers: {
			'Location': redirectUrl
		},
		body: "This is actually a client side link. You should be redirected to " + redirectUrl + " shortly."
	});

	return callback();
};

exports.Controller = AppController;