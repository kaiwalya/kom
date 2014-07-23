
exports.errorFromCode = function (code, message) {
	var err = {
		statusCode: code,
		body: message
	};

	return err;
};

exports.errorFromError = function (errObj) {
	return {
		statusCode: 500,
		body: errObj.name + ": " + errObj.message
	};
};
