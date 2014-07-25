var FaviconController = function () {};

FaviconController.prototype.get = function(req, res, callback) {
	var ctx = req.ctx();

	ctx.setModel({
		statusCode: 302,
		headers: {
			'Location': "http://gravatar.com/avatar/bbd496a3ef06322578111e5e848b5496"
		},
		body: {
			_links: {
				"shortcut icon": {
					href: "favicon.ico",
					type: "image/x-icon"
				}
			}
		}
	});

	return callback();
};

exports.Controller = FaviconController;